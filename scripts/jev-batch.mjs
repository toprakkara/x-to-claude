#!/usr/bin/env node
// Toplu içe aktarmayı jev ile sınıflandırır. Arşiv klasöründen çalıştır:
//   node jev-batch.mjs gelen/<ad>.jsonl --plan plan/<ad>-jev.jsonl --devret gelen/devret-<ad>.jsonl [--esik 0.85]
// - İçeriği alınamayan gönderi: kural gereği "erisilemeyen" (jev'e sorulmaz).
// - jev mevcut bir kategoriyi eşik üstü güvenle seçerse: plan satırı + not.
// - Diğerleri (düşük güven, "yeni kategori gerekli", jev hatası): devir listesine, arşivci işler.
// Notu zaten olan kimlikler atlanır. Anahtar ortamdan gelir; ekrana ya da dosyaya yazılmaz.
import fs from 'node:fs';
import path from 'node:path';
import { readCategories, loadContent, findNotes, renderEntries } from './render-archive.mjs';
import { judgeTweet, NEW_CATEGORY } from '../relay/jev.mjs';
import { loadConfig } from '../relay/config.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const input = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
const planFile = opt('plan');
const handoffFile = opt('devret');
if (!input || !planFile || !handoffFile) {
  console.error('Kullanım: node jev-batch.mjs gelen/<ad>.jsonl --plan plan/<ad>-jev.jsonl --devret gelen/devret-<ad>.jsonl [--esik 0.85]');
  process.exit(2);
}

const root = fs.realpathSync(process.cwd());
const cfg = loadConfig();
const threshold = Number(opt('esik', cfg.jevThreshold ?? 0.85));
const routes = cfg.notifyRoutes ?? [];
const categories = readCategories(root);
const content = loadContent(root);
const existing = findNotes(root);
const ids = fs
  .readFileSync(path.resolve(root, input), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l).id)
  .filter((id) => !existing.has(id));

const plan = [];
const handoff = [];
const relevant = new Map(routes.map((r) => [r.name, 0]));
let next = 0;
let done = 0;

async function worker() {
  while (next < ids.length) {
    const id = ids[next++];
    const c = content.get(id);
    if (!c?.available) {
      plan.push({ id, kategori: 'erisilemeyen', etiketler: [], ozet: '', guven: 'yuksek', karar: 'kural' });
    } else {
      try {
        const v = await judgeTweet(c, categories, routes);
        for (const r of v.relevance) if (r.p != null && r.p >= (routes.find((x) => x.name === r.name)?.threshold ?? 0.7)) relevant.set(r.name, relevant.get(r.name) + 1);
        if (v.choice !== NEW_CATEGORY && categories.has(v.choice) && (v.confidence ?? 0) >= threshold) {
          plan.push({ id, kategori: v.choice, etiketler: [], ozet: '', guven: 'yuksek', karar: 'jev', jevGuven: v.confidence });
        } else {
          handoff.push({ id, jev: { choice: v.choice, confidence: v.confidence, top: v.top } });
        }
      } catch (e) {
        handoff.push({ id, jev: null, hata: e.message.slice(0, 120) });
      }
    }
    if (++done % 50 === 0) console.log(`${done}/${ids.length}`);
  }
}
await Promise.all(Array.from({ length: Number(opt('concurrency', 4)) }, worker));

const order = new Map(ids.map((id, i) => [id, i]));
plan.sort((a, b) => order.get(a.id) - order.get(b.id));
handoff.sort((a, b) => order.get(a.id) - order.get(b.id));
fs.appendFileSync(path.resolve(root, planFile), plan.map((p) => JSON.stringify(p)).join('\n') + (plan.length ? '\n' : ''));
fs.writeFileSync(path.resolve(root, handoffFile), handoff.map((h) => JSON.stringify(h)).join('\n') + (handoff.length ? '\n' : ''));
const r = renderEntries(root, plan, { source: planFile });

const byCat = {};
for (const p of plan) byCat[p.kategori] = (byCat[p.kategori] ?? 0) + 1;
console.log(`İşlenen: ${ids.length} (notu olanlar atlandı: ${existing.size})`);
console.log(`Doğrudan yazılan: ${r.yazilan} (jev ${plan.filter((p) => p.karar === 'jev').length}, kural ${plan.filter((p) => p.karar === 'kural').length}), hata: ${r.hatalar.length}`);
console.log(`Arşivciye devredilen: ${handoff.length} (jev hatası: ${handoff.filter((h) => !h.jev).length}, yeni kategori önerisi: ${handoff.filter((h) => h.jev?.choice === NEW_CATEGORY).length})`);
console.log(`Kategoriler: ${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
for (const [name, n] of relevant) console.log(`${name} ile ilgili (jev): ${n}`);
for (const h of r.hatalar) console.log(`HATA ${h}`);
