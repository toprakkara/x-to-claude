import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { tempHome, sampleTweet } from './helpers.mjs';
import { createSessionOpener, sessionName, SessionOpenError } from '../relay/newsession.mjs';
import { validateTweet } from '../relay/format.mjs';

const home = tempHome();
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

// A fake claude: records each call and returns exit codes in order, optionally with stderr output ({ code, err }).
function fakeSpawn(codes) {
  const calls = [];
  const spawn = (command, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    calls.push({ command, args, opts });
    const next = codes.shift();
    const { code, err } = typeof next === 'object' ? next : { code: next };
    setImmediate(() => {
      if (err) child.stderr.emit('data', err);
      child.emit('close', code);
    });
    return child;
  };
  return { spawn, calls };
}

const post = validateTweet(sampleTweet);

test('first a turn with tools off, then opening the same ID in Desktop', async () => {
  const dir = path.join(home, 'x-chats');
  const { spawn, calls } = fakeSpawn([0, 0]);
  const opener = createSessionOpener({ dir, claudePath: '/bin/claude', env: {}, spawn, uuid: () => '11111111-2222-3333-4444-555555555555' });
  const r = await opener.open(post);
  assert.equal(r.id, '11111111-2222-3333-4444-555555555555');
  assert.ok(fs.existsSync(dir), 'the chat folder is created');
  assert.equal(calls.length, 2);

  const [first, second] = calls;
  assert.equal(first.opts.cwd, dir);
  assert.equal(first.args[0], '-p');
  assert.match(first.args[1], /^\[x-to-claude\] NEW SESSION:/);
  assert.match(first.args[1], /not instructions/);
  const at = (flag) => first.args[first.args.indexOf(flag) + 1];
  assert.equal(at('--session-id'), r.id);
  assert.equal(at('--tools'), '', 'all tools are off for the first turn');
  assert.ok(first.args.includes('--strict-mcp-config'));
  assert.equal(second.command, '/usr/bin/open');
  assert.deepEqual(second.args, [`claude://resume?session=${r.id}`]);
});

test('if the first turn fails, Desktop does not open and an error is raised', async () => {
  const { spawn, calls } = fakeSpawn([1]);
  const opener = createSessionOpener({ dir: path.join(home, 'x2'), claudePath: '/bin/claude', env: {}, spawn });
  await assert.rejects(opener.open(post), (e) => e instanceof SessionOpenError && e.code === undefined);
  assert.equal(calls.length, 1);
});

test('a first turn that fails on login gives an error with the claude-login code', async () => {
  const { spawn, calls } = fakeSpawn([{ code: 1, err: 'Failed to authenticate: OAuth session expired and could not be refreshed' }]);
  const opener = createSessionOpener({ dir: path.join(home, 'x3'), claudePath: '/bin/claude', env: {}, spawn });
  await assert.rejects(opener.open(post), (e) => e instanceof SessionOpenError && e.code === 'claude-login');
  assert.equal(calls.length, 1, 'Desktop does not open');
});

test('a missing claude gives a helpful error that does not reveal the local path', async () => {
  const claudePath = path.join(home, 'no-such-claude');
  const opener = createSessionOpener({ dir: path.join(home, 'x4'), claudePath, env: {} });
  await assert.rejects(opener.open(post), (e) => {
    assert.ok(e instanceof SessionOpenError);
    assert.match(e.message, /Claude Code wasn't found.*archivistWake\.claudePath/);
    assert.ok(!e.message.includes(home));
    assert.equal(e.code, undefined);
    return true;
  });
});

test('the session name is built from the author and the start of the text', () => {
  assert.match(sessionName(post), /^X: @someone — A thought on legal tech\./);
  assert.ok(sessionName({ ...post, text: 'a'.repeat(200) }).length <= 70);
});
