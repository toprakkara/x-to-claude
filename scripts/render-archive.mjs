#!/usr/bin/env node
// Arşivcinin sınıflandırma planından kütüphane notlarını yazar. Arşiv klasöründe (cwd) çalışır:
//   node render-archive.mjs plan/<ad>.jsonl [plan/<ad2>.jsonl ...]
// Plan satırı: {"id":"…","kategori":"slug","etiketler":["…"],"ozet":"…","guven":"yuksek|dusuk"}
// İçerik gelen/*.jsonl dosyalarından kimlikle bulunur. Not: kutuphane/<kategori>/<tarih>-<kullanıcı>-<id>.md
// Aynı kimlikli not başka yerdeyse taşınır (kategori değişikliği). Her çalıştırmada kutuphane/_indeks.md yenilenir.
// Arşivci oturumu bu betiği çalıştırma iznine sahiptir; betik cwd dışına yazmaz.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID = /^\d{1,25}$/;

const readJsonl = (f) =>
  fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new Error(`${f}:${i + 1} geçersiz JSON`);
      }
    });

function inside(root, p) {
  const r = path.resolve(root, p);
  if (r !== root && !r.startsWith(root + path.sep)) throw new Error(`arşiv klasörü dışında: ${p}`);
  return r;
}

// kategoriler.md: "- slug — açıklama" satırları
export function readCategories(root) {
  const f = path.join(root, 'kategoriler.md');
  if (!fs.existsSync(f)) return new Map();
  const map = new Map();
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/^- ([a-z0-9-]+)\s+[—-]\s+(.+)$/gm)) map.set(m[1], m[2].trim());
  return map;
}

// İki kaynak biçimini (DM içe aktarması/oEmbed ve buton) tek biçime çevirir.
export function normalize(rec) {
  const o = rec.oembed;
  if (o) {
    return {
      id: rec.id,
      url: rec.url,
      handle: rec.handle ?? o.author?.handle ?? null,
      name: o.author?.name ?? null,
      date: o.date ?? null,
      text: o.status === 200 ? o.text : null,
      links: o.links ?? [],
      media: [],
      hasMedia: !!o.hasMedia,
      quoted: null,
      truncated: false,
      source: rec.source ?? 'ice-aktarma',
      sharedBy: rec.sharedBy ?? null,
      sharedAt: rec.firstSharedAt ?? null,
      savedAt: rec.fetchedAt ?? null,
      available: o.status === 200,
    };
  }
  return {
    id: rec.id,
    url: rec.url,
    handle: rec.author?.handle ?? null,
    name: rec.author?.name ?? null,
    date: rec.time ? rec.time.slice(0, 10) : null,
    text: rec.text ?? '',
    links: rec.links ?? [],
    media: rec.media ?? [],
    hasMedia: (rec.media ?? []).length > 0,
    quoted: rec.quoted ?? null,
    truncated: !!rec.truncated,
    source: rec.source ?? 'buton',
    sharedBy: null,
    sharedAt: null,
    savedAt: rec.savedAt ?? null,
    available: true,
  };
}

export function loadContent(root) {
  const dir = path.join(root, 'gelen');
  const byId = new Map();
  if (!fs.existsSync(dir)) return byId;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    for (const rec of readJsonl(path.join(dir, f))) if (rec?.id && ID.test(rec.id)) byId.set(rec.id, normalize(rec));
  }
  return byId;
}

export function findNotes(root) {
  const lib = path.join(root, 'kutuphane');
  const byId = new Map();
  if (!fs.existsSync(lib)) return byId;
  for (const cat of fs.readdirSync(lib, { withFileTypes: true })) {
    if (!cat.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(lib, cat.name))) {
      const m = /-(\d{1,25})\.md$/.exec(f);
      if (m) byId.set(m[1], path.join(lib, cat.name, f));
    }
  }
  return byId;
}

const y = (v) => JSON.stringify(v); // JSON dizesi geçerli YAML'dir
const quote = (t) => t.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');

