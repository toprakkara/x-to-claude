// Local relay: listens only on 127.0.0.1.
//   GET  /sessions                 live Claude Code sessions
//   POST /send {sessionId, tweet}  delivers the post to the session's inbox
//   POST /save {tweet}             queues the post for the archive; if Jev classifies it with high confidence, writes the
//                                  note, otherwise hands it to the archivist; sends notices to sessions on matching topics
//   GET  /saved?ids=1,2,3          which of these IDs are in the archive or the queue
//   POST /new-session {tweet}      opens a new Claude Desktop session for the post
//   GET  /claude-login             state of the Claude CLI login
//   POST /claude-login             starts the Claude CLI login (opens the sign-in page in the browser)
// Every request needs X-Relay-Token. Origin, if present, must be chrome-extension://; Host must be 127.0.0.1 or localhost
// (this guards against DNS rebinding). No CORS headers are sent, so web pages can't read responses.
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
import { createClaudeLogin } from './claudelogin.mjs';
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
  if (!origin) return true; // Non-browser clients (curl) send no Origin; the token is still required.
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
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// Null without a Jev key: every save then goes to the archivist.
function defaultJudge(config) {
  const env = loadJevEnv(config.jevEnvFile);
  if (!env.OPENROUTER_API_KEY && !env.TYPESAFE_API_KEY) return null;
  return (content, categories, routes) => judgeTweet(content, categories, routes, { env, signal: AbortSignal.timeout(8_000) });
}

