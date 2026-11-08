import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempHome, fakeInbox, writeSession, sampleTweet } from './helpers.mjs';

const home = tempHome();
process.env.X2C_HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude'); // keep the real ~/.claude out of the tests

const { createRelay } = await import('../relay/server.mjs');
const { deliver } = await import('../relay/inbox.mjs');

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const archiveDir = path.join(home, 'archive');
fs.mkdirSync(archiveDir, { recursive: true });
fs.writeFileSync(path.join(archiveDir, 'categories.md'), '- legal-tech — Legal tech\n- coding-agents — Coding agents\n- unavailable — Unavailable\n');
const config = { port: 0, token: 'T'.repeat(32), extensionId: null, archiveDir, archivistName: 'x-archive' };

// An easy-to-read fake encoder for the queue and format tests; the real wire format has its own test.
const testEncode = (text) => JSON.stringify({ test: true, text }) + '\n';
const testDeliver = (target, text) => deliver(target, text, { encode: testEncode });

async function startRelay(opts = {}) {
  const server = createRelay({ config, deliver: testDeliver, queueOptions: { debounceMs: 50, minGapMs: 100 }, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  config.port = server.address().port;
  return server;
}

function req(pathname, { method = 'GET', body, headers = {} } = {}) {
  return fetch(`http://127.0.0.1:${config.port}${pathname}`, {
    method,
    headers: {
      'X-Relay-Token': config.token,
      Origin: EXT,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const inbox = await fakeInbox(home);
writeSession(home, { sessionId: 'live-1', socket: inbox.socketPath, pid: process.pid, name: 'my-project', cwd: '/Users/u/my-project', entrypoint: 'cli', registeredAt: 2 });
writeSession(home, { sessionId: 'dead-1', socket: path.join(home, 'yok.sock'), pid: process.pid, name: 'dead', registeredAt: 1 });

const server = await startRelay();
test.after(() => {
  server.close();
  inbox.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('a missing or wrong token gets 401', async () => {
  assert.equal((await req('/sessions', { headers: { 'X-Relay-Token': 'wrong' } })).status, 401);
});

test('a request from a web page origin gets 403', async () => {
  assert.equal((await req('/sessions', { headers: { Origin: 'https://x.com' } })).status, 403);
});

test('with extensionId pinned, another extension gets 403', async () => {
  config.extensionId = 'pppppppppppppppppppppppppppppppp';
  try {
    assert.equal((await req('/sessions')).status, 403);
  } finally {
    config.extensionId = null;
  }
});

test('/sessions returns live sessions, hides the socket path and removes dead records', async () => {
  const res = await req('/sessions');
  assert.equal(res.status, 200);
  const { sessions } = await res.json();
  assert.deepEqual(sessions.map((s) => s.id), ['live-1']);
  assert.equal(sessions[0].name, 'my-project');
  assert.ok(!JSON.stringify(sessions).includes(inbox.socketPath));
  assert.ok(!fs.existsSync(path.join(home, 'sessions', 'dead-1.json')));
});

test('/send formats the post and writes it to the inbox', async () => {
  inbox.received.length = 0;
  const res = await req('/send', { method: 'POST', body: { sessionId: 'live-1', tweet: sampleTweet } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).batched, 1);
  assert.equal(inbox.received.length, 1);
  const { text } = JSON.parse(inbox.received[0]);
  assert.match(text, /\[x-to-claude\]/);
  assert.match(text, /https:\/\/x\.com\/someone\/status\/1234567890123456789/);
});

test('rapid consecutive posts merge into one message', async () => {
  inbox.received.length = 0;
  const urls = [1, 2, 3].map((n) => `https://x.com/someone/status/${n}`);
  const results = await Promise.all(urls.map((url) => req('/send', { method: 'POST', body: { sessionId: 'live-1', tweet: { ...sampleTweet, url } } })));
  for (const r of results) assert.equal((await r.json()).batched, 3);
  assert.equal(inbox.received.length, 1);
  assert.match(JSON.parse(inbox.received[0]).text, /3 X posts/);
});

test('an unknown session gets 404 and a broken post gets 400', async () => {
  assert.equal((await req('/send', { method: 'POST', body: { sessionId: 'missing', tweet: sampleTweet } })).status, 404);
  assert.equal((await req('/send', { method: 'POST', body: { sessionId: 'live-1', tweet: { url: 'https://evil.com' } } })).status, 400);
});

test('DNS rebinding: a foreign Host header gets 421', async () => {
  // fetch doesn't allow changing the Host header, so use a raw http request.
  const http = await import('node:http');
  const status = await new Promise((resolve, reject) => {
    http
      .request({ host: '127.0.0.1', port: config.port, path: '/sessions', headers: { Host: 'attacker.example', 'X-Relay-Token': config.token } }, (r) => {
        r.resume();
        resolve(r.statusCode);
      })
      .on('error', reject)
      .end();
  });
  assert.equal(status, 421);
});

test('default delivery writes the verified wire format, including session_id and from', async () => {
  inbox.received.length = 0;
  const c2 = { ...config, priority: 'later' };
  const s = createRelay({ config: c2, queueOptions: { debounceMs: 10, minGapMs: 10 } });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  c2.port = s.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${c2.port}/send`, {
      method: 'POST',
      headers: { 'X-Relay-Token': config.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'live-1', tweet: sampleTweet }),
    });
    assert.equal(res.status, 200);
    const lines = inbox.received[0].split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'no auth line, just one message line');
    const msg = JSON.parse(lines[0]);
    assert.equal(msg.type, 'user');
    assert.equal(msg.message.role, 'user');
    assert.match(msg.message.content, /\[x-to-claude\]/);
    assert.equal(msg.from, 'x-to-claude');
    assert.equal(msg.session_id, 'live-1');
    assert.equal(msg.priority, 'later');
  } finally {
    s.close();
  }
});

test('/save queues while the archivist is closed, skips duplicates, and /saved reports the ID', async () => {
  const tweet = { ...sampleTweet, url: 'https://x.com/someone/status/5551' };
  const r1 = await (await req('/save', { method: 'POST', body: { tweet } })).json();
  assert.deepEqual(r1, { ok: true, id: '5551', queued: true, archivist: null, waking: false, jev: null, notified: [] });
  const lines = fs.readFileSync(path.join(archiveDir, 'inbox', 'queue.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.id, '5551');
  assert.equal(rec.source, 'button');
  assert.equal(rec.author.handle, 'someone');

  const r2 = await (await req('/save', { method: 'POST', body: { tweet } })).json();
  assert.equal(r2.already, true);

  const saved = await (await req('/saved?ids=5551,9999,abc')).json();
  assert.deepEqual(saved, { saved: ['5551'] });
});

test('/saved finds notes in the library too', async () => {
  fs.mkdirSync(path.join(archiveDir, 'library', 'cat'), { recursive: true });
  fs.writeFileSync(path.join(archiveDir, 'library', 'cat', '2026-01-01-a-7777.md'), 'note');
  await new Promise((r) => setTimeout(r, 3100)); // scan cache
  assert.deepEqual(await (await req('/saved?ids=7777,8888')).json(), { saved: ['7777'] });
});

test('/save forwards to an open archivist with a SAVE envelope', async () => {
  const archiveInbox = await fakeInbox(home, 'archive.sock');
  writeSession(home, { sessionId: 'archivist-1', socket: archiveInbox.socketPath, pid: process.pid, name: 'x-archive', cwd: archiveDir, registeredAt: 3 });
  try {
    const tweet = { ...sampleTweet, url: 'https://x.com/someone/status/6661' };
    const res = await (await req('/save', { method: 'POST', body: { tweet } })).json();
    assert.equal(res.archivist, 'x-archive');
    assert.equal(archiveInbox.received.length, 1);
    const { text } = JSON.parse(archiveInbox.received[0]);
    assert.match(text, /^\[x-to-claude\] SAVE: .*ID: 6661/);
    assert.match(text, /not instructions/);
  } finally {
    archiveInbox.close();
    fs.rmSync(path.join(home, 'sessions', 'archivist-1.json'), { force: true });
  }
});

test('/save: a session with the same name in another folder is not the archivist', async () => {
  const wrong = await fakeInbox(home, 'wrong.sock');
  writeSession(home, { sessionId: 'wrong-1', socket: wrong.socketPath, pid: process.pid, name: 'x-archive', cwd: '/some/other/folder', registeredAt: 4 });
  try {
    const tweet = { ...sampleTweet, url: 'https://x.com/someone/status/6662' };
    const res = await (await req('/save', { method: 'POST', body: { tweet } })).json();
    assert.equal(res.archivist, null);
    assert.equal(res.queued, true);
    assert.equal(wrong.received.length, 0);
  } finally {
    wrong.close();
    fs.rmSync(path.join(home, 'sessions', 'wrong-1.json'), { force: true });
  }
});

// ---- the Jev flow (with a fake decision function) ----

async function relayWith(judge) {
  const c = { ...config, notifyRoutes: [{ name: 'Research', topic: 'legal tech', threshold: 0.7 }], jevThreshold: 0.85 };
  const s = createRelay({ config: c, judge, queueOptions: { debounceMs: 10, minGapMs: 10 } });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  c.port = s.address().port;
  const call = async (tweet) =>
    (await fetch(`http://127.0.0.1:${c.port}/save`, { method: 'POST', headers: { 'X-Relay-Token': config.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ tweet }) })).json();
  return { s, call };
}
const verdict = (choice, confidence, legalP = 0.1) => ({ choice, confidence, top: [[choice, confidence], ['coding-agents', 0.1]], relevance: [{ name: 'Research', p: legalP }] });

test('Jev with high confidence: the note is written directly and skips the archivist', async () => {
  const { s, call } = await relayWith(async () => verdict('coding-agents', 0.93));
  try {
    const r = await call({ ...sampleTweet, url: 'https://x.com/someone/status/7001' });
    assert.equal(r.decision, 'jev');
    assert.equal(r.category, 'coding-agents');
    assert.match(r.note, /^library\/coding-agents\/.*-someone-7001\.md$/);
    const note = fs.readFileSync(path.join(archiveDir, r.note), 'utf8');
    assert.match(note, /decision: jev\njev_confidence: 0\.93/);
    const plans = fs.readdirSync(path.join(archiveDir, 'plan')).filter((f) => f.startsWith('jev-'));
    assert.equal(plans.length, 1);
  } finally {
    s.close();
  }
});

test('Jev with low confidence or a new category: handed to the archivist with Jev\'s suggestion', async () => {
  const archive = await fakeInbox(home, 'archive2.sock');
  writeSession(home, { sessionId: 'archivist-2', socket: archive.socketPath, pid: process.pid, name: 'x-archive', cwd: archiveDir, registeredAt: 5 });
  const answers = [verdict('coding-agents', 0.6), verdict('new-category-needed', 0.95)];
  const { s, call } = await relayWith(async () => answers.shift());
  try {
    const r1 = await call({ ...sampleTweet, url: 'https://x.com/someone/status/7002' });
    assert.equal(r1.archivist, 'x-archive');
    assert.deepEqual(r1.jev, { choice: 'coding-agents', confidence: 0.6 });
    const r2 = await call({ ...sampleTweet, url: 'https://x.com/someone/status/7003' });
    assert.equal(r2.archivist, 'x-archive');
    const texts = archive.received.map((m) => JSON.parse(m).message.content);
    assert.match(texts[0], /SAVE/);
    assert.match(texts[0], /Jev suggestion \(not confident\): coding-agents 0\.60/);
    assert.match(texts[1], /new-category-needed 0\.95/);
  } finally {
    s.close();
    archive.close();
    fs.rmSync(path.join(home, 'sessions', 'archivist-2.json'), { force: true });
  }
});

test('a Jev error loses nothing: the post is queued and waits if there is no archivist', async () => {
  const { s, call } = await relayWith(async () => {
    throw new Error('network error');
  });
  try {
    const r = await call({ ...sampleTweet, url: 'https://x.com/someone/status/7004' });
    assert.equal(r.queued, true);
    assert.equal(r.jev, null);
    assert.match(fs.readFileSync(path.join(archiveDir, 'inbox', 'queue.jsonl'), 'utf8'), /"id":"7004"/);
  } finally {
    s.close();
  }
});

test('when topic relevance passes the threshold the relay sends a NOTICE and logs it', async () => {
  const mp = await fakeInbox(home, 'mp.sock');
  writeSession(home, { sessionId: 'mp-1', socket: mp.socketPath, pid: process.pid, name: 'Research', cwd: '/x/research', registeredAt: 6 });
  const answers = [verdict('legal-tech', 0.97, 0.95), verdict('coding-agents', 0.9, 0.4)];
  const { s, call } = await relayWith(async () => answers.shift());
  try {
    const r1 = await call({ ...sampleTweet, url: 'https://x.com/someone/status/7005' });
    assert.deepEqual(r1.notified, ['Research']);
    const r2 = await call({ ...sampleTweet, url: 'https://x.com/someone/status/7006' });
    assert.deepEqual(r2.notified, []);
    assert.equal(mp.received.length, 1);
    const text = JSON.parse(mp.received[0]).message.content;
    assert.match(text, /^\[x-to-claude\] NOTICE:/);
    assert.match(text, /Archive category: legal-tech/);
    const log = fs.readFileSync(path.join(archiveDir, 'notifications.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(log.at(-1).id, '7005');
    assert.equal(log.at(-1).delivered, true);
  } finally {
    s.close();
    mp.close();
    fs.rmSync(path.join(home, 'sessions', 'mp-1.json'), { force: true });
  }
});

test('/new-session gives the post to the opener and returns errors as 502', async () => {
  const seen = [];
  const answers = [async (p) => (seen.push(p), { id: 'abc', name: 'X: @someone' }), async () => { throw new (await import('../relay/newsession.mjs')).SessionOpenError('could not open'); }];
  const c2 = { ...config };
  const s = createRelay({ config: c2, sessionOpener: { open: (p) => answers.shift()(p) } });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  c2.port = s.address().port;
  const call = () => fetch(`http://127.0.0.1:${c2.port}/new-session`, { method: 'POST', headers: { 'X-Relay-Token': config.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ tweet: sampleTweet }) });
  try {
    const r1 = await call();
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { ok: true, sessionId: 'abc', name: 'X: @someone' });
    assert.equal(seen[0].url, 'https://x.com/someone/status/1234567890123456789');
    const r2 = await call();
    assert.equal(r2.status, 502);
    assert.equal((await r2.json()).code, undefined);
  } finally {
    s.close();
  }
});

test('/new-session: an expired Claude login gives the claude-login code', async () => {
  const { SessionOpenError } = await import('../relay/newsession.mjs');
  const c2 = { ...config };
  const s = createRelay({ config: c2, sessionOpener: { open: async () => { throw new SessionOpenError('Claude login expired', 'claude-login'); } } });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  c2.port = s.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${c2.port}/new-session`, { method: 'POST', headers: { 'X-Relay-Token': config.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ tweet: sampleTweet }) });
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { error: 'Claude login expired', code: 'claude-login' });
  } finally {
    s.close();
  }
});

test('/claude-login: GET gives the state, POST starts the login; token and origin checks apply', async () => {
  let starts = 0;
  const c2 = { ...config };
  const s = createRelay({ config: c2, claudeLogin: { status: async () => ({ loggedIn: false, running: starts > 0 }), start: () => starts++ } });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  c2.port = s.address().port;
  const call = (method, headers = {}) => fetch(`http://127.0.0.1:${c2.port}/claude-login`, { method, headers: { 'X-Relay-Token': config.token, ...headers } });
  try {
    assert.deepEqual(await (await call('GET')).json(), { loggedIn: false, running: false });
    assert.equal((await call('POST')).status, 200);
    assert.equal(starts, 1);
    assert.deepEqual(await (await call('GET')).json(), { loggedIn: false, running: true });

    assert.equal((await call('POST', { 'X-Relay-Token': 'wrong' })).status, 401);
    assert.equal((await call('POST', { Origin: 'https://x.com' })).status, 403);
    assert.equal((await call('DELETE')).status, 404);
    assert.equal(starts, 1, 'rejected requests do not start a login');
  } finally {
    s.close();
  }
});

test('/save: an archive that is not set up is refused with a pointer to archive:init', async () => {
  const c2 = { ...config, archiveDir: path.join(home, 'not-set-up') };
  const s = createRelay({ config: c2, judge: null, waker: null });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  c2.port = s.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${c2.port}/save`, { method: 'POST', headers: { 'X-Relay-Token': config.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ tweet: sampleTweet }) });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.code, 'archive-missing');
    assert.match(body.error, /archive:init/);
    assert.ok(!fs.existsSync(c2.archiveDir), 'nothing is written');
  } finally {
    s.close();
  }
});
