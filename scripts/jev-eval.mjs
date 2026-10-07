#!/usr/bin/env node
// Jev'in kategori seçimlerini arşivcinin (Claude) plan etiketleriyle karşılaştırır. Arşiv klasöründen çalıştır:
//   node jev-eval.mjs plan/<ad>.jsonl [--concurrency 4] [--out <sonuç.jsonl>]
// Anahtar ortamdan gelir (OPENROUTER_API_KEY ya da TYPESAFE_API_KEY); ekrana ya da dosyaya yazılmaz.
import fs from 'node:fs';
import path from 'node:path';
import { readCategories, loadContent } from './render-archive.mjs';
import { judgeTweet, NEW_CATEGORY } from '../relay/jev.mjs';

import { loadConfig } from '../relay/config.mjs';

// Method Path ilgi sorusunun ölçümü: Claude'un hukuk kategorileri (bölmeden önce "hukuk-teknolojisi") olumlu örnek sayılır.
// Konu tanımı relay yapılandırmasından gelir; --topic ile yapılandırmaya dokunmadan başka bir tanım denenebilir.
const LEGAL_ROUTE = { ...(loadConfig().notifyRoutes ?? []).find((r) => r.name === 'Method Path') };

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const planFile = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (opt('topic')) LEGAL_ROUTE.topic = opt('topic'); // bildirim konu tanımını yapılandırmaya dokunmadan denemek için
if (!planFile) {
  console.error('Kullanım: node jev-eval.mjs plan/<ad>.jsonl [--concurrency 4] [--out sonuc.jsonl]');
  process.exit(2);
}

const root = fs.realpathSync(process.cwd());
const categories = readCategories(root);
const content = loadContent(root);
const labels = fs.readFileSync(path.resolve(root, planFile), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const items = labels.filter((l) => content.get(l.id)?.available);
const skipped = labels.length - items.length;

const results = [];
let next = 0;
async function worker() {
  while (next < items.length) {
    const label = items[next++];
    const t0 = Date.now();
    try {
      const r = await judgeTweet(content.get(label.id), categories, [LEGAL_ROUTE]);
      results.push({ id: label.id, claude: label.kategori, claudeGuven: label.guven ?? 'yuksek', jev: r.choice, confidence: r.confidence, top: r.top, legalP: r.relevance[0].p, ms: Date.now() - t0, model: r.model });
    } catch (e) {
      results.push({ id: label.id, claude: label.kategori, error: e.message });
    }
  }
}
await Promise.all(Array.from({ length: Number(opt('concurrency', 4)) }, worker));

const ok = results.filter((r) => !r.error);
const agree = ok.filter((r) => r.jev === r.claude);
const fmt = (x) => (x == null ? '-' : x.toFixed(2));
console.log(`Model: ${ok[0]?.model ?? '-'}   Değerlendirilen: ${ok.length}   Hata: ${results.length - ok.length}   İçeriksiz (atlandı): ${skipped}`);
console.log(`Uyum (jev = claude): ${agree.length}/${ok.length} (%${Math.round((100 * agree.length) / Math.max(ok.length, 1))})`);
console.log(`"${NEW_CATEGORY}" seçimi: ${ok.filter((r) => r.jev === NEW_CATEGORY).length}`);
for (const th of [0.5, 0.7, 0.85]) {
  const above = ok.filter((r) => (r.confidence ?? 0) >= th && r.jev !== NEW_CATEGORY);
  const aboveAgree = above.filter((r) => r.jev === r.claude);
  console.log(`Güven ≥ ${th}: ${above.length} gönderi, bunların ${aboveAgree.length}'i uyumlu (%${Math.round((100 * aboveAgree.length) / Math.max(above.length, 1))})`);
}
const LEGAL = new Set(['hukuk-teknolojisi', 'turkiye-hukuk-teknolojisi', 'global-hukuk-yapay-zekasi']);
const pos = ok.filter((r) => LEGAL.has(r.claude)).map((r) => r.legalP).sort((a, b) => a - b);
const neg = ok.filter((r) => !LEGAL.has(r.claude)).map((r) => r.legalP).sort((a, b) => a - b);
console.log(`\nMethod Path ilgi (noul): hukuk-teknolojisi ${pos.length} gönderi → ${pos.map(fmt).join(' ')}`);
console.log(`  diğer ${neg.length} gönderi, en yüksek 8 → ${neg.slice(-8).map(fmt).join(' ')}`);
for (const th of [0.5, 0.7, 0.8, 0.9]) console.log(`  eşik ${th}: yakalanan ${pos.filter((p) => p >= th).length}/${pos.length}, yanlış alarm ${neg.filter((p) => p >= th).length}/${neg.length}`);
const ms = ok.map((r) => r.ms).sort((a, b) => a - b);
console.log(`Gecikme medyan: ${ms[Math.floor(ms.length / 2)] ?? '-'} ms`);
console.log('\nUyuşmayanlar (id | claude → jev | güven | jev ilk 3):');
for (const r of ok.filter((r) => r.jev !== r.claude)) {
  console.log(`  ${r.id} | ${r.claude}${r.claudeGuven === 'dusuk' ? ' (claude düşük)' : ''} → ${r.jev} | ${fmt(r.confidence)} | ${r.top.map(([k, p]) => `${k}:${fmt(p)}`).join(' ')}`);
}
for (const r of results.filter((r) => r.error)) console.log(`  HATA ${r.id}: ${r.error}`);
const out = opt('out');
if (out) fs.writeFileSync(out, results.map((r) => JSON.stringify(r)).join('\n') + '\n');
