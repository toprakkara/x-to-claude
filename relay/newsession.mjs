// Sağ tık menüsündeki "Yeni oturum": gönderi için Claude Desktop'ta yeni bir Code oturumu açar.
// Code oturumları bir klasör ister; gönderi sohbetleri için ayrılmış boş bir klasör kullanılır (dir).
//   1) claude -p <gönderi> --session-id <uuid> --tools ""   ilk tur arka planda; araçlar kapalı, çünkü
//      gönderi güvenilmez veri. Claude özetleyip kullanıcıya ne yapmak istediğini sorar.
//   2) open claude://resume?session=<uuid>                   oturum Desktop'ta açılır; kullanıcı devam eder.
//      `claude --desktop --resume` de aynı bağlantıyı açar ama terminal ister (relay arka planda çalışıyor).
//      Bağlantı biçimi Claude Code 2.1.290'daki --desktop işleyicisinden alındı.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { formatMessage } from './format.mjs';

export class SessionOpenError extends Error {}

export function sessionName(post) {
  const who = post.author?.handle ? `@${post.author.handle}` : 'gönderi';
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
        log(`ilk tur başarısız (${id}): çıkış ${first.code}: ${first.out.slice(-300)}`);
        throw new SessionOpenError('yeni oturumun ilk turu başarısız oldu');
      }
      const open = await run(openCommand, [resumeLink(id)], 30_000);
      if (open.code !== 0) {
        log(`Desktop'ta açılamadı (${id}): çıkış ${open.code}: ${open.out.slice(-300)}`);
        throw new SessionOpenError('oturum oluşturuldu ama Claude Desktop\'ta açılamadı');
      }
      log(`açıldı: ${id} "${name}" (${post.url})`);
      return { id, name };
    },
  };
}
