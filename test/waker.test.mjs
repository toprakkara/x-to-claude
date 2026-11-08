import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWaker, wakePrompt } from '../relay/waker.mjs';

// A fake process instead of the real claude: counts how often it starts, and the test controls its exit.
function fakeSpawn() {
  const calls = [];
  const spawn = (command, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit('close', null);
    calls.push({ command, args, opts, child });
    return child;
  };
  return { spawn, calls };
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function make(over = {}) {
  const state = { pending: 1, alive: false };
  const fs = fakeSpawn();
  const waker = createWaker({
    cwd: '/archive',
    command: '/bin/claude',
    args: (ids) => ['-p', wakePrompt(ids)],
    env: {},
    pendingIds: () => Array.from({ length: state.pending }, (_, i) => String(100 + i)),
    isArchivistAlive: () => state.alive,
    debounceMs: 5,
    retryMs: 60_000,
    spawn: fs.spawn,
    ...over,
  });
  return { waker, state, calls: fs.calls };
}

test('an untrusted folder stops wake-ups for good, even though the run exits 0', async () => {
  let clock = 1_000;
  const { waker, calls } = make({ now: () => clock });
  waker.request();
  await tick();
  calls[0].child.stderr.emit('data', 'Ignoring 9 permissions.allow entries from .claude/settings.json: this workspace has not been trusted.');
  calls[0].child.emit('close', 0);
  assert.equal(waker.runs[0].ok, false);

  clock += 24 * 3_600_000; // far beyond retryMs
  waker.request();
  await tick();
  assert.equal(calls.length, 1, 'no more paid runs that cannot write anything');

  waker.retryNow('login renewed');
  await tick();
  assert.equal(calls.length, 2, 'an explicit retry still works');
});

test('retryNow retries without waiting out the failure block', async () => {
  const { waker, calls } = make();
  waker.request();
  await tick();
  calls[0].child.emit('close', 1);

  waker.request();
  await tick();
  assert.equal(calls.length, 1, 'no wake-up during the block');

  waker.retryNow('login renewed');
  await tick();
  assert.equal(calls.length, 2);
});

test('no wake-up if nothing is pending or the archivist is open', async () => {
  const a = make();
  a.state.pending = 0;
  a.waker.request();
  await tick();
  assert.equal(a.calls.length, 0);

  const b = make();
  b.state.alive = true;
  b.waker.request();
  await tick();
  assert.equal(b.calls.length, 0);
});

test('rapid requests collapse into one wake-up, started with the right command in the archive folder', async () => {
  const { waker, calls } = make();
  waker.request();
  waker.request();
  waker.request();
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/bin/claude');
  assert.equal(calls[0].opts.cwd, '/archive');
  assert.match(calls[0].args[1], /no library note yet .*: 100\./);
  assert.equal(waker.running, true);
});

test('a request during a run triggers one more run if the queue still has posts', async () => {
  const { waker, state, calls } = make();
  waker.request();
  await tick();
  waker.request(); // during the run
  calls[0].child.emit('close', 0);
  await tick();
  assert.equal(calls.length, 2, 'a second run, because posts remain in the queue');

  state.pending = 0;
  waker.request();
  calls[1].child.emit('close', 0);
  await tick();
  assert.equal(calls.length, 2, 'no new run once the queue is empty');
});

test('no new wake-up during the block after a failed run', async () => {
  const { waker, calls } = make();
  waker.request();
  await tick();
  calls[0].child.emit('close', 1);
  waker.request();
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(waker.runs[0].ok, false);
});

test('a spawn error counts once', async () => {
  const { waker, calls } = make();
  waker.request();
  await tick();
  calls[0].child.emit('error', new Error('ENOENT'));
  calls[0].child.emit('close', -2);
  assert.equal(waker.runs.length, 1);
});
