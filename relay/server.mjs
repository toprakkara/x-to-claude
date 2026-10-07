// Yerel relay: yalnız 127.0.0.1'i dinler.
//   GET  /sessions                 yaşayan Claude Code oturumları
//   POST /send {sessionId, tweet}  gönderiyi oturumun gelen kutusuna iletir
//   POST /save {tweet}             gönderiyi arşiv kuyruğuna yazar; jev yüksek güvenle sınıflandırırsa notu yazar,
//                                  yoksa arşivci oturumuna devreder; ilgili oturumlara bildirim yollar
//   GET  /saved?ids=1,2,3          bu kimliklerden arşivde ya da kuyrukta olanlar
//   POST /new-session {tweet}      gönderi için Claude Desktop'ta yeni bir oturum açar
// Her istekte X-Relay-Token zorunlu. Origin varsa chrome-extension:// olmalı; Host 127.0.0.1/localhost olmalı
// (DNS rebinding'e karşı). CORS başlığı gönderilmez; web sayfaları yanıtları okuyamaz.
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { liveSessions, publicView, findSession } from './registry.mjs';
import { validateTweet, ValidationError, statusId } from './format.mjs';
import { deliver as socketDeliver, DeliveryError } from './inbox.mjs';
import { createQueue } from './queue.mjs';
import { createArchive } from './archive.mjs';
import { loadJevEnv, baseDir } from './config.mjs';
import { createWaker, wakePrompt } from './waker.mjs';
import { createSessionOpener, SessionOpenError } from './newsession.mjs';
import { judgeTweet, NEW_CATEGORY } from './jev.mjs';

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

// jev anahtarı yoksa null: kaydetme her zaman arşivciye devredilir.
function defaultJudge(config) {
  const env = loadJevEnv(config.jevEnvFile);
  if (!env.OPENROUTER_API_KEY && !env.TYPESAFE_API_KEY) return null;
  return (content, categories, routes) => judgeTweet(content, categories, routes, { env, signal: AbortSignal.timeout(8_000) });
}

