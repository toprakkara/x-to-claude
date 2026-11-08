// Session registry: reads the records the SessionStart hook writes to ~/.x-to-claude/sessions/<id>.json.
// Removes dead records (socket gone or process ended).
import fs from 'node:fs';
import path from 'node:path';
import { sessionsDir, claudeSessionsDir } from './config.mjs';

function isLive(rec) {
  if (typeof rec?.sessionId !== 'string' || typeof rec?.socket !== 'string') return false;
  try {
    if (!fs.statSync(rec.socket).isSocket()) return false;
  } catch {
    return false;
  }
  if (Number.isInteger(rec.pid) && rec.pid > 0) {
    try {
      process.kill(rec.pid, 0);
    } catch (e) {
      if (e.code === 'ESRCH') return false;
    }
  }
  return true;
}

// The session's current title. The name the hook writes is a snapshot from when the session opened. A Desktop session
// gets its title later, so that name is usually just the folder. Claude Code keeps the name field of <pid>.json current
// (undocumented; verified on 2.1.290 and 2.1.317). Only this field is read; if it can't be read, the hook's name is used.
// PIDs get reused, so the session ID is checked too.
function currentName(rec) {
  if (!Number.isInteger(rec.pid) || rec.pid <= 0) return null;
  try {
    const peer = JSON.parse(fs.readFileSync(path.join(claudeSessionsDir(), `${rec.pid}.json`), 'utf8'));
    if (peer.sessionId !== rec.sessionId || typeof peer.name !== 'string') return null;
    return peer.name.trim() || null;
  } catch {
    return null;
  }
}

// Full records of live sessions, including the socket path. Of several records on the same socket, the newest wins.
export function liveSessions({ prune = true } = {}) {
  const dir = sessionsDir();
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const bySocket = new Map();
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(dir, f);
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      continue;
    }
    if (!isLive(rec)) {
      if (prune) fs.rmSync(p, { force: true });
      continue;
    }
    const prev = bySocket.get(rec.socket);
    if (!prev || (rec.registeredAt ?? 0) > (prev.registeredAt ?? 0)) bySocket.set(rec.socket, rec);
  }
  return [...bySocket.values()]
    .sort((a, b) => (b.registeredAt ?? 0) - (a.registeredAt ?? 0))
    .map((rec) => ({ ...rec, name: currentName(rec) ?? rec.name }));
}

// The view sent to the extension: the socket path and pid stay private.
export function publicView(rec) {
  return {
    id: rec.sessionId,
    name: rec.name || path.basename(rec.cwd || '') || rec.sessionId.slice(0, 8),
    cwd: rec.cwd ?? null,
    entrypoint: rec.entrypoint ?? null,
    registeredAt: rec.registeredAt ?? null,
  };
}

export function findSession(sessionId) {
  return liveSessions({ prune: false }).find((r) => r.sessionId === sessionId) ?? null;
}
