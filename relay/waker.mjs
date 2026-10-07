// Arşivci kapalıyken kuyruğa düşen kayıtlar için arşivciyi arka planda, pencere açmadan çalıştırır:
// `claude -p` arşiv klasöründe kuyruğu işler ve çıkar. Kalıcı bir oturum ya da açık sekme gerekmez.
// - pendingIds() boş değilse ve isArchivistAlive() yanlışsa çalışır; args(ids) komut satırını kurar.
// - Art arda istekler debounceMs içinde tek uyandırmaya iner; çalışırken gelen istek bittikten sonra bir tur daha açar.
// - Başarısız çalıştırmadan sonra retryMs boyunca yeni uyandırma yapılmaz (döngüye girip harcama yapmasın).
// - timeoutMs aşılırsa süreç sonlandırılır.
import fs from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';

// Bekleyen kimlikler mesaja yazılır: arşivci kütüphaneyi tarayıp notu olmayanları aramak zorunda kalmaz.
export function wakePrompt(ids) {
  return [
    '[x-to-claude] UYANDIRMA: Arşivci oturumu kapalıyken arşiv kuyruğuna gönderi düştü; relay seni arka planda çalıştırdı.',
    `Kütüphanede notu olmayan kayıtlar (gelen/kuyruk.jsonl içinde, kimliğe göre): ${ids.join(', ')}.`,
    'Bunları CLAUDE.md\'deki akışla sınıflandır: plan dosyasına yaz, not yazıcıyı çalıştır ve gunluk.md\'ye bir satır ekle.',
    'Bildirim gönderme; bildirimleri relay yaptı.',
    'Bu bir arka plan çalıştırması: soru sorma, kullanıcı onayı gerektiren işlere (kategori bölme gibi) girişme.',
    'Bitince yaptıklarını iki üç satırda özetle ve çık.',
  ].join(' ');
}

export function createWaker({
  cwd,
  command,
  args,
  env,
  pendingIds,
  isArchivistAlive,
  logFile,
  debounceMs = 10_000,
  timeoutMs = 15 * 60_000,
  retryMs = 30 * 60_000,
  spawn = nodeSpawn,
  now = Date.now,
}) {
  let timer = null;
  let child = null;
  let again = false;
  let blockedUntil = 0;
  const runs = [];

  const log = (line) => {
    if (!logFile) return;
    try {
      fs.appendFileSync(logFile, `${new Date(now()).toISOString()} ${line}\n`);
    } catch {}
  };

  function start(reason) {
    timer = null;
    const ids = pendingIds();
    if (!ids.length) return;
    if (isArchivistAlive()) return log(`uyandırma gerekmedi: arşivci açık (${reason})`);
    if (now() < blockedUntil) return log(`uyandırma ertelendi: önceki çalıştırma başarısızdı (${reason})`);

    log(`uyandırılıyor: ${ids.length} bekleyen kayıt (${reason})`);
    const startedAt = now();
    child = spawn(command, typeof args === 'function' ? args(ids) : args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    const kill = setTimeout(() => child?.kill('SIGTERM'), timeoutMs);
    kill.unref?.(); // süre sınırı zamanlayıcısı relay'in (ya da testin) kapanmasını engellemesin
    let finished = false;
    const finish = (code) => {
      if (finished) return; // spawn hatasında hem 'error' hem 'close' gelebilir
      finished = true;
      clearTimeout(kill);
      child = null;
      const ok = code === 0;
      runs.push({ startedAt, ok, code });
      log(`arşivci bitti: çıkış ${code}, ${Math.round((now() - startedAt) / 1000)} sn${out.trim() ? `\n  ${out.trim().split('\n').slice(-6).join('\n  ')}` : ''}`);
      if (!ok) blockedUntil = now() + retryMs;
      if (again && ok) {
        again = false;
        request('çalışırken gelen kayıt');
      }
    };
    child.on('error', (e) => {
      out += `başlatılamadı: ${e.message}`;
      finish(-1);
    });
    child.on('close', finish);
  }

  function request(reason = 'kayıt') {
    if (child) {
      again = true;
      return;
    }
    if (timer) return;
    timer = setTimeout(() => start(reason), debounceMs);
  }

  return {
    request,
    get running() {
      return !!child;
    },
    runs,
  };
}
