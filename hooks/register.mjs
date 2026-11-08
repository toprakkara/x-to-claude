#!/usr/bin/env node
// SessionStart hook: records the session in ~/.x-to-claude/sessions/<session_id>.json.
// The token isn't stored; the relay isn't a child of the session, so it couldn't use it anyway.
// The hook must never disturb the session: every error is swallowed and the exit code is 0.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

try {
  const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const ev = JSON.parse(raw || '{}');

  if (socket && typeof ev.session_id === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(ev.session_id)) {
    const dir = path.join(process.env.X2C_HOME || path.join(os.homedir(), '.x-to-claude'), 'sessions');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const sockPid = Number(path.basename(socket, '.sock'));
    const pid = Number(process.env.CLAUDE_PID) || (Number.isInteger(sockPid) && sockPid > 0 ? sockPid : null);
    const rec = {
      sessionId: ev.session_id,
      socket,
      pid,
      name: ev.session_title || path.basename(ev.cwd || '') || null,
      cwd: ev.cwd ?? null,
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
      source: ev.source ?? null,
      registeredAt: Date.now(),
    };

    // /clear and resume create a new session_id on the same socket, so remove older records on that socket.
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f === `${rec.sessionId}.json`) continue;
      try {
        if (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).socket === socket) fs.rmSync(path.join(dir, f), { force: true });
      } catch {}
    }

    const file = path.join(dir, `${rec.sessionId}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
} catch {}
process.exit(0);
