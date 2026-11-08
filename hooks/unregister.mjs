#!/usr/bin/env node
// SessionEnd hook: deletes the session's record. SessionEnd has a short time budget (about 1.5 s), so it does the minimum.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

try {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const { session_id: id } = JSON.parse(raw || '{}');
  if (typeof id === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(id)) {
    const dir = path.join(process.env.X2C_HOME || path.join(os.homedir(), '.x-to-claude'), 'sessions');
    fs.rmSync(path.join(dir, `${id}.json`), { force: true });
  }
} catch {}
process.exit(0);
