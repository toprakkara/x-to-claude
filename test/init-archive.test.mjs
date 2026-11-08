import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempHome } from './helpers.mjs';

const home = tempHome();
process.env.X2C_HOME = home;
const { initArchive } = await import('../scripts/init-archive.mjs');
const { readCategories } = await import('../scripts/render-archive.mjs');

const dir = path.join(home, 'archive');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('creates the archive from the templates, with the note writer\'s path filled in', () => {
  const created = initArchive(dir);
  assert.deepEqual(created.sort(), ['.claude/settings.json', 'CLAUDE.md', 'categories.md', 'log.md']);
  for (const sub of ['inbox', 'library', 'plan']) assert.ok(fs.statSync(path.join(dir, sub)).isDirectory());

  const instructions = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.doesNotMatch(instructions, /\{\{/);
  assert.match(instructions, /node \/.*scripts\/render-archive\.mjs plan\//);

  const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.permissions.defaultMode, 'dontAsk');
  assert.ok(settings.permissions.allow.some((r) => /^Bash\(node \/.*render-archive\.mjs \*\)$/.test(r)));
  assert.ok(settings.permissions.deny.includes('Edit(/inbox/**)'));
});

test('the starter categories are readable and include "unavailable"', () => {
  const categories = readCategories(dir);
  assert.ok(categories.size >= 3);
  assert.ok(categories.has('unavailable'));
});

test('running again overwrites nothing', () => {
  fs.writeFileSync(path.join(dir, 'categories.md'), '- mine — My own category\n');
  assert.deepEqual(initArchive(dir), []);
  assert.equal(fs.readFileSync(path.join(dir, 'categories.md'), 'utf8'), '- mine — My own category\n');
});
