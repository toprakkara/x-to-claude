#!/usr/bin/env node
// İçe aktarılan tweet listesinin içeriğini X'in resmî oEmbed servisinden çeker (giriş gerekmez).
//   node scripts/fetch-oembed.mjs <girdi.jsonl> <çıktı.jsonl>
// Girdi satırları en az {id, url} içerir. Çıktıya her satır için girdi alanları + içerik yazılır.
// Kaldığı yerden devam eder: çıktıda zaten olan kimlikleri atlar. Saniyede ~1 istek.
// oEmbed metin, yazar ve gün hassasiyetinde tarih verir; medya bağlantısı vermez (yalnız pic.x.com kısa bağlantısı).
import fs from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('Kullanım: node scripts/fetch-oembed.mjs <girdi.jsonl> <çıktı.jsonl>');
  process.exit(2);
}

const DELAY_MS = 1_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ', mdash: '—' };
const decode = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z#0-9]+);/gi, (m, n) => ENTITIES[n] ?? m);

// oEmbed html'i: <blockquote><p>METİN</p>&mdash; Ad (@kullanıcı) <a href="...status/ID">Ay G, YYYY</a></blockquote>
export function parseOembed(json) {
  const html = json.html || '';
  const p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
  const links = [...p.matchAll(/<a href="([^"]+)"/g)].map((m) => decode(m[1])).filter((u) => !/^https:\/\/(x|twitter)\.com\/(hashtag\/|[^/]+\?ref_src)/.test(u));
  const text = decode(p.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')).trim();
  const tail = html.slice(html.lastIndexOf('</p>'));
  const dateText = /<a href="[^"]*status\/\d+[^"]*">([^<]+)<\/a>\s*<\/blockquote>/.exec(tail)?.[1] ?? null;
  const date = dateText && !Number.isNaN(Date.parse(dateText + ' UTC')) ? new Date(Date.parse(dateText + ' UTC')).toISOString().slice(0, 10) : null;
  const handle = /(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})$/.exec(json.author_url || '')?.[1] ?? null;
  return {
    author: { name: json.author_name ?? null, handle },
    text,
    date,
    links: [...new Set(links)],
    hasMedia: /pic\.(twitter|x)\.com\//.test(p),
  };
}

async function fetchOne(url) {
  const q = new URLSearchParams({ url, omit_script: '1', dnt: 'true' });
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://publish.x.com/oembed?${q}`, { redirect: 'follow' });
    if (res.status === 429 || res.status >= 500) {
      await sleep(15_000 * (attempt + 1));
      continue;
    }
    if (!res.ok) return { status: res.status };
    return { status: 200, ...parseOembed(await res.json()) };
  }
  return { status: 'retry-exhausted' };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const done = new Set(readJsonl(output).map((r) => r.id));
  const todo = readJsonl(input).filter((r) => !done.has(r.id));
  console.log(`${done.size} hazır, ${todo.length} çekilecek`);
  const out = fs.openSync(output, 'a', 0o600);
  let ok = 0, missing = 0;
  for (const [i, rec] of todo.entries()) {
    const content = await fetchOne(rec.url);
    if (content.status === 200) ok++;
    else missing++;
    const merged = { ...rec, fetchedAt: new Date().toISOString(), oembed: content };
    if (content.author?.handle) {
      merged.handle ??= content.author.handle;
      merged.url = `https://x.com/${merged.handle}/status/${rec.id}`;
    }
    fs.writeSync(out, JSON.stringify(merged) + '\n');
    if ((i + 1) % 25 === 0) console.log(`${i + 1}/${todo.length} (tamam ${ok}, erişilemeyen ${missing})`);
    await sleep(DELAY_MS);
  }
  fs.closeSync(out);
  console.log(`Bitti: tamam ${ok}, erişilemeyen ${missing}`);
}
