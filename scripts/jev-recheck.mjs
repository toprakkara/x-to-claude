#!/usr/bin/env node
// Kütüphanede hâlâ "karar: jev" olan notları güncel kategori listesiyle jev'e yeniden sorar. Arşiv klasöründen:
//   node jev-recheck.mjs --plan plan/<ad>.jsonl --devret gelen/devret-<ad>.jsonl [--esik 0.85]
// - jev aynı kategoriyi seçerse: dokunulmaz.
// - Farklı mevcut kategoriyi eşik üstü güvenle seçerse: plan satırı yazılır, not taşınır (karar: jev).
// - Farklı ama emin değilse ya da "yeni kategori gerekli" derse: devir listesine (arşivci karar verir).
// Arşivcinin (karar: arsivci) ya da kuralın (karar: kural) yazdığı notlara dokunulmaz.
import fs from 'node:fs';
import path from 'node:path';
import { readCategories, loadContent, findNotes, renderEntries } from './render-archive.mjs';
import { judgeTweet, NEW_CATEGORY } from '../relay/jev.mjs';
import { loadConfig } from '../relay/config.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const planFile = opt('plan');
const handoffFile = opt('devret');
if (!planFile || !handoffFile) {
  console.error('Kullanım: node jev-recheck.mjs --plan plan/<ad>.jsonl --devret gelen/devret-<ad>.jsonl [--esik 0.85]');
  process.exit(2);
}

const root = fs.realpathSync(process.cwd());
const threshold = Number(opt('esik', loadConfig().jevThreshold ?? 0.85));
const categories = readCategories(root);
const content = loadContent(root);

// Notun ön bilgisinden karar ve kategori.
const jevNotes = [];
for (const [id, file] of findNotes(root)) {
  const fm = fs.readFileSync(file, 'utf8').split('\n---\n')[0];
  if (!/^karar: jev$/m.test(fm)) continue;
  jevNotes.push({ id, current: /^kategori: (.+)$/m.exec(fm)?.[1] });
}

const plan = [];
const handoff = [];
let same = 0;
let next = 0;
async function worker() {
  while (next < jevNotes.length) {
    const n = jevNotes[next++];
    const c = content.get(n.id);
    if (!c?.available) continue;
    try {
      const v = await judgeTweet(c, categories, []);
      if (v.choice === n.current) same++;
      else if (v.choice !== NEW_CATEGORY && categories.has(v.choice) && (v.confidence ?? 0) >= threshold) {
        plan.push({ id: n.id, kategori: v.choice, etiketler: [], ozet: '', guven: 'yuksek', karar: 'jev', jevGuven: v.confidence, onceki: n.current });
      } else {
        handoff.push({ id: n.id, mevcut: n.current, jev: { choice: v.choice, confidence: v.confidence, top: v.top } });
      }
    } catch (e) {
      handoff.push({ id: n.id, mevcut: n.current, jev: null, hata: e.message.slice(0, 120) });
    }
  }
}
await Promise.all(Array.from({ length: Number(opt('concurrency', 6)) }, worker));

if (plan.length) fs.appendFileSync(path.resolve(root, planFile), plan.map((p) => JSON.stringify(p)).join('\n') + '\n');
fs.writeFileSync(path.resolve(root, handoffFile), handoff.map((h) => JSON.stringify(h)).join('\n') + (handoff.length ? '\n' : ''));
const r = renderEntries(root, plan, { source: planFile });

const moves = {};
for (const p of plan) moves[`${p.onceki} → ${p.kategori}`] = (moves[`${p.onceki} → ${p.kategori}`] ?? 0) + 1;
console.log(`jev notu: ${jevNotes.length}   aynı kaldı: ${same}   taşındı: ${r.tasinan}   arşivciye: ${handoff.length}   hata: ${r.hatalar.length}`);
for (const [k, n] of Object.entries(moves).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
for (const h of r.hatalar) console.log(`HATA ${h}`);
