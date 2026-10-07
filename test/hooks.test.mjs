import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempHome } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = tempHome();
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

// Hook'ları gerçek bir oturumun ortamı olmadan, sahte değişkenlerle çalıştırır.
function runHook(script, input, env = {}) {
  const r = spawnSync(process.execPath, [path.join(root, 'hooks', script)], {
    input: JSON.stringify(input),
    env: { PATH: process.env.PATH, X2C_HOME: home, ...env },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

const sessionFiles = () => fs.readdirSync(path.join(home, 'sessions')).sort();
const fakeEnv = { CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/12345.sock', CLAUDE_CODE_ENTRYPOINT: 'cli' };

test('SessionStart kaydı yazar; ad yoksa klasör adını kullanır', () => {
  runHook('register.mjs', { session_id: 'aaa-1', cwd: '/Users/u/method_path', source: 'startup' }, fakeEnv);
  const rec = JSON.parse(fs.readFileSync(path.join(home, 'sessions', 'aaa-1.json'), 'utf8'));
  assert.equal(rec.socket, '/tmp/cc-socks/12345.sock');
  assert.equal(rec.pid, 12345);
  assert.equal(rec.name, 'method_path');
  assert.equal(rec.entrypoint, 'cli');
  assert.ok(!('token' in rec));
});

test('aynı soketle yeni oturum (/clear) eski kaydın yerini alır', () => {
  runHook('register.mjs', { session_id: 'aaa-2', cwd: '/Users/u/method_path', source: 'clear', session_title: 'Araştırma' }, fakeEnv);
  assert.deepEqual(sessionFiles(), ['aaa-2.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'sessions', 'aaa-2.json'), 'utf8')).name, 'Araştırma');
});

test('soket değişkeni yoksa hiçbir şey yazılmaz ve hook başarıyla çıkar', () => {
  runHook('register.mjs', { session_id: 'bbb-1', cwd: '/x' });
  assert.deepEqual(sessionFiles(), ['aaa-2.json']);
});

test('geçersiz session_id ile dosya yolu oluşturulmaz', () => {
  runHook('register.mjs', { session_id: '../../evil', cwd: '/x' }, fakeEnv);
  runHook('unregister.mjs', { session_id: '../config' });
  assert.deepEqual(sessionFiles(), ['aaa-2.json']);
});

test('bozuk girdi hook\'u çökertmez', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'hooks', 'register.mjs')], {
    input: 'json değil',
    env: { PATH: process.env.PATH, X2C_HOME: home, ...fakeEnv },
  });
  assert.equal(r.status, 0);
});

test('SessionEnd kaydı siler', () => {
  runHook('unregister.mjs', { session_id: 'aaa-2', reason: 'prompt_input_exit' });
  assert.deepEqual(sessionFiles(), []);
});

test('install-hooks: diğer hook\'ları korur, tekrar çalışınca çoğaltmaz, kaldırınca temizler', () => {
  const settings = path.join(home, 'settings.json');
  const other = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo baska' }] }] }, model: 'opus' };
  fs.writeFileSync(settings, JSON.stringify(other));
  const run = (...a) => spawnSync(process.execPath, [path.join(root, 'scripts', 'install-hooks.mjs'), ...a], { env: { ...process.env, CLAUDE_SETTINGS_PATH: settings }, encoding: 'utf8' });

  run();
  run();
  const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(s.model, 'opus');
  assert.equal(s.hooks.SessionStart.length, 2);
  assert.equal(s.hooks.SessionEnd.length, 1);
  assert.match(s.hooks.SessionStart[1].hooks[0].command, /register\.mjs" # x-to-claude$/);

  run('--uninstall');
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), other);
  assert.ok(fs.readdirSync(home).some((f) => f.startsWith('settings.json.bak-x-to-claude-')));
});
