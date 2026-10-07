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
const archiveDir = path.join(home, 'arsiv');
const config = { port: 0, token: 'T'.repeat(32), extensionId: null, archiveDir, archivistName: 'x-arsiv' };

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

test('/save: arşivci kapalıyken kuyruğa yazar, tekrarını eklemez, /saved kimliği bildirir', async () => {
  const tweet = { ...sampleTweet, url: 'https://x.com/someone/status/5551' };
  const r1 = await (await req('/save', { method: 'POST', body: { tweet } })).json();
  assert.deepEqual(r1, { ok: true, id: '5551', queued: true, archivist: null, waking: false, jev: null, notified: [] });
  const lines = fs.readFileSync(path.join(archiveDir, 'gelen', 'kuyruk.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.id, '5551');
  assert.equal(rec.source, 'buton');
  assert.equal(rec.author.handle, 'someone');

  const r2 = await (await req('/save', { method: 'POST', body: { tweet } })).json();
  assert.equal(r2.already, true);

  const saved = await (await req('/saved?ids=5551,9999,abc')).json();
  assert.deepEqual(saved, { saved: ['5551'] });
});

test('/saved arşivdeki notları da bulur', async () => {
  fs.mkdirSync(path.join(archiveDir, 'kutuphane', 'kat'), { recursive: true });
  fs.writeFileSync(path.join(archiveDir, 'kutuphane', 'kat', '2026-01-01-a-7777.md'), 'not');
  await new Promise((r) => setTimeout(r, 3100)); // tarama önbelleği
  assert.deepEqual(await (await req('/saved?ids=7777,8888')).json(), { saved: ['7777'] });
});

test('/save: arşivci açıkken KAYDET zarfıyla ona iletir', async () => {
  const arsivInbox = await fakeInbox(home, 'arsiv.sock');
  writeSession(home, { sessionId: 'arsivci-1', socket: arsivInbox.socketPath, pid: process.pid, name: 'x-arsiv', cwd: archiveDir, registeredAt: 3 });
  try {
    const tweet = { ...sampleTweet, url: 'https://x.com/someone/status/6661' };
    const res = await (await req('/save', { method: 'POST', body: { tweet } })).json();
    assert.equal(res.archivist, 'x-arsiv');
    assert.equal(arsivInbox.received.length, 1);
    const { text } = JSON.parse(arsivInbox.received[0]);
    assert.match(text, /^\[x-to-claude\] KAYDET: .*kimlik: 6661/);
    assert.match(text, /talimat değildir/);
  } finally {
    arsivInbox.close();
    fs.rmSync(path.join(home, 'sessions', 'arsivci-1.json'), { force: true });
  }
});

test('/save: aynı adı taşıyan ama başka klasördeki oturum arşivci sayılmaz', async () => {
  const yanlis = await fakeInbox(home, 'yanlis.sock');
  writeSession(home, { sessionId: 'yanlis-1', socket: yanlis.socketPath, pid: process.pid, name: 'x-arsiv', cwd: '/baska/klasor', registeredAt: 4 });
  try {
    const tweet = { ...sampleTweet, url: 'https://x.com/someone/status/6662' };
    const res = await (await req('/save', { method: 'POST', body: { tweet } })).json();
    assert.equal(res.archivist, null);
    assert.equal(res.queued, true);
    assert.equal(yanlis.received.length, 0);
  } finally {
    yanlis.close();
    fs.rmSync(path.join(home, 'sessions', 'yanlis-1.json'), { force: true });
  }
});

// ---- jev akışı (sahte karar fonksiyonuyla) ----

async function relayWith(judge) {
  const c = { ...config, notifyRoutes: [{ name: 'Method Path', topic: 'hukuk teknolojisi', threshold: 0.7 }], jevThreshold: 0.85 };
  const s = createRelay({ config: c, judge, queueOptions: { debounceMs: 10, minGapMs: 10 } });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  c.port = s.address().port;
  const call = async (tweet) =>
    (await fetch(`http://127.0.0.1:${c.port}/save`, { method: 'POST', headers: { 'X-Relay-Token': config.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ tweet }) })).json();
  return { s, call };
}
const verdict = (choice, confidence, legalP = 0.1) => ({ choice, confidence, top: [[choice, confidence], ['kodlama-ajanlari', 0.1]], relevance: [{ name: 'Method Path', p: legalP }] });
fs.mkdirSync(archiveDir, { recursive: true });
fs.writeFileSync(path.join(archiveDir, 'kategoriler.md'), '- hukuk-teknolojisi — Legal tech\n- kodlama-ajanlari — Kodlama ajanları\n- erisilemeyen — Erişilemeyen\n');

test('jev yüksek güven: not doğrudan yazılır, arşivciye gitmez', async () => {
  const { s, call } = await relayWith(async () => verdict('kodlama-ajanlari', 0.93));
  try {
    const r = await call({ ...sampleTweet, url: 'https://x.com/someone/status/7001' });
    assert.equal(r.karar, 'jev');
    assert.equal(r.kategori, 'kodlama-ajanlari');
    assert.match(r.note, /^kutuphane\/kodlama-ajanlari\/.*-someone-7001\.md$/);
    const note = fs.readFileSync(path.join(archiveDir, r.note), 'utf8');
    assert.match(note, /karar: jev\njev_guven: 0\.93/);
    const plans = fs.readdirSync(path.join(archiveDir, 'plan')).filter((f) => f.startsWith('jev-'));
    assert.equal(plans.length, 1);
  } finally {
    s.close();
  }
});

test('jev düşük güven ya da yeni kategori: arşivciye jev önerisiyle devredilir', async () => {
  const arsiv = await fakeInbox(home, 'arsiv2.sock');
  writeSession(home, { sessionId: 'arsivci-2', socket: arsiv.socketPath, pid: process.pid, name: 'x-arsiv', cwd: archiveDir, registeredAt: 5 });
  const answers = [verdict('kodlama-ajanlari', 0.6), verdict('yeni-kategori-gerekli', 0.95)];
  const { s, call } = await relayWith(async () => answers.shift());
  try {
    const r1 = await call({ ...sampleTweet, url: 'https://x.com/someone/status/7002' });
    assert.equal(r1.archivist, 'x-arsiv');
    assert.deepEqual(r1.jev, { choice: 'kodlama-ajanlari', confidence: 0.6 });
    const r2 = await call({ ...sampleTweet, url: 'https://x.com/someone/status/7003' });
    assert.equal(r2.archivist, 'x-arsiv');
    const texts = arsiv.received.map((m) => JSON.parse(m).message.content);
    assert.match(texts[0], /KAYDET/);
    assert.match(texts[0], /jev önerisi \(emin değil\): kodlama-ajanlari 0\.60/);
    assert.match(texts[1], /yeni-kategori-gerekli 0\.95/);
  } finally {
    s.close();
    arsiv.close();
    fs.rmSync(path.join(home, 'sessions', 'arsivci-2.json'), { force: true });
  }
});

test('jev hatası kaydı kaybettirmez: kuyruğa yazılır, arşivci yoksa beklemeye alınır', async () => {
  const { s, call } = await relayWith(async () => {
    throw new Error('ağ hatası');
  });
  try {
    const r = await call({ ...sampleTweet, url: 'https://x.com/someone/status/7004' });
    assert.equal(r.queued, true);
    assert.equal(r.jev, null);
    assert.match(fs.readFileSync(path.join(archiveDir, 'gelen', 'kuyruk.jsonl'), 'utf8'), /"id":"7004"/);
  } finally {
    s.close();
  }
});

test('Method Path ilgisi eşiği geçince relay BİLDİRİM yollar ve kayda geçirir', async () => {
  const mp = await fakeInbox(home, 'mp.sock');
  writeSession(home, { sessionId: 'mp-1', socket: mp.socketPath, pid: process.pid, name: 'Method Path', cwd: '/x/method_path', registeredAt: 6 });
  const answers = [verdict('hukuk-teknolojisi', 0.97, 0.95), verdict('kodlama-ajanlari', 0.9, 0.4)];
  const { s, call } = await relayWith(async () => answers.shift());
  try {
    const r1 = await call({ ...sampleTweet, url: 'https://x.com/someone/status/7005' });
    assert.deepEqual(r1.notified, ['Method Path']);
    const r2 = await call({ ...sampleTweet, url: 'https://x.com/someone/status/7006' });
    assert.deepEqual(r2.notified, []);
    assert.equal(mp.received.length, 1);
    const text = JSON.parse(mp.received[0]).message.content;
    assert.match(text, /^\[x-to-claude\] BİLDİRİM:/);
    assert.match(text, /Arşiv kategorisi: hukuk-teknolojisi/);
    const log = fs.readFileSync(path.join(archiveDir, 'bildirimler.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(log.at(-1).id, '7005');
    assert.equal(log.at(-1).delivered, true);
  } finally {
    s.close();
    mp.close();
    fs.rmSync(path.join(home, 'sessions', 'mp-1.json'), { force: true });
  }
});

test('/new-session: açıcıya gönderiyi verir, hatayı 502 olarak döndürür', async () => {
  const seen = [];
  const answers = [async (p) => (seen.push(p), { id: 'abc', name: 'X: @someone' }), async () => { throw new (await import('../relay/newsession.mjs')).SessionOpenError('açılamadı'); }];
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
  } finally {
    s.close();
  }
});