export function renderNote(c, plan, now) {
  const fm = [
    '---',
    `id: ${y(c.id)}`,
    `url: ${c.url}`,
    `yazar: ${y(c.name ?? '')}`,
    `kullanici: ${y(c.handle ?? '')}`,
    `tarih: ${c.date ?? ''}`,
    `kategori: ${plan.kategori}`,
    `etiketler: ${y(plan.etiketler ?? [])}`,
    `ozet: ${y(plan.ozet ?? '')}`,
    `guven: ${plan.guven === 'dusuk' ? 'dusuk' : 'yuksek'}`,
    `karar: ${['jev', 'kural'].includes(plan.karar) ? plan.karar : 'arsivci'}`,
    ...(typeof plan.jevGuven === 'number' ? [`jev_guven: ${plan.jevGuven.toFixed(2)}`] : []),
    `kaynak: ${c.source}`,
    ...(c.sharedBy ? [`paylasan: ${y(c.sharedBy)}`, `paylasim: ${c.sharedAt ?? ''}`] : []),
    `kaydedildi: ${now}`,
    `medya: ${c.hasMedia}`,
    '---',
    '',
  ];
  const body = [];
  if (!c.available) body.push('_İçerik alınamadı: gönderi silinmiş ya da hesap gizli olabilir._');
  else {
    body.push(quote(c.text || '(metin yok)'));
    if (c.truncated) body.push('', '_Metin X arayüzünde kısaltılmıştı; tamamı bağlantıda._');
  }
  if (c.quoted) {
    const qa = c.quoted.author ? `${c.quoted.author.name ?? ''} (@${c.quoted.author.handle ?? '?'})` : '';
    body.push('', `**Alıntılanan gönderi** ${qa}${c.quoted.url ? ` — ${c.quoted.url}` : ''}`, '', quote(c.quoted.text || '(metin yok)'));
  }
  if (c.links.length) body.push('', '**Bağlantılar**', ...c.links.map((l) => `- ${l}`));
  if (c.media.length) body.push('', '**Medya**', ...c.media.map((m) => `- ${m}`));
  body.push('', `[X'te aç](${c.url})`, '');
  return fm.join('\n') + body.join('\n');
}

function writeIndex(root, categories) {
  const notes = findNotes(root);
  const counts = new Map();
  for (const p of notes.values()) {
    const cat = path.basename(path.dirname(p));
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  const lines = ['# Kütüphane dizini', '', `Toplam ${notes.size} gönderi. Bu dosya her çalıştırmada yeniden üretilir.`, '', '| Kategori | Gönderi | Açıklama |', '|---|---|---|'];
  for (const [cat, n] of [...counts].sort((a, b) => b[1] - a[1])) lines.push(`| [${cat}](${cat}/) | ${n} | ${categories.get(cat) ?? '—'} |`);
  fs.writeFileSync(path.join(root, 'kutuphane', '_indeks.md'), lines.join('\n') + '\n');
}

// Plan girdilerini (nesne) notlara çevirir. Relay doğrudan bunu çağırır; CLI plan dosyalarını okuyup buraya verir.
export function renderEntries(root, entries, { now = new Date().toISOString(), source = 'plan' } = {}) {
  const categories = readCategories(root);
  const content = loadContent(root);
  const existing = findNotes(root);
  const result = { yazilan: 0, tasinan: 0, hatalar: [], notlar: [] };

  for (const plan of entries) {
    const where = `${source} id=${plan?.id}`;
    if (!ID.test(plan?.id ?? '')) { result.hatalar.push(`${where}: geçersiz id`); continue; }
    if (!SLUG.test(plan.kategori ?? '')) { result.hatalar.push(`${where}: kategori slug olmalı (küçük harf, rakam, tire)`); continue; }
    if (!categories.has(plan.kategori)) { result.hatalar.push(`${where}: "${plan.kategori}" kategoriler.md'de yok; önce ekle`); continue; }
    if (plan.etiketler && (!Array.isArray(plan.etiketler) || !plan.etiketler.every((t) => SLUG.test(t)))) { result.hatalar.push(`${where}: etiketler slug dizisi olmalı`); continue; }
    const c = content.get(plan.id);
    if (!c) { result.hatalar.push(`${where}: gelen/*.jsonl içinde bu kimlik yok`); continue; }

    const handle = (c.handle ?? 'bilinmiyor').toLowerCase().replace(/[^a-z0-9_]/g, '');
    const target = path.join(root, 'kutuphane', plan.kategori, `${c.date ?? 'tarihsiz'}-${handle}-${c.id}.md`);
    const old = existing.get(plan.id);
    if (old && old !== target) {
      fs.rmSync(old, { force: true });
      result.tasinan++;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, renderNote(c, plan, now));
    existing.set(plan.id, target);
    result.yazilan++;
    result.notlar.push(path.relative(root, target));
  }
  fs.mkdirSync(path.join(root, 'kutuphane'), { recursive: true });
  writeIndex(root, categories);
  return result;
}

export function render(root, planFiles, opts = {}) {
  const total = { yazilan: 0, tasinan: 0, hatalar: [] };
  for (const pf of planFiles) {
    const r = renderEntries(root, readJsonl(inside(root, pf)), { ...opts, source: pf });
    total.yazilan += r.yazilan;
    total.tasinan += r.tasinan;
    total.hatalar.push(...r.hatalar);
  }
  return total;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const plans = process.argv.slice(2);
  if (!plans.length) {
    console.error('Kullanım: node render-archive.mjs plan/<ad>.jsonl [...]  (arşiv klasöründen çalıştır)');
    process.exit(2);
  }
  try {
    const r = render(fs.realpathSync(process.cwd()), plans);
    console.log(`Yazılan: ${r.yazilan}, taşınan: ${r.tasinan}, hata: ${r.hatalar.length}`);
    for (const h of r.hatalar) console.log(`HATA ${h}`);
    process.exit(r.hatalar.length ? 1 : 0);
  } catch (e) {
    console.error(`HATA ${e.message}`);
    process.exit(1);
  }
}
