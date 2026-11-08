import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { tempHome } from './helpers.mjs';
import { createClaudeLogin, isLoginFailure } from '../relay/claudelogin.mjs';

const home = tempHome();
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

// A fake process instead of the real claude: the test controls its exit and output.
function fakeSpawn() {
  const calls = [];
  const spawn = (command, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (signal) => {
      child.killedWith = signal;
    };
    calls.push({ command, args, opts, child });
    return child;
  };
  return { spawn, calls };
}

function make(over = {}) {
  const { spawn, calls } = fakeSpawn();
  const logins = [];
  const login = createClaudeLogin({ claudePath: '/bin/claude', env: { A: '1' }, cwd: '/ev', onLogin: () => logins.push(1), spawn, ...over });
  return { login, calls, logins };
}

// status() starts a process; this finishes it with the given output and exit code.
async function statusWith(login, calls, out, code) {
  const pending = login.status();
  const { child } = calls.at(-1);
  child.stdout.emit('data', out);
  child.emit('close', code);
  return pending;
}

test('the CLI\'s login errors are recognized and other errors are not', () => {
  for (const line of [
    'Failed to authenticate: OAuth session expired and could not be refreshed',
    'Failed to authenticate: OAuth token revoked. Please log in again',
    'Not logged in · Please run /login',
    'Invalid API key · Please run /login',
  ]) assert.equal(isLoginFailure(line), true, line);
  for (const line of ['API Error: 529 overloaded', 'Rate limit reached', '', null]) assert.equal(isLoginFailure(line), false, String(line));
});

test('only the end of the output is searched, so the same words in a post do not count', () => {
  assert.equal(isLoginFailure(`A post that says Failed to authenticate. ${'x'.repeat(600)} API Error: 500`), false);
});

test('status reads the auth status JSON; exit code 1 is a valid answer too', async () => {
  const { login, calls } = make();
  assert.deepEqual(await statusWith(login, calls, '{"loggedIn": false, "authMethod": "none"}', 1), { loggedIn: false, running: false });
  assert.deepEqual(calls[0].args, ['auth', 'status']);
  assert.equal(calls[0].opts.cwd, '/ev');
  assert.deepEqual(await statusWith(login, calls, '{"loggedIn": true}', 0), { loggedIn: true, running: false });
});

test('status: unreadable output or a start failure gives "unknown", not "logged out"', async () => {
  const { login, calls } = make();
  assert.equal((await statusWith(login, calls, 'unknown command', 1)).loggedIn, null);
  const pending = login.status();
  calls.at(-1).child.emit('error', new Error('ENOENT'));
  assert.equal((await pending).loggedIn, null);
});

test('start runs auth login with stdin closed; status starts no process until it ends', async () => {
  const { login, calls, logins } = make();
  login.start();
  assert.deepEqual(calls[0].args, ['auth', 'login']);
  assert.equal(calls[0].opts.stdio[0], 'ignore');
  assert.deepEqual(await login.status(), { loggedIn: false, running: true });
  assert.equal(calls.length, 1);

  calls[0].child.emit('close', 0);
  assert.equal(logins.length, 1, 'onLogin is called after a successful login');
  assert.deepEqual(await statusWith(login, calls, '{"loggedIn": true}', 0), { loggedIn: true, running: false });
});

test('a failed login does not call onLogin, and the sign-in link\'s query stays out of the log', async () => {
  const logFile = path.join(home, 'login.log');
  const { login, calls, logins } = make({ logFile });
  login.start();
  calls[0].child.stdout.emit('data', 'visit: https://claude.com/cai/oauth/authorize?state=SECRET&code_challenge=SECRET\n');
  calls[0].child.emit('close', 1);
  assert.equal(logins.length, 0);
  assert.equal((await statusWith(login, calls, '{"loggedIn": false}', 1)).running, false);
  const log = fs.readFileSync(logFile, 'utf8');
  assert.match(log, /login not completed: exit 1/);
  assert.doesNotMatch(log, /SECRET/);
});

test('a second start stops the first, and the first closing does not affect the second', async () => {
  const { login, calls, logins } = make();
  login.start();
  login.start();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].child.killedWith, 'SIGTERM');
  calls[0].child.emit('close', null);
  assert.equal((await login.status()).running, true, 'the new one is still running');
  assert.equal(logins.length, 0);
  calls[1].child.emit('close', 0);
  assert.equal(logins.length, 1);
});

test('the login process is killed when time runs out', async () => {
  const { login, calls } = make({ timeoutMs: 5 });
  login.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls[0].child.killedWith, 'SIGTERM');
  calls[0].child.emit('close', null);
});

test('a login that fails to start does not look like it is running', async () => {
  const { login, calls, logins } = make();
  login.start();
  calls[0].child.emit('error', new Error('ENOENT'));
  assert.equal(logins.length, 0);
  assert.equal((await statusWith(login, calls, '{"loggedIn": false}', 1)).running, false);
});
