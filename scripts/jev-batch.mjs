#!/usr/bin/env node
// Classifies a bulk import with Jev. Run from the archive folder:
//   node jev-batch.mjs inbox/<name>.jsonl --plan plan/<name>-jev.jsonl --handoff inbox/handoff-<name>.jsonl [--threshold 0.85]
// - A post whose content couldn't be fetched goes to "unavailable" by rule, without asking Jev.
// - If Jev picks an existing category above the threshold: a plan line and a note.
// - Everything else (low confidence, "new category needed", Jev errors) goes on the hand-off list for the archivist.
// IDs that already have a note are skipped. The key comes from the environment and is never printed or written to a file.
import fs from 'node:fs';
import path from 'node:path';
import { readCategories, loadContent, findNotes, renderEntries, UNAVAILABLE_CATEGORY } from './render-archive.mjs';
import { judgeTweet, NEW_CATEGORY } from '../relay/jev.mjs';
import { loadConfig } from '../relay/config.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const input = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
const planFile = opt('plan');
const handoffFile = opt('handoff');
if (!input || !planFile || !handoffFile) {
  console.error('Usage: node jev-batch.mjs inbox/<name>.jsonl --plan plan/<name>-jev.jsonl --handoff inbox/handoff-<name>.jsonl [--threshold 0.85]');
  process.exit(2);
}

const root = fs.realpathSync(process.cwd());
const cfg = loadConfig();
const threshold = Number(opt('threshold', cfg.jevThreshold ?? 0.85));
const routes = cfg.notifyRoutes ?? [];
const categories = readCategories(root);
const content = loadContent(root);
const existing = findNotes(root);
const ids = fs
  .readFileSync(path.resolve(root, input), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l).id)
  .filter((id) => !existing.has(id));

const plan = [];
const handoff = [];
const relevant = new Map(routes.map((r) => [r.name, 0]));
let next = 0;
let done = 0;

async function worker() {
  while (next < ids.length) {
    const id = ids[next++];
    const c = content.get(id);
    if (!c?.available) {
      plan.push({ id, category: UNAVAILABLE_CATEGORY, tags: [], summary: '', confidence: 'high', decision: 'rule' });
    } else {
      try {
        const v = await judgeTweet(c, categories, routes);
        for (const r of v.relevance) if (r.p != null && r.p >= (routes.find((x) => x.name === r.name)?.threshold ?? 0.7)) relevant.set(r.name, relevant.get(r.name) + 1);
        if (v.choice !== NEW_CATEGORY && categories.has(v.choice) && (v.confidence ?? 0) >= threshold) {
          plan.push({ id, category: v.choice, tags: [], summary: '', confidence: 'high', decision: 'jev', jevConfidence: v.confidence });
        } else {
          handoff.push({ id, jev: { choice: v.choice, confidence: v.confidence, top: v.top } });
        }
      } catch (e) {
        handoff.push({ id, jev: null, error: e.message.slice(0, 120) });
      }
    }
    if (++done % 50 === 0) console.log(`${done}/${ids.length}`);
  }
}
await Promise.all(Array.from({ length: Number(opt('concurrency', 4)) }, worker));

const order = new Map(ids.map((id, i) => [id, i]));
plan.sort((a, b) => order.get(a.id) - order.get(b.id));
handoff.sort((a, b) => order.get(a.id) - order.get(b.id));
fs.appendFileSync(path.resolve(root, planFile), plan.map((p) => JSON.stringify(p)).join('\n') + (plan.length ? '\n' : ''));
fs.writeFileSync(path.resolve(root, handoffFile), handoff.map((h) => JSON.stringify(h)).join('\n') + (handoff.length ? '\n' : ''));
const r = renderEntries(root, plan, { source: planFile });

const byCat = {};
for (const p of plan) byCat[p.category] = (byCat[p.category] ?? 0) + 1;
console.log(`Processed: ${ids.length} (skipped, already have notes: ${existing.size})`);
console.log(`Written directly: ${r.written} (Jev ${plan.filter((p) => p.decision === 'jev').length}, rule ${plan.filter((p) => p.decision === 'rule').length}), errors: ${r.errors.length}`);
console.log(`Handed to the archivist: ${handoff.length} (Jev errors: ${handoff.filter((h) => !h.jev).length}, new category suggested: ${handoff.filter((h) => h.jev?.choice === NEW_CATEGORY).length})`);
console.log(`Categories: ${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
for (const [name, n] of relevant) console.log(`Related to ${name} (Jev): ${n}`);
for (const e of r.errors) console.log(`ERROR ${e}`);
