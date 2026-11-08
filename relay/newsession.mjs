// "New session" in the right-click menu: opens a new Code session in Claude Desktop for a post.
// Code sessions need a folder, so post discussions use an empty folder of their own (dir).
//   1) claude -p <post> --session-id <uuid> --tools ""      the first turn runs in the background with tools off, because
//      the post is untrusted data. Claude summarizes it and asks the user what they want to do with it.
//   2) open claude://resume?session=<uuid>                  the session opens in Desktop and the user carries on.
//      `claude --desktop --resume` opens the same link but needs a terminal, and the relay runs in the background.
//      The link format comes from the --desktop handler in Claude Code 2.1.290.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { formatMessage } from './format.mjs';
import { isLoginFailure } from './claudelogin.mjs';

// code: lets the extension react to specific errors ('claude-login' shows the sign-in prompt).
export class SessionOpenError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function sessionName(post) {
  const who = post.author?.handle ? `@${post.author.handle}` : 'post';
  const words = (post.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return `X: ${who}${words ? ` — ${words}` : ''}`.slice(0, 70);
}

export const resumeLink = (id) => `claude://resume?session=${encodeURIComponent(id)}`;

export function createSessionOpener({ dir, claudePath, env, model = null, logFile, spawn = nodeSpawn, uuid = () => crypto.randomUUID(), openCommand = '/usr/bin/open' }) {
  const log = (line) => {
    if (!logFile) return;
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
    } catch {}
  };

  function run(command, args, timeoutMs) {
    return new Promise((resolve) => {
      let out = '';
      let done = false;
      const child = spawn(command, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const finish = (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code, out: out.trim() });
      };
      child.stdout?.on('data', (d) => (out += d));
      child.stderr?.on('data', (d) => (out += d));
      child.on('error', (e) => {
        out += e.message;
        finish(-1);
      });
      child.on('close', finish);
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
      timer.unref?.();
    });
  }

  return {
    async open(post) {
      fs.mkdirSync(dir, { recursive: true });
      const id = uuid();
      const name = sessionName(post);
      const prompt = formatMessage([post], { intent: 'discuss' });

      const first = await run(claudePath, ['-p', prompt, '--session-id', id, '--name', name, '--tools', '', '--strict-mcp-config', ...(model ? ['--model', model] : [])], 180_000);
      if (first.code !== 0) {
        log(`first turn failed (${id}): exit ${first.code}: ${first.out.slice(-300)}`);
        if (isLoginFailure(first.out)) throw new SessionOpenError('Claude login expired', 'claude-login');
        // The path stays in the log: this message is shown on the x.com page.
        if (first.code === -1 && /ENOENT/.test(first.out)) throw new SessionOpenError('Claude Code wasn\'t found. Set archivistWake.claudePath in ~/.x-to-claude/config.json.');
        throw new SessionOpenError('the first turn of the new session failed');
      }
      const open = await run(openCommand, [resumeLink(id)], 30_000);
      if (open.code !== 0) {
        log(`could not open in Desktop (${id}): exit ${open.code}: ${open.out.slice(-300)}`);
        throw new SessionOpenError('the session was created but could not be opened in Claude Desktop');
      }
      log(`opened: ${id} "${name}" (${post.url})`);
      return { id, name };
    },
  };
}
