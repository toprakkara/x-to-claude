import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempHome } from './helpers.mjs';
import { defaultClaudePath } from '../relay/config.mjs';

const home = fs.realpathSync(tempHome());
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

// Creates <home>/<dir>/claude and returns its path.
function fakeClaude(dir, mode = 0o755) {
  const file = path.join(home, dir, 'claude');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\n');
  fs.chmodSync(file, mode);
  return file;
}
const missing = () => path.join(home, 'missing', 'claude');

test('a usual install location wins over PATH, because it survives updates', () => {
  const usual = fakeClaude('usual');
  const onPath = fakeClaude('on-path');
  assert.equal(defaultClaudePath({ PATH: path.dirname(onPath) }, [usual]), usual);
});

test('PATH finds an install outside the usual locations', () => {
  const onPath = fakeClaude('npm-global');
  assert.equal(defaultClaudePath({ PATH: ['/nowhere', path.dirname(onPath)].join(path.delimiter) }, [missing()]), onPath);
});

test('a file that is not executable, a directory or a relative PATH entry is skipped', () => {
  const plain = fakeClaude('not-executable', 0o644);
  fs.mkdirSync(path.join(home, 'has-dir', 'claude'), { recursive: true });
  const good = fakeClaude('good');
  const PATH = [path.dirname(plain), path.join(home, 'has-dir'), '.', path.dirname(good)].join(path.delimiter);
  assert.equal(defaultClaudePath({ PATH }, [missing()]), good);
});

test('with nothing found, it falls back to the first usual location', () => {
  assert.equal(defaultClaudePath({ PATH: '/nowhere' }, [missing()]), missing());
  assert.equal(defaultClaudePath({}, [missing()]), missing());
});
