// Oturum kaydı: SessionStart hook'unun ~/.x-to-claude/sessions/<id>.json dosyalarına yazdığı kayıtları okur.
// Ölü kayıtları (soket yok ya da süreç bitmiş) siler.
import fs from 'node:fs';
import path from 'node:path';
import { sessionsDir } from './config.mjs';

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

// Yaşayan oturumların tam kayıtları (soket yolu dahil). Aynı sokete düşen birden çok kayıttan en yenisi kalır.
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
  return [...bySocket.values()].sort((a, b) => (b.registeredAt ?? 0) - (a.registeredAt ?? 0));
}

// Eklentiye giden görünüm: soket yolu ve pid dışarı çıkmaz.
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
