import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempHome } from './helpers.mjs';
import { render, findNotes } from '../scripts/render-archive.mjs';

const root = fs.realpathSync(tempHome());
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const write = (rel, body) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
};
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

write('categories.md', '# Categories\n\n- legal-tech — Legal and AI tools\n- agent-tools — Coding agents\n- unavailable — Posts whose content could not be fetched\n');
write('inbox/bulk-import.jsonl', jsonl([
  { id: '111', url: 'https://x.com/i/status/111', handle: null, firstSharedAt: '2026-03-07T23:47:00+03:00', sharedBy: ['me'], shareCount: 1, source: 'bulk-import', oembed: { status: 200, author: { name: 'Sam', handle: 'SamDev' }, text: 'A court ruling\n\nsecond paragraph', date: '2026-01-12', links: ['https://t.co/x'], hasMedia: true } },
  { id: '222', url: 'https://x.com/i/status/222', handle: null, sharedBy: ['friend'], source: 'bulk-import', oembed: { status: 404 } },
]));
write('inbox/queue.jsonl', jsonl([
  { id: '333', url: 'https://x.com/a/status/333', author: { name: 'A', handle: 'a' }, time: '2026-10-05T09:00:00.000Z', text: 'Agent', quoted: { author: { name: 'Q', handle: 'q' }, text: 'quote' }, media: ['https://pbs.twimg.com/m.jpg'], links: [], source: 'button', savedAt: '2026-10-05T10:00:00Z' },
]));

test('a plan writes notes: both source shapes, front matter, quotes and unavailable content', () => {
  write('plan/1.jsonl', jsonl([
    { id: '111', category: 'legal-tech', tags: ['courts'], summary: 'Case search', confidence: 'high' },
    { id: '222', category: 'unavailable' },
    { id: '333', category: 'agent-tools', tags: ['claude'], summary: 'Agent' },
  ]));
  const r = render(root, ['plan/1.jsonl'], { now: '2026-10-05T12:00:00Z' });
  assert.deepEqual(r, { written: 3, moved: 0, errors: [] });

  const n1 = fs.readFileSync(path.join(root, 'library/legal-tech/2026-01-12-samdev-111.md'), 'utf8');
  assert.match(n1, /^---\nid: "111"\n/);
  assert.match(n1, /handle: "SamDev"/);
  assert.match(n1, /shared_by: \["me"\]/);
  assert.match(n1, /> A court ruling\n>\n> second paragraph/);
  assert.match(n1, /media: true/);

  const n2 = fs.readFileSync(path.join(root, 'library/unavailable/undated-unknown-222.md'), 'utf8');
  assert.match(n2, /Content unavailable/);

  const n3 = fs.readFileSync(path.join(root, 'library/agent-tools/2026-10-05-a-333.md'), 'utf8');
  assert.match(n3, /\*\*Quoted post\*\* Q \(@q\)/);
  assert.match(n3, /- https:\/\/pbs\.twimg\.com\/m\.jpg/);

  const idx = fs.readFileSync(path.join(root, 'library/_index.md'), 'utf8');
  assert.match(idx, /3 posts in total/);
  assert.match(idx, /\| \[legal-tech\]\(legal-tech\/\) \| 1 \| Legal and AI tools \|/);
});

test('a category change moves the note and leaves no copy', () => {
  write('plan/2.jsonl', jsonl([{ id: '111', category: 'agent-tools', tags: [], summary: 'x' }]));
  const r = render(root, ['plan/2.jsonl']);
  assert.equal(r.moved, 1);
  assert.equal(findNotes(root).get('111'), path.join(root, 'library/agent-tools/2026-01-12-samdev-111.md'));
  assert.ok(!fs.existsSync(path.join(root, 'library/legal-tech/2026-01-12-samdev-111.md')));
});

test('an unknown category, an unknown ID and a bad slug give errors and write nothing', () => {
  write('plan/3.jsonl', jsonl([
    { id: '333', category: 'new-category' },
    { id: '999', category: 'agent-tools' },
    { id: '333', category: 'Upper Case' },
    { id: '333', category: 'agent-tools', tags: ['../bad'] },
  ]));
  const r = render(root, ['plan/3.jsonl']);
  assert.equal(r.written, 0);
  assert.equal(r.errors.length, 4);
  assert.match(r.errors[0], /is not in categories\.md/);
});

test('a plan file cannot be outside the archive folder', () => {
  assert.throws(() => render(root, ['../outside.jsonl']), /outside the archive folder/);
});
