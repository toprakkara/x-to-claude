import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWaker, wakePrompt } from '../relay/waker.mjs';

// Gerçek claude yerine sahte süreç: kaç kez başlatıldığını sayar, çıkışı testin kontrolündedir.
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
    cwd: '/arsiv',
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

test('bekleyen kayıt yoksa ya da arşivci açıksa uyandırmaz', async () => {
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

test('art arda istekler tek uyandırmaya iner; arşiv klasöründe doğru komutla başlar', async () => {
  const { waker, calls } = make();
  waker.request();
  waker.request();
  waker.request();
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/bin/claude');
  assert.equal(calls[0].opts.cwd, '/arsiv');
  assert.match(calls[0].args[1], /notu olmayan kayıtlar .*: 100\./);
  assert.equal(waker.running, true);
});

test('çalışırken gelen istek, iş bitince kuyrukta hâlâ kayıt varsa bir tur daha açar', async () => {
  const { waker, state, calls } = make();
  waker.request();
  await tick();
  waker.request(); // çalışırken
  calls[0].child.emit('close', 0);
  await tick();
  assert.equal(calls.length, 2, 'kuyrukta kayıt kaldığı için ikinci tur');

  state.pending = 0;
  waker.request();
  calls[1].child.emit('close', 0);
  await tick();
  assert.equal(calls.length, 2, 'kuyruk boşalınca yeni tur yok');
});

test('başarısız çalıştırmadan sonra bekleme süresi boyunca yeniden uyandırmaz', async () => {
  const { waker, calls } = make();
  waker.request();
  await tick();
  calls[0].child.emit('close', 1);
  waker.request();
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(waker.runs[0].ok, false);
});

test('spawn hatası tek kez sayılır', async () => {
  const { waker, calls } = make();
  waker.request();
  await tick();
  calls[0].child.emit('error', new Error('ENOENT'));
  calls[0].child.emit('close', -2);
  assert.equal(waker.runs.length, 1);
});
