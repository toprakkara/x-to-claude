// Claude CLI girişi. Relay'in başlattığı `claude -p` süreçleri (yeni oturum, arşivci uyandırma) CLI'nin kendi girişini
// kullanır. Desktop oturumları girişini ayrı yönettiği için CLI girişi düşünce Desktop çalışmaya devam eder, bu işler durur.
//   status()  `claude auth status`: { loggedIn: true | false | null (anlaşılamadı), running }
//   start()   `claude auth login`: tarayıcıda giriş sayfasını açar ve dönüşü bekler; terminal gerekmez.
//             Zaten çalışıyorsa eskisini kapatıp yeniden başlatır: kullanıcı sayfayı kapatmış olabilir.
// Komutlar sabittir; dışarıdan argüman almaz.
import fs from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';

// Metinler Claude Code 2.1.290 ve 2.1.317 ikili dosyalarından alındı. Yalnız çıkış kodu sıfır değilse ve çıktının
// sonuna bakılır: gönderi metni ya da Claude'un yanıtı bu sözleri içerebilir.
const LOGIN_FAILURE = /failed to authenticate|not logged in|please run \/login/i;
export const isLoginFailure = (output) => LOGIN_FAILURE.test((output ?? '').slice(-500));

export function createClaudeLogin({ claudePath, env, cwd, logFile, onLogin = () => {}, spawn = nodeSpawn, timeoutMs = 5 * 60_000 }) {
  let child = null;

  const log = (line) => {
    if (!logFile) return;
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
    } catch {}
  };

  function status() {
    if (child) return Promise.resolve({ loggedIn: false, running: true });
    return new Promise((resolve) => {
      let out = '';
      const p = spawn(claudePath, ['auth', 'status'], { cwd, env, stdio: ['ignore', 'pipe', 'ignore'] });
      const timer = setTimeout(() => p.kill('SIGTERM'), 15_000);
      timer.unref?.();
      p.stdout?.on('data', (d) => (out += d));
      const finish = () => {
        clearTimeout(timer);
        let loggedIn = null;
        try {
          const value = JSON.parse(out).loggedIn;
          if (typeof value === 'boolean') loggedIn = value;
        } catch {}
        resolve({ loggedIn, running: false });
      };
      p.on('error', finish);
      p.on('close', finish);
    });
  }

  function start() {
    child?.kill('SIGTERM');
    let out = '';
    let finished = false;
    const p = spawn(claudePath, ['auth', 'login'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child = p;
    log('giriş başlatıldı');
    const timer = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
    timer.unref?.();
    p.stdout?.on('data', (d) => (out += d));
    p.stderr?.on('data', (d) => (out += d));
    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (child === p) child = null;
      if (code === 0) {
        log('giriş tamamlandı');
        onLogin();
      } else {
        // Giriş bağlantısının sorgu kısmı (state, code_challenge) kayda geçmez.
        log(`giriş tamamlanmadı: çıkış ${code}: ${out.replace(/\?\S*/g, '?…').trim().slice(-200)}`);
      }
    };
    p.on('error', (e) => {
      out += e.message;
      finish(-1);
    });
    p.on('close', finish);
  }

  return { status, start };
}