// relay'in başlattığı claude süreçleri için ortam. launchd'nin PATH'i kısa olduğu için node ve claude klasörleri
// eklenir (arşivci not yazıcıyı `node` ile çalıştırıyor).
function claudeEnv(claudePath) {
  const PATH = [path.dirname(process.execPath), path.dirname(claudePath), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  return { ...process.env, PATH };
}
const claudePathOf = (config) => config.archivistWake?.claudePath ?? path.join(os.homedir(), '.local', 'bin', 'claude');

function defaultSessionOpener(config) {
  const n = config.newSession;
  if (!n?.enabled || !n.dir) return null;
  const claudePath = claudePathOf(config);
  return createSessionOpener({ dir: n.dir, claudePath, env: claudeEnv(claudePath), model: n.model, logFile: path.join(baseDir(), 'yeni-oturum.log') });
}

// Arşivciyi arka planda uyandıran süreç.
function defaultWaker(config, archive) {
  const w = config.archivistWake;
  if (!w?.enabled || !config.archiveDir) return null;
  return createWaker({
    cwd: config.archiveDir,
    command: w.claudePath,
    args: (ids) => ['-p', wakePrompt(ids), '--name', config.archivistName, '--permission-mode', 'dontAsk', '--strict-mcp-config', ...(w.model ? ['--model', w.model] : [])],
    env: claudeEnv(w.claudePath),
    pendingIds: () => archive.pendingIds(),
    isArchivistAlive: () => !!archive.findArchivist(liveSessions({ prune: false })),
    logFile: path.join(baseDir(), 'arsivci-uyandirma.log'),
  });
}

export function createRelay({
  config,
  deliver = socketDeliver,
  queueOptions,
  archive = createArchive({ dir: config.archiveDir, archivistName: config.archivistName }),
  judge = defaultJudge(config),
  waker = defaultWaker(config, archive),
  sessionOpener = defaultSessionOpener(config),
} = {}) {
  const queue = createQueue({ deliver, ...queueOptions });
  const routes = Array.isArray(config.notifyRoutes) ? config.notifyRoutes : [];
  const threshold = typeof config.jevThreshold === 'number' ? config.jevThreshold : 0.85;
  let hits = [];

  // jev'in ilgili bulduğu hedeflere bildirim. Hedef oturum adıyla bulunur; açık değilse yalnız kayda geçer.
  async function notify(post, verdict, kategori) {
    const sent = [];
    for (const r of verdict?.relevance ?? []) {
      const route = routes.find((x) => x.name === r.name);
      if (!route || r.p == null || r.p < (route.threshold ?? 0.7)) continue;
      const target = liveSessions({ prune: false }).find((s) => (s.name ?? '').toLowerCase() === route.name.toLowerCase());
      let delivered = false;
      if (target) {
        try {
          await queue.enqueue({ socket: target.socket, sessionId: target.sessionId, priority: config.priority, intent: 'notify' }, { ...post, archiveCategory: kategori });
          delivered = true;
          sent.push(route.name);
        } catch (e) {
          console.error(`${new Date().toISOString()} bildirim teslim edilemedi (${route.name}): ${e.message}`);
        }
      }
      archive.logNotification({ at: new Date().toISOString(), id: statusId(post.url), url: post.url, route: route.name, p: r.p, kategori, delivered, reason: target ? undefined : 'oturum açık değil' });
    }
    return sent;
  }

  function rateLimited() {
    const t = Date.now();
    hits = hits.filter((h) => t - h < RATE.windowMs);
    if (hits.length >= RATE.max) return true;
    hits.push(t);
    return false;
  }

  async function jsonBody(req) {
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
      throw Object.assign(new Error('Content-Type application/json olmalı'), { status: 415 });
    }
    return readJson(req);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostOk(req.headers.host, config.port)) return send(res, 421, { error: 'geçersiz Host' });
      if (!originOk(req.headers.origin, config.extensionId)) return send(res, 403, { error: 'izin verilmeyen kaynak' });
      if (!tokenOk(req.headers['x-relay-token'], config.token)) return send(res, 401, { error: 'geçersiz token' });

      const { pathname } = new URL(req.url, 'http://127.0.0.1');

      if (req.method === 'GET' && pathname === '/sessions') {
        return send(res, 200, { sessions: liveSessions().map(publicView) });
      }

      if (req.method === 'GET' && pathname === '/saved') {
        const ids = (new URL(req.url, 'http://127.0.0.1').searchParams.get('ids') || '').split(',').filter((id) => /^\d{1,25}$/.test(id)).slice(0, 200);
        return send(res, 200, { saved: archive.savedIds(ids) });
      }

      if (req.method === 'POST' && pathname === '/save') {
        if (rateLimited()) return send(res, 429, { error: 'çok fazla istek; biraz bekle' });
        const body = await jsonBody(req);
        const post = validateTweet(body?.tweet);
        const { id, already } = archive.enqueue(post);
        if (already) return send(res, 200, { ok: true, id, already: true });

        // 1) jev: kategori + bildirim ilgisi. Hata olursa arşivciye devredilir.
        const categories = archive.categories();
        let verdict = null;
        if (judge) {
          try {
            verdict = await judge(archive.contentOf(post), categories, routes);
          } catch (e) {
            console.error(`${new Date().toISOString()} jev hatası, arşivciye devrediliyor: ${e.message}`);
          }
        }
        const confident = verdict && verdict.choice !== NEW_CATEGORY && categories.has(verdict.choice) && (verdict.confidence ?? 0) >= threshold;

        // 2) Yüksek güven: not doğrudan yazılır.
        if (confident) {
          const note = archive.writeJevNote(id, verdict);
          const notified = await notify(post, verdict, verdict.choice);
          return send(res, 200, { ok: true, id, karar: 'jev', kategori: verdict.choice, confidence: verdict.confidence, note, notified });
        }

        // 3) Düşük güven ya da yeni kategori: arşivciye, jev'in ilk tahminleriyle. Kayıt zaten kuyrukta;
        //    arşivci kapalıysa (ya da mesaj ulaşmazsa) uyandırıcı onu arka planda çalıştırır.
        const notified = await notify(post, verdict, null);
        const jev = verdict ? { choice: verdict.choice, confidence: verdict.confidence } : null;
        const archivist = archive.findArchivist(liveSessions());
        if (archivist) {
          try {
            const result = await queue.enqueue(
              { socket: archivist.socket, sessionId: archivist.sessionId, priority: config.priority, intent: 'save' },
              { ...post, jevTop: verdict?.top ?? [] },
            );
            // Arka plandaki arşivci mesajı okumadan çıkarsa kayıt sahipsiz kalmasın: bitince kuyruğa bir daha bakılır.
            waker?.request('arşivciye iletildi');
            return send(res, 200, { ok: true, id, archivist: publicView(archivist).name, batched: result.batched, jev, notified });
          } catch (e) {
            if (!(e instanceof DeliveryError)) throw e;
          }
        }
        waker?.request('kayıt');
        return send(res, 200, { ok: true, id, queued: true, archivist: null, waking: !!waker, jev, notified });
      }

      if (req.method === 'POST' && pathname === '/new-session') {
        if (!sessionOpener) return send(res, 404, { error: 'yeni oturum özelliği kapalı' });
        if (rateLimited()) return send(res, 429, { error: 'çok fazla istek; biraz bekle' });
        const body = await jsonBody(req);
        const post = validateTweet(body?.tweet);
        try {
          const { id, name } = await sessionOpener.open(post);
          return send(res, 200, { ok: true, sessionId: id, name });
        } catch (e) {
          if (e instanceof SessionOpenError) return send(res, 502, { error: e.message });
          throw e;
        }
      }

      if (req.method === 'POST' && pathname === '/send') {
        if (rateLimited()) return send(res, 429, { error: 'çok fazla istek; biraz bekle' });
        const body = await jsonBody(req);
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
  server.waker = waker;
  return server;
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
    // Relay kapalıyken ya da uyandırma başarısızken kuyrukta kalanlar için: açılışta ve yarım saatte bir kontrol.
    server.waker?.request('relay başlangıcı');
    setInterval(() => server.waker?.request('periyodik kontrol'), 30 * 60_000).unref();
  });
}
