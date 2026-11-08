#!/usr/bin/env node
// Writes library notes from the archivist's classification plan. Runs in the archive folder (cwd):
//   node render-archive.mjs plan/<name>.jsonl [plan/<name2>.jsonl ...]
// Plan line: {"id":"…","category":"slug","tags":["…"],"summary":"…","confidence":"high|low"}
// Content is looked up by ID in inbox/*.jsonl. Notes go to library/<category>/<date>-<handle>-<id>.md
// A note with the same ID elsewhere is moved (that's how a category changes). Every run rebuilds library/_index.md.
// The archivist session is allowed to run this script; the script never writes outside cwd.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Posts whose content couldn't be fetched go here.
export const UNAVAILABLE_CATEGORY = 'unavailable';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID = /^\d{1,25}$/;

const readJsonl = (f) =>
  fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new Error(`${f}:${i + 1} invalid JSON`);
      }
    });

function inside(root, p) {
  const r = path.resolve(root, p);
  if (r !== root && !r.startsWith(root + path.sep)) throw new Error(`outside the archive folder: ${p}`);
  return r;
}

// categories.md: "- slug — description" lines
export function readCategories(root) {
  const f = path.join(root, 'categories.md');
  if (!fs.existsSync(f)) return new Map();
  const map = new Map();
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/^- ([a-z0-9-]+)\s+[—-]\s+(.+)$/gm)) map.set(m[1], m[2].trim());
  return map;
}

// Converts the two source shapes (bulk import via oEmbed, and the button) into one.
export function normalize(rec) {
  const o = rec.oembed;
  if (o) {
    return {
      id: rec.id,
      url: rec.url,
      handle: rec.handle ?? o.author?.handle ?? null,
      name: o.author?.name ?? null,
      date: o.date ?? null,
      text: o.status === 200 ? o.text : null,
      links: o.links ?? [],
      media: [],
      hasMedia: !!o.hasMedia,
      quoted: null,
      truncated: false,
      source: rec.source ?? 'import',
      sharedBy: rec.sharedBy ?? null,
      sharedAt: rec.firstSharedAt ?? null,
      savedAt: rec.fetchedAt ?? null,
      available: o.status === 200,
    };
  }
  return {
    id: rec.id,
    url: rec.url,
    handle: rec.author?.handle ?? null,
    name: rec.author?.name ?? null,
    date: rec.time ? rec.time.slice(0, 10) : null,
    text: rec.text ?? '',
    links: rec.links ?? [],
    media: rec.media ?? [],
    hasMedia: (rec.media ?? []).length > 0,
    quoted: rec.quoted ?? null,
    truncated: !!rec.truncated,
    source: rec.source ?? 'button',
    sharedBy: null,
    sharedAt: null,
    savedAt: rec.savedAt ?? null,
    available: true,
  };
}

export function loadContent(root) {
  const dir = path.join(root, 'inbox');
  const byId = new Map();
  if (!fs.existsSync(dir)) return byId;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    for (const rec of readJsonl(path.join(dir, f))) if (rec?.id && ID.test(rec.id)) byId.set(rec.id, normalize(rec));
  }
  return byId;
}

export function findNotes(root) {
  const lib = path.join(root, 'library');
  const byId = new Map();
  if (!fs.existsSync(lib)) return byId;
  for (const cat of fs.readdirSync(lib, { withFileTypes: true })) {
    if (!cat.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(lib, cat.name))) {
      const m = /-(\d{1,25})\.md$/.exec(f);
      if (m) byId.set(m[1], path.join(lib, cat.name, f));
    }
  }
  return byId;
}

const y = (v) => JSON.stringify(v); // a JSON string is valid YAML
const quote = (t) => t.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');

