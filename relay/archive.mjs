// Arşiv tarafı: kaydetme kuyruğu (gelen/kuyruk.jsonl), kayıtlı gönderi sorgusu ve arşivci oturumunun bulunması.
// Kuyruk, arşivci oturumu kapalıyken de kayıt kaybolmasın diye vardır; arşivci açılınca notu olmayan satırları işler.
import fs from 'node:fs';
import path from 'node:path';
import { statusId } from './format.mjs';
import { readCategories, renderEntries, normalize } from '../scripts/render-archive.mjs';

const CACHE_MS = 3_000;

export function createArchive({ dir, archivistName }) {
  const queueFile = path.join(dir, 'gelen', 'kuyruk.jsonl');
  let cache = null;

  function scan() {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.ids;
    const ids = new Set();
    const lib = path.join(dir, 'kutuphane');
    try {
      for (const cat of fs.readdirSync(lib, { withFileTypes: true })) {
        if (!cat.isDirectory()) continue;
        for (const f of fs.readdirSync(path.join(lib, cat.name))) {
          const m = /-(\d{1,25})\.md$/.exec(f);
          if (m) ids.add(m[1]);
        }
      }
    } catch {}
    try {
      for (const line of fs.readFileSync(queueFile, 'utf8').split('\n')) {
        const id = /"id":"(\d{1,25})"/.exec(line)?.[1];
        if (id) ids.add(id);
      }
    } catch {}
    cache = { at: Date.now(), ids };
    return ids;
  }

  return {
    dir,

    // Kuyrukta olup kütüphanede notu olmayan kimlikler (arşivciyi bekleyenler). Önbelleksiz.
    pendingIds() {
      const notes = new Set();
      try {
        for (const cat of fs.readdirSync(path.join(dir, 'kutuphane'), { withFileTypes: true })) {
          if (!cat.isDirectory()) continue;
          for (const f of fs.readdirSync(path.join(dir, 'kutuphane', cat.name))) {
            const m = /-(\d{1,25})\.md$/.exec(f);
            if (m) notes.add(m[1]);
          }
        }
      } catch {}
      const pending = new Set();
      try {
        for (const line of fs.readFileSync(queueFile, 'utf8').split('\n')) {
          const id = /"id":"(\d{1,25})"/.exec(line)?.[1];
          if (id && !notes.has(id)) pending.add(id);
        }
      } catch {}
      return [...pending];
    },

    savedIds(ids) {
      const all = scan();
      return ids.filter((id) => all.has(id));
    },

    // Kuyruğa ekler. Zaten arşivde ya da kuyruktaysa eklemez.
    enqueue(post, { now = new Date() } = {}) {
      const id = statusId(post.url);
      if (scan().has(id)) return { id, already: true };
      fs.mkdirSync(path.dirname(queueFile), { recursive: true });
      const rec = { id, ...post, source: 'buton', savedAt: now.toISOString() };
      fs.appendFileSync(queueFile, JSON.stringify(rec) + '\n', { mode: 0o600 });
      cache?.ids.add(id);
      return { id, already: false };
    },

    categories() {
      return readCategories(dir);
    },

    // jev'e verilecek içerik: kuyruk satırıyla aynı biçim.
    contentOf(post) {
      return normalize({ id: statusId(post.url), ...post, source: 'buton' });
    },

    // jev'in yüksek güvenli kararını not olarak yazar ve plan/jev-<tarih>.jsonl dosyasına iz bırakır.
    writeJevNote(id, verdict, { now = new Date() } = {}) {
      const entry = { id, kategori: verdict.choice, etiketler: [], ozet: '', guven: 'yuksek', karar: 'jev', jevGuven: verdict.confidence };
      const planDir = path.join(dir, 'plan');
      fs.mkdirSync(planDir, { recursive: true });
      fs.appendFileSync(path.join(planDir, `jev-${now.toISOString().slice(0, 10)}.jsonl`), JSON.stringify(entry) + '\n');
      const r = renderEntries(dir, [entry], { now: now.toISOString(), source: 'relay' });
      cache = null;
      if (r.hatalar.length) throw new Error(r.hatalar.join('; '));
      return r.notlar[0];
    },

    logNotification(rec) {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'bildirimler.jsonl'), JSON.stringify(rec) + '\n');
    },

    // Arşivci: çalışma klasörü arşiv klasörü olan yaşayan oturum. Yalnız ada güvenilmez: aynı adla
    // başka klasörde açılmış bir oturum (ör. cd başarısız olunca) kayıtları yanlış yere alırdı.
    // Aynı klasörde birden çok oturum varsa archivistName adını taşıyan tercih edilir.
    findArchivist(sessions) {
      let real = dir;
      try {
        real = fs.realpathSync(dir);
      } catch {}
      const here = sessions.filter((s) => s.cwd === dir || s.cwd === real);
      return here.find((s) => s.name === archivistName) ?? here[0] ?? null;
    },
  };
}
