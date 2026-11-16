// Optional OpenBot target, off unless config.json has "openbot": { "enabled": true }. It sends a post to the chat of an
// OpenBot agent on this Mac through OpenBot's Local scripts API, the API that OpenBot's own openbot-cli uses.
//
// Verified against the OpenBot desktop app of November 2026 (its automation server and bundled openbot-cli.mjs), but
// not yet against a live agent:
//   - While at least one agent has Local scripts on, OpenBot listens on 127.0.0.1 and writes "url" and "token" to its
//     automation folder (~/Library/Application Support/OpenBot/automation on macOS). Both change when OpenBot restarts,
//     so they're read on every request.
//   - Every request needs "Authorization: Bearer <token>", Host 127.0.0.1:<port> and no Origin header, so a browser
//     page or the extension can't call it; only the relay does.
//   - GET  /v1/agents                       [{id, name, routines}] of the agents with Local scripts on
//   - POST /v1/agents/<id>/messages {text, clientMessageId}   202, the message is queued in the agent's chat;
//     403 Local scripts are off for the agent, 404 no such agent, 429 hourly limit reached
// The token can do more than send messages, so the relay uses only these two calls and never logs or returns it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { baseDir } from './config.mjs';
import { formatMessage, statusId } from './format.mjs';

const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

// The OpenBot logo that the menu shows next to each agent. It's read from the installed OpenBot app, never shipped in
// this repository, and shrunk with macOS's sips. The Local scripts API has no per-agent avatars yet.
export const ICON_SOURCES = ['/Applications', path.join(os.homedir(), 'Applications')].map((d) => path.join(d, 'OpenBot.app', 'Contents', 'Resources', 'icons', 'icon-production.png'));

// A small PNG as a data: URL, or null when OpenBot or sips isn't there.
export async function makeIcon({ sources = ICON_SOURCES, out = path.join(baseDir(), 'openbot-icon.png'), sips = '/usr/bin/sips', size = 64 } = {}) {
  const src = sources.find((s) => fs.existsSync(s));
  if (!src) return null;
  try {
    await promisify(execFile)(sips, ['-s', 'format', 'png', '-Z', String(size), src, '--out', out], { timeout: 10_000 });
    const png = fs.readFileSync(out);
    if (png.length > 32_768 || png.subarray(1, 4).toString('latin1') !== 'PNG') return null;
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return null;
  }
}

export class OpenBotError extends Error {
  constructor(message, code, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function defaultAutomationDir() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'OpenBot', 'automation');
}

// The token must only ever go to OpenBot's loopback server.
function loopbackUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' && p.hostname === '127.0.0.1' && p.pathname === '/' ? p.origin : null;
  } catch {
    return null;
  }
}

export function createOpenBot({ config, fetchImpl = fetch, timeoutMs = 8_000, icon = makeIcon }) {
  const cfg = config.openbot;
  if (!cfg || typeof cfg !== 'object' || cfg.enabled !== true) return null;
  let iconOnce = null; // made once per relay run
  const dir = typeof cfg.automationDir === 'string' && path.isAbsolute(cfg.automationDir) ? cfg.automationDir : defaultAutomationDir();

  function connection() {
    let url, token;
    try {
      url = fs.readFileSync(path.join(dir, 'url'), 'utf8').trim();
      token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
    } catch {
      throw new OpenBotError('OpenBot isn\'t running, or no agent has Local scripts on.', 'openbot-off', 503);
    }
    const origin = loopbackUrl(url);
    if (!origin || !token) throw new OpenBotError('OpenBot\'s automation folder has an unexpected address.', 'openbot-off', 503);
    return { origin, token };
  }

  async function call(method, pathname, body) {
    const { origin, token } = connection();
    let res;
    try {
      res = await fetchImpl(origin + pathname, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new OpenBotError(e.name === 'TimeoutError' ? 'OpenBot didn\'t answer in time.' : 'OpenBot doesn\'t answer. Is it running?', 'openbot-unreachable', 503);
    }
    const data = await res.json().catch(() => null);
    if (res.ok) return data;
    // OpenBot's own error text for these is safe to show; it never contains the token.
    const reason = typeof data?.error === 'string' ? data.error.slice(0, 300) : `HTTP ${res.status}`;
    if (res.status === 401) throw new OpenBotError('OpenBot refused the token; it may have just restarted. Try again.', 'openbot-auth');
    if (res.status === 403) throw new OpenBotError(reason, 'openbot-scripts-off', 403);
    if (res.status === 404) throw new OpenBotError('That OpenBot agent wasn\'t found.', 'openbot-missing', 404);
    if (res.status === 429) throw new OpenBotError(reason, 'openbot-rate-limited', 429);
    throw new OpenBotError(`OpenBot: ${reason}`, 'openbot-http');
  }

  return {
    icon: () => (iconOnce ??= Promise.resolve().then(icon).catch(() => null)),

    // Agents with Local scripts on, as {id, name}.
    async agents() {
      const list = await call('GET', '/v1/agents');
      return (Array.isArray(list) ? list : [])
        .filter((a) => typeof a?.id === 'string' && AGENT_ID.test(a.id) && typeof a.name === 'string' && a.name.trim())
        .map((a) => ({ id: a.id, name: a.name.trim().slice(0, 80) }));
    },

    // Queues the post in the agent's chat, inside the same untrusted-data envelope that Claude Code sessions get.
    async send(agentId, post) {
      if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) throw new OpenBotError('That OpenBot agent wasn\'t found.', 'openbot-missing', 404);
      const receipt = await call('POST', `/v1/agents/${encodeURIComponent(agentId)}/messages`, {
        text: formatMessage([post], { intent: 'openbot' }),
        clientMessageId: `x2c-${statusId(post.url)}-${crypto.randomBytes(6).toString('hex')}`,
      });
      const delivery = receipt?.deliveries?.find?.((d) => d?.recipientAgentId === agentId);
      if (!delivery) throw new OpenBotError('OpenBot didn\'t queue the message.', 'openbot-http');
      return { status: typeof delivery.status === 'string' ? delivery.status : 'queued' };
    },
  };
}