export function renderNote(c, plan, now) {
  const fm = [
    '---',
    `id: ${y(c.id)}`,
    `url: ${c.url}`,
    `author: ${y(c.name ?? '')}`,
    `handle: ${y(c.handle ?? '')}`,
    `date: ${c.date ?? ''}`,
    `category: ${plan.category}`,
    `tags: ${y(plan.tags ?? [])}`,
    `summary: ${y(plan.summary ?? '')}`,
    `confidence: ${plan.confidence === 'low' ? 'low' : 'high'}`,
    `decision: ${['jev', 'rule'].includes(plan.decision) ? plan.decision : 'archivist'}`,
    ...(typeof plan.jevConfidence === 'number' ? [`jev_confidence: ${plan.jevConfidence.toFixed(2)}`] : []),
    `source: ${c.source}`,
    ...(c.sharedBy ? [`shared_by: ${y(c.sharedBy)}`, `shared_at: ${c.sharedAt ?? ''}`] : []),
    `saved_at: ${now}`,
    `media: ${c.hasMedia}`,
    '---',
    '',
  ];
  const body = [];
  if (!c.available) body.push('_Content unavailable: the post may have been deleted or the account may be private._');
  else {
    body.push(quote(c.text || '(no text)'));
    if (c.truncated) body.push('', '_The text was truncated in X\'s interface; the full text is at the link._');
  }
  if (c.quoted) {
    const qa = c.quoted.author ? `${c.quoted.author.name ?? ''} (@${c.quoted.author.handle ?? '?'})` : '';
    body.push('', `**Quoted post** ${qa}${c.quoted.url ? ` — ${c.quoted.url}` : ''}`, '', quote(c.quoted.text || '(no text)'));
  }
  if (c.links.length) body.push('', '**Links**', ...c.links.map((l) => `- ${l}`));
  if (c.media.length) body.push('', '**Media**', ...c.media.map((m) => `- ${m}`));
  body.push('', `[Open on X](${c.url})`, '');
  return fm.join('\n') + body.join('\n');
}

function writeIndex(root, categories) {
  const notes = findNotes(root);
  const counts = new Map();
  for (const p of notes.values()) {
    const cat = path.basename(path.dirname(p));
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  const lines = ['# Library index', '', `${notes.size} ${notes.size === 1 ? 'post' : 'posts'} in total. This file is regenerated on every run.`, '', '| Category | Posts | Description |', '|---|---|---|'];
  for (const [cat, n] of [...counts].sort((a, b) => b[1] - a[1])) lines.push(`| [${cat}](${cat}/) | ${n} | ${categories.get(cat) ?? '—'} |`);
  fs.writeFileSync(path.join(root, 'library', '_index.md'), lines.join('\n') + '\n');
}

// Turns plan entries (objects) into notes. The relay calls this directly; the CLI reads plan files and passes them here.
export function renderEntries(root, entries, { now = new Date().toISOString(), source = 'plan' } = {}) {
  const categories = readCategories(root);
  const content = loadContent(root);
  const existing = findNotes(root);
  const result = { written: 0, moved: 0, errors: [], notes: [] };

  for (const plan of entries) {
    const where = `${source} id=${plan?.id}`;
    if (!ID.test(plan?.id ?? '')) { result.errors.push(`${where}: invalid id`); continue; }
    if (!SLUG.test(plan.category ?? '')) { result.errors.push(`${where}: category must be a slug (lower case, digits, hyphens)`); continue; }
    if (!categories.has(plan.category)) { result.errors.push(`${where}: "${plan.category}" is not in categories.md; add it first`); continue; }
    if (plan.tags && (!Array.isArray(plan.tags) || !plan.tags.every((t) => SLUG.test(t)))) { result.errors.push(`${where}: tags must be an array of slugs`); continue; }
    const c = content.get(plan.id);
    if (!c) { result.errors.push(`${where}: this ID is not in inbox/*.jsonl`); continue; }

    const handle = (c.handle ?? 'unknown').toLowerCase().replace(/[^a-z0-9_]/g, '');
    const target = path.join(root, 'library', plan.category, `${c.date ?? 'undated'}-${handle}-${c.id}.md`);
    const old = existing.get(plan.id);
    if (old && old !== target) {
      fs.rmSync(old, { force: true });
      result.moved++;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, renderNote(c, plan, now));
    existing.set(plan.id, target);
    result.written++;
    result.notes.push(path.relative(root, target));
  }
  fs.mkdirSync(path.join(root, 'library'), { recursive: true });
  writeIndex(root, categories);
  return result;
}

export function render(root, planFiles, opts = {}) {
  const total = { written: 0, moved: 0, errors: [] };
  for (const pf of planFiles) {
    const r = renderEntries(root, readJsonl(inside(root, pf)), { ...opts, source: pf });
    total.written += r.written;
    total.moved += r.moved;
    total.errors.push(...r.errors);
  }
  return total;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const plans = process.argv.slice(2);
  if (!plans.length) {
    console.error('Usage: node render-archive.mjs plan/<name>.jsonl [...]  (run from the archive folder)');
    process.exit(2);
  }
  try {
    const r = render(fs.realpathSync(process.cwd()), plans);
    console.log(`Written: ${r.written}, moved: ${r.moved}, errors: ${r.errors.length}`);
    for (const e of r.errors) console.log(`ERROR ${e}`);
    process.exit(r.errors.length ? 1 : 0);
  } catch (e) {
    console.error(`ERROR ${e.message}`);
    process.exit(1);
  }
}
