// Relay configuration: ~/.x-to-claude/config.json
// Generates a random token on first run. The file is readable only by the user (0600).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 47615;

export function baseDir() {
  return process.env.X2C_HOME || path.join(os.homedir(), '.x-to-claude');
}

export function sessionsDir() {
  return path.join(baseDir(), 'sessions');
}

// The folder where Claude Code keeps a <pid>.json file for each live session.
export function claudeSessionsDir() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions');
}

// The first of the usual install locations that exists.
function defaultClaudePath() {
  const candidates = [path.join(os.homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

function configPath() {
  return path.join(baseDir(), 'config.json');
}

export function loadConfig() {
  fs.mkdirSync(baseDir(), { recursive: true, mode: 0o700 });
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let changed = false;
  if (typeof cfg.token !== 'string' || cfg.token.length < 32) {
    cfg.token = crypto.randomBytes(24).toString('base64url');
    changed = true;
  }
  if (!Number.isInteger(cfg.port)) {
    cfg.port = DEFAULT_PORT;
    changed = true;
  }
  // With an empty extensionId any chrome-extension:// origin is accepted (the token is still required).
  if (!('extensionId' in cfg)) {
    cfg.extensionId = null;
    changed = true;
  }
  // The archive folder and the archivist session's name (left-click "save" goes here).
  if (typeof cfg.archiveDir !== 'string') {
    cfg.archiveDir = path.join(os.homedir(), 'x-archive');
    changed = true;
  }
  if (typeof cfg.archivistName !== 'string') {
    cfg.archivistName = 'x-archive';
    changed = true;
  }
  // Jev (optional): at or above this category confidence the note is written directly; below it, the archivist decides.
  if (typeof cfg.jevThreshold !== 'number') {
    cfg.jevThreshold = 0.85;
    changed = true;
  }
  // Jev's key (OPENROUTER_API_KEY or TYPESAFE_API_KEY) is read from this file and never written to config.json.
  if (!('jevEnvFile' in cfg)) {
    cfg.jevEnvFile = path.join(baseDir(), 'jev.env');
    changed = true;
  }
  // Topic notices, as { name, topic, threshold } routes: if Jev rates a saved post at or above threshold, the session called name is told.
  if (!Array.isArray(cfg.notifyRoutes)) {
    cfg.notifyRoutes = [];
    changed = true;
  }
  // When a post reaches the queue while the archivist is closed, the relay wakes it with `claude -p` in the background.
  if (typeof cfg.archivistWake !== 'object' || cfg.archivistWake === null) {
    cfg.archivistWake = { enabled: true, claudePath: defaultClaudePath(), model: null };
    changed = true;
  }
  // "New session" in the right-click menu: a new Code session in Claude Desktop for a post. Code sessions need a folder,
  // so post discussions use an empty folder of their own.
  if (typeof cfg.newSession !== 'object' || cfg.newSession === null) {
    cfg.newSession = { enabled: true, dir: path.join(os.homedir(), 'x-chats'), model: null };
    changed = true;
  }
  // Inbox priority: "now" | "next" | "later". If empty, Claude Code's default ("next") applies.
  if (!('priority' in cfg)) {
    cfg.priority = null;
    changed = true;
  } else if (cfg.priority !== null && !['now', 'next', 'later'].includes(cfg.priority)) {
    throw new Error(`config.json: invalid priority "${cfg.priority}" (use now, next, later or null)`);
  }
  if (changed) {
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  }
  return cfg;
}

// Reads only the keys Jev needs from a .env file; doesn't touch process.env.
const JEV_KEYS = ['OPENROUTER_API_KEY', 'TYPESAFE_API_KEY', 'JEV_MODEL'];
export function loadJevEnv(file) {
  const env = {};
  for (const k of JEV_KEYS) if (process.env[k]) env[k] = process.env[k];
  if (!file) return env;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return env;
  }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && JEV_KEYS.includes(m[1]) && !env[m[1]]) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

// `npm run token`: prints the values to paste into the extension's settings.
// `npm run extension:config`: writes the same values to extension/relay.json, where the extension reads its token.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  const relayUrl = `http://127.0.0.1:${cfg.port}/`;
  if (process.argv.includes('--write-extension')) {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'relay.json');
    fs.writeFileSync(file, JSON.stringify({ relayUrl, token: cfg.token }, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    console.log(`Wrote: ${file}`);
    console.log('If the extension is already loaded, reload it from the extensions page.');
  } else {
    console.log(`Relay URL: ${relayUrl}`);
    console.log(`Token:     ${cfg.token}`);
  }
}