// Environment for the claude processes the relay starts. launchd's PATH is short, so the node and claude folders are
// added (the archivist runs the note writer with `node`).
function claudeEnv(claudePath) {
  const PATH = [path.dirname(process.execPath), path.dirname(claudePath), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  return { ...process.env, PATH };
}
const claudePathOf = (config) => config.archivistWake?.claudePath ?? path.join(os.homedir(), '.local', 'bin', 'claude');

function defaultSessionOpener(config) {
  const n = config.newSession;
  if (!n?.enabled || !n.dir) return null;
  const claudePath = claudePathOf(config);
  return createSessionOpener({ dir: n.dir, claudePath, env: claudeEnv(claudePath), model: n.model, logFile: path.join(baseDir(), 'new-session.log') });
}

function defaultClaudeLogin(config, onLogin) {
  const claudePath = claudePathOf(config);
  return createClaudeLogin({ claudePath, env: claudeEnv(claudePath), cwd: os.homedir(), logFile: path.join(baseDir(), 'claude-login.log'), onLogin });
}

// The process that wakes the archivist in the background.
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
    logFile: path.join(baseDir(), 'archivist-wake.log'),
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
  claudeLogin = defaultClaudeLogin(config, () => waker?.retryNow('login renewed')),
} = {}) {
  const queue = createQueue({ deliver, ...queueOptions });
  const routes = Array.isArray(config.notifyRoutes) ? config.notifyRoutes : [];
  const threshold = typeof config.jevThreshold === 'number' ? config.jevThreshold : 0.85;
  let hits = [];

  // Notices to the routes Jev found relevant. The target session is found by name; if it isn't open, the notice is only logged.
  async function notify(post, verdict, category) {
    const sent = [];
    for (const r of verdict?.relevance ?? []) {
      const route = routes.find((x) => x.name === r.name);
      if (!route || r.p == null || r.p < (route.threshold ?? 0.7)) continue;
      const target = liveSessions({ prune: false }).find((s) => (s.name ?? '').toLowerCase() === route.name.toLowerCase());
      let delivered = false;
      if (target) {
        try {
          await queue.enqueue({ socket: target.socket, sessionId: target.sessionId, priority: config.priority, intent: 'notify' }, { ...post, archiveCategory: category });
          delivered = true;
          sent.push(route.name);
        } catch (e) {
          console.error(`${new Date().toISOString()} could not deliver notice (${route.name}): ${e.message}`);
        }
      }
      archive.logNotification({ at: new Date().toISOString(), id: statusId(post.url), url: post.url, route: route.name, p: r.p, category, delivered, reason: target ? undefined : 'session not open' });
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
      throw Object.assign(new Error('Content-Type must be application/json'), { status: 415 });
    }
    return readJson(req);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostOk(req.headers.host, config.port)) return send(res, 421, { error: 'invalid Host' });
      if (!originOk(req.headers.origin, config.extensionId)) return send(res, 403, { error: 'origin not allowed' });
      if (!tokenOk(req.headers['x-relay-token'], config.token)) return send(res, 401, { error: 'invalid token' });

      const { pathname } = new URL(req.url, 'http://127.0.0.1');

      if (req.method === 'GET' && pathname === '/sessions') {
        return send(res, 200, { sessions: liveSessions().map(publicView) });
      }

      if (req.method === 'GET' && pathname === '/saved') {
        const ids = (new URL(req.url, 'http://127.0.0.1').searchParams.get('ids') || '').split(',').filter((id) => /^\d{1,25}$/.test(id)).slice(0, 200);
        return send(res, 200, { saved: archive.savedIds(ids) });
      }

      if (req.method === 'POST' && pathname === '/save') {
        if (rateLimited()) return send(res, 429, { error: 'too many requests; wait a moment' });
        const body = await jsonBody(req);
        const post = validateTweet(body?.tweet);
        if (!archive.isReady()) return send(res, 409, { error: 'The archive isn\'t set up yet. Run "npm run archive:init" in the project folder.', code: 'archive-missing' });
        const { id, already } = archive.enqueue(post);
        if (already) return send(res, 200, { ok: true, id, already: true });

        // 1) Jev: category and topic relevance. On error the post goes to the archivist.
        const categories = archive.categories();
        let verdict = null;
        if (judge) {
          try {
            verdict = await judge(archive.contentOf(post), categories, routes);
          } catch (e) {
            console.error(`${new Date().toISOString()} Jev error, handing off to the archivist: ${e.message}`);
          }
        }
        const confident = verdict && verdict.choice !== NEW_CATEGORY && categories.has(verdict.choice) && (verdict.confidence ?? 0) >= threshold;

        // 2) High confidence: the note is written directly.
        if (confident) {
          const note = archive.writeJevNote(id, verdict);
          const notified = await notify(post, verdict, verdict.choice);
          return send(res, 200, { ok: true, id, decision: 'jev', category: verdict.choice, confidence: verdict.confidence, note, notified });
        }

        // 3) Low confidence or a new category: to the archivist, with Jev's top guesses. The post is already queued;
        //    if the archivist is closed (or the message doesn't arrive), the waker runs it in the background.
        const notified = await notify(post, verdict, null);
        const jev = verdict ? { choice: verdict.choice, confidence: verdict.confidence } : null;
        const archivist = archive.findArchivist(liveSessions());
        if (archivist) {
          try {
            const result = await queue.enqueue(
              { socket: archivist.socket, sessionId: archivist.sessionId, priority: config.priority, intent: 'save' },
              { ...post, jevTop: verdict?.top ?? [] },
            );
            // If a background archivist exits before reading the message, the post must not be orphaned, so the queue is checked again afterwards.
            waker?.request('forwarded to archivist');
            return send(res, 200, { ok: true, id, archivist: publicView(archivist).name, batched: result.batched, jev, notified });
          } catch (e) {
            if (!(e instanceof DeliveryError)) throw e;
          }
        }
        waker?.request('save');
        return send(res, 200, { ok: true, id, queued: true, archivist: null, waking: !!waker, jev, notified });
      }

      if (req.method === 'POST' && pathname === '/new-session') {
        if (!sessionOpener) return send(res, 404, { error: 'the new-session feature is turned off' });
        if (rateLimited()) return send(res, 429, { error: 'too many requests; wait a moment' });
        const body = await jsonBody(req);
        const post = validateTweet(body?.tweet);
        try {
          const { id, name } = await sessionOpener.open(post);
          return send(res, 200, { ok: true, sessionId: id, name });
        } catch (e) {
          if (e instanceof SessionOpenError) return send(res, 502, { error: e.message, ...(e.code ? { code: e.code } : {}) });
          throw e;
        }
      }

      if (pathname === '/claude-login') {
        if (req.method === 'GET') return send(res, 200, await claudeLogin.status());
        if (req.method === 'POST') {
          if (rateLimited()) return send(res, 429, { error: 'too many requests; wait a moment' });
          claudeLogin.start();
          return send(res, 200, { ok: true });
        }
      }

      if (req.method === 'POST' && pathname === '/send') {
        if (rateLimited()) return send(res, 429, { error: 'too many requests; wait a moment' });
        const body = await jsonBody(req);
        if (typeof body?.sessionId !== 'string') return send(res, 400, { error: 'sessionId missing' });
        const post = validateTweet(body.tweet);
        const session = findSession(body.sessionId);
        if (!session) return send(res, 404, { error: 'session not found or closed' });

        const result = await queue.enqueue({ socket: session.socket, sessionId: session.sessionId, priority: config.priority }, post);
        return send(res, 200, { ok: true, session: publicView(session), batched: result.batched });
      }

      return send(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof ValidationError) return send(res, 400, { error: e.message });
      if (e instanceof DeliveryError) return send(res, 502, { error: `delivery failed: ${e.message}` });
      if (e.status) return send(res, e.status, { error: e.message });
      console.error(e);
      return send(res, 500, { error: 'relay internal error' });
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
        ? `${new Date().toISOString()} port ${config.port} is in use; another relay may be running (launchd: npm run launchd:status).`
        : `${new Date().toISOString()} could not start the relay: ${e.message}`,
    );
    process.exit(1);
  });
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`${new Date().toISOString()} x-to-claude relay: http://127.0.0.1:${config.port}${config.extensionId ? ` (extension ${config.extensionId} only)` : ''}`);
    // For posts left in the queue while the relay was down or a wake-up failed: check at start-up and every 30 minutes.
    server.waker?.request('relay start');
    setInterval(() => server.waker?.request('periodic check'), 30 * 60_000).unref();
  });
}
