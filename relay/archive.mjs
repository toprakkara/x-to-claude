// The archive side: the save queue (inbox/queue.jsonl), lookups of saved posts, and finding the archivist session.
// The queue exists so a save isn't lost while the archivist is closed; when it opens, it processes lines without notes.
import fs from 'node:fs';
import path from 'node:path';
import { statusId } from './format.mjs';
import { readCategories, renderEntries, normalize } from '../scripts/render-archive.mjs';

const CACHE_MS = 3_000;

export function createArchive({ dir, archivistName }) {
  const queueFile = path.join(dir, 'inbox', 'queue.jsonl');
  let cache = null;

  function scan() {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.ids;
    const ids = new Set();
    const lib = path.join(dir, 'library');
    try {
      for (const cat of fs.readdirSync(lib, { withFileTypes: true })) {
        if (!cat.isDirectory()) continue;
        for (const f of fs.readdirSync(path.join(lib, cat.name))) {
          const m = /-(\d{1,25})\.md$/.exec(f);
          if (m) ids.add(m[1]);
        }
      }
    } catch {}
    try {
      for (const line of fs.readFileSync(queueFile, 'utf8').split('\n')) {
        const id = /"id":"(\d{1,25})"/.exec(line)?.[1];
        if (id) ids.add(id);
      }
    } catch {}
    cache = { at: Date.now(), ids };
    return ids;
  }

  return {
    dir,

    // The archive counts as set up once it has a category list (`npm run archive:init` creates one).
    isReady() {
      return fs.existsSync(path.join(dir, 'categories.md'));
    },

    // IDs in the queue with no note in the library, i.e. waiting for the archivist. Not cached.
    pendingIds() {
      const notes = new Set();
      try {
        for (const cat of fs.readdirSync(path.join(dir, 'library'), { withFileTypes: true })) {
          if (!cat.isDirectory()) continue;
          for (const f of fs.readdirSync(path.join(dir, 'library', cat.name))) {
            const m = /-(\d{1,25})\.md$/.exec(f);
            if (m) notes.add(m[1]);
          }
        }
      } catch {}
      const pending = new Set();
      try {
        for (const line of fs.readFileSync(queueFile, 'utf8').split('\n')) {
          const id = /"id":"(\d{1,25})"/.exec(line)?.[1];
          if (id && !notes.has(id)) pending.add(id);
        }
      } catch {}
      return [...pending];
    },

    savedIds(ids) {
      const all = scan();
      return ids.filter((id) => all.has(id));
    },

    // Adds to the queue, unless the post is already in the archive or the queue.
    enqueue(post, { now = new Date() } = {}) {
      const id = statusId(post.url);
      if (scan().has(id)) return { id, already: true };
      fs.mkdirSync(path.dirname(queueFile), { recursive: true });
      const rec = { id, ...post, source: 'button', savedAt: now.toISOString() };
      fs.appendFileSync(queueFile, JSON.stringify(rec) + '\n', { mode: 0o600 });
      cache?.ids.add(id);
      return { id, already: false };
    },

    categories() {
      return readCategories(dir);
    },

    // The content given to Jev, in the same shape as a queue line.
    contentOf(post) {
      return normalize({ id: statusId(post.url), ...post, source: 'button' });
    },

    // Writes Jev's high-confidence decision as a note and leaves a trace in plan/jev-<date>.jsonl.
    writeJevNote(id, verdict, { now = new Date() } = {}) {
      const entry = { id, category: verdict.choice, tags: [], summary: '', confidence: 'high', decision: 'jev', jevConfidence: verdict.confidence };
      const planDir = path.join(dir, 'plan');
      fs.mkdirSync(planDir, { recursive: true });
      fs.appendFileSync(path.join(planDir, `jev-${now.toISOString().slice(0, 10)}.jsonl`), JSON.stringify(entry) + '\n');
      const r = renderEntries(dir, [entry], { now: now.toISOString(), source: 'relay' });
      cache = null;
      if (r.errors.length) throw new Error(r.errors.join('; '));
      return r.notes[0];
    },

    logNotification(rec) {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'notifications.jsonl'), JSON.stringify(rec) + '\n');
    },

    // The archivist is the live session whose working directory is the archive folder. A name alone can't be trusted:
    // a session with the same name opened elsewhere (say, after a failed cd) would take saves to the wrong place.
    // If several sessions share the folder, the one named archivistName is preferred.
    findArchivist(sessions) {
      let real = dir;
      try {
        real = fs.realpathSync(dir);
      } catch {}
      const here = sessions.filter((s) => s.cwd === dir || s.cwd === real);
      return here.find((s) => s.name === archivistName) ?? here[0] ?? null;
    },
  };
}
