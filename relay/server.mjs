// Yerel relay: yalnız 127.0.0.1'i dinler.
//   GET  /sessions                 yaşayan Claude Code oturumları
//   POST /send {sessionId, tweet}  gönderiyi oturumun gelen kutusuna iletir
// Her istekte X-Relay-Token zorunlu. Origin varsa chrome-extension:// olmalı; Host 127.0.0.1/localhost olmalı
// (DNS rebinding'e karşı). CORS başlığı gönderilmez; web sayfaları yanıtları okuyamaz.
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { liveSessions, publicView, findSession } from './registry.mjs';
import { validateTweet, ValidationError } from './format.mjs';
import { deliver as socketDeliver, DeliveryError } from './inbox.mjs';
import { createQueue } from './queue.mjs';

const MAX_BODY = 128 * 1024;
const RATE = { windowMs: 60_000, max: 30 };

function tokenOk(given, expected) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function originOk(origin, extensionId) {
  if (!origin) return true; // Tarayıcı dışı istemciler (curl) Origin göndermez; token yine şart.
  if (extensionId) return origin === `chrome-extension://${extensionId}`;
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

function hostOk(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(json);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('istek gövdesi çok büyük'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('geçersiz JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export function createRelay({ config, deliver = socketDeliver, queueOptions } = {}) {
  const queue = createQueue({ deliver, ...queueOptions });
  let hits = [];

  return http.createServer(async (req, res) => {
    try {
      if (!hostOk(req.headers.host, config.port)) return send(res, 421, { error: 'geçersiz Host' });
      if (!originOk(req.headers.origin, config.extensionId)) return send(res, 403, { error: 'izin verilmeyen kaynak' });
      if (!tokenOk(req.headers['x-relay-token'], config.token)) return send(res, 401, { error: 'geçersiz token' });

      const { pathname } = new URL(req.url, 'http://127.0.0.1');

      if (req.method === 'GET' && pathname === '/sessions') {
        return send(res, 200, { sessions: liveSessions().map(publicView) });
      }

      if (req.method === 'POST' && pathname === '/send') {
        const t = Date.now();
        hits = hits.filter((h) => t - h < RATE.windowMs);
        if (hits.length >= RATE.max) return send(res, 429, { error: 'çok fazla istek; biraz bekle' });
        hits.push(t);

        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
          return send(res, 415, { error: 'Content-Type application/json olmalı' });
        }
        const body = await readJson(req);
        if (typeof body?.sessionId !== 'string') return send(res, 400, { error: 'sessionId eksik' });
        const post = validateTweet(body.tweet);
        const session = findSession(body.sessionId);
        if (!session) return send(res, 404, { error: 'oturum bulunamadı ya da kapanmış' });

        const result = await queue.enqueue({ socket: session.socket, sessionId: session.sessionId, priority: config.priority }, post);
        return send(res, 200, { ok: true, session: publicView(session), batched: result.batched });
      }

      return send(res, 404, { error: 'bulunamadı' });
    } catch (e) {
      if (e instanceof ValidationError) return send(res, 400, { error: e.message });
      if (e instanceof DeliveryError) return send(res, 502, { error: `teslim edilemedi: ${e.message}` });
      if (e.status) return send(res, e.status, { error: e.message });
      console.error(e);
      return send(res, 500, { error: 'relay iç hatası' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const server = createRelay({ config });
  server.on('error', (e) => {
    console.error(
      e.code === 'EADDRINUSE'
        ? `${new Date().toISOString()} ${config.port} portu dolu; başka bir relay çalışıyor olabilir (launchd: npm run launchd:status).`
        : `${new Date().toISOString()} relay başlatılamadı: ${e.message}`,
    );
    process.exit(1);
  });
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`${new Date().toISOString()} x-to-claude relay: http://127.0.0.1:${config.port}${config.extensionId ? ` (yalnız eklenti ${config.extensionId})` : ''}`);
  });
}
