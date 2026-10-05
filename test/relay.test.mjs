import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempHome, fakeInbox, writeSession, sampleTweet } from './helpers.mjs';

const home = tempHome();
process.env.X2C_HOME = home;

const { createRelay } = await import('../relay/server.mjs');
const { deliver } = await import('../relay/inbox.mjs');

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const config = { port: 0, token: 'T'.repeat(32), extensionId: null };

// Kuyruk ve biçim testlerinde okunması kolay bir sahte kodlayıcı; gerçek tel formatı ayrı testte.
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
writeSession(home, { sessionId: 'live-1', socket: inbox.socketPath, pid: process.pid, name: 'method_path', cwd: '/Users/u/method_path', entrypoint: 'cli', registeredAt: 2 });
writeSession(home, { sessionId: 'dead-1', socket: path.join(home, 'yok.sock'), pid: process.pid, name: 'ölü', registeredAt: 1 });

const server = await startRelay();
test.after(() => {
  server.close();
  inbox.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('token yoksa ya da yanlışsa 401', async () => {
  assert.equal((await req('/sessions', { headers: { 'X-Relay-Token': 'yanlis' } })).status, 401);
});

test('web sayfası kaynağından gelen istek 403', async () => {
  assert.equal((await req('/sessions', { headers: { Origin: 'https://x.com' } })).status, 403);
});

test('extensionId sabitlenmişse başka eklenti 403', async () => {
  config.extensionId = 'pppppppppppppppppppppppppppppppp';
  try {
    assert.equal((await req('/sessions')).status, 403);
  } finally {
    config.extensionId = null;
  }
});

test('/sessions yaşayanları döndürür, soket yolunu sızdırmaz, ölü kaydı siler', async () => {
  const res = await req('/sessions');
  assert.equal(res.status, 200);
  const { sessions } = await res.json();
  assert.deepEqual(sessions.map((s) => s.id), ['live-1']);
  assert.equal(sessions[0].name, 'method_path');
  assert.ok(!JSON.stringify(sessions).includes(inbox.socketPath));
  assert.ok(!fs.existsSync(path.join(home, 'sessions', 'dead-1.json')));
});

test('/send gönderiyi biçimlendirip gelen kutusuna yazar', async () => {
  inbox.received.length = 0;
  const res = await req('/send', { method: 'POST', body: { sessionId: 'live-1', tweet: sampleTweet } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).batched, 1);
  assert.equal(inbox.received.length, 1);
  const { text } = JSON.parse(inbox.received[0]);
  assert.match(text, /\[x-to-claude\]/);
  assert.match(text, /https:\/\/x\.com\/someone\/status\/1234567890123456789/);
});

test('hızlı ardışık gönderiler tek mesajda birleşir', async () => {
  inbox.received.length = 0;
  const urls = [1, 2, 3].map((n) => `https://x.com/someone/status/${n}`);
  const results = await Promise.all(urls.map((url) => req('/send', { method: 'POST', body: { sessionId: 'live-1', tweet: { ...sampleTweet, url } } })));
  for (const r of results) assert.equal((await r.json()).batched, 3);
  assert.equal(inbox.received.length, 1);
  assert.match(JSON.parse(inbox.received[0]).text, /3 X gönderisi/);
});

test('bilinmeyen oturum 404, bozuk gönderi 400', async () => {
  assert.equal((await req('/send', { method: 'POST', body: { sessionId: 'yok', tweet: sampleTweet } })).status, 404);
  assert.equal((await req('/send', { method: 'POST', body: { sessionId: 'live-1', tweet: { url: 'https://evil.com' } } })).status, 400);
});

test('DNS rebinding: yabancı Host başlığı 421', async () => {
  // fetch Host başlığını değiştirmeye izin vermez; ham http isteğiyle dene.
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

test('varsayılan teslim doğrulanmış tel formatını yazar (session_id ve from dahil)', async () => {
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
    assert.equal(lines.length, 1, 'auth satırı gönderilmemeli, tek mesaj satırı olmalı');
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
