import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempHome } from './helpers.mjs';
import { render, findNotes } from '../scripts/render-archive.mjs';

const root = fs.realpathSync(tempHome());
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const write = (rel, body) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
};
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

write('kategoriler.md', '# Kategoriler\n\n- hukuk-teknolojisi — Hukuk ve yapay zekâ araçları\n- ajan-araclari — Kodlama ajanları\n- erisilemeyen — İçeriği alınamayan gönderiler\n');
write('gelen/dm-ice-aktarma.jsonl', jsonl([
  { id: '111', url: 'https://x.com/i/status/111', handle: null, firstSharedAt: '2026-03-07T23:47:00+03:00', sharedBy: ['me'], shareCount: 1, source: 'dm-ice-aktarma', oembed: { status: 200, author: { name: 'Said', handle: 'SuruCudev' }, text: 'Yargıtay kararı\n\nikinci paragraf', date: '2026-01-12', links: ['https://t.co/x'], hasMedia: true } },
  { id: '222', url: 'https://x.com/i/status/222', handle: null, sharedBy: ['karsi-taraf'], source: 'dm-ice-aktarma', oembed: { status: 404 } },
]));
write('gelen/kuyruk.jsonl', jsonl([
  { id: '333', url: 'https://x.com/a/status/333', author: { name: 'A', handle: 'a' }, time: '2026-10-05T09:00:00.000Z', text: 'Ajan', quoted: { author: { name: 'Q', handle: 'q' }, text: 'alıntı' }, media: ['https://pbs.twimg.com/m.jpg'], links: [], source: 'buton', savedAt: '2026-10-05T10:00:00Z' },
]));

test('plan notları yazar: iki kaynak biçimi, ön bilgi, alıntı ve erişilemeyen içerik', () => {
  write('plan/1.jsonl', jsonl([
    { id: '111', kategori: 'hukuk-teknolojisi', etiketler: ['yargitay'], ozet: 'Karar arama', guven: 'yuksek' },
    { id: '222', kategori: 'erisilemeyen' },
    { id: '333', kategori: 'ajan-araclari', etiketler: ['claude'], ozet: 'Ajan' },
  ]));
  const r = render(root, ['plan/1.jsonl'], { now: '2026-10-05T12:00:00Z' });
  assert.deepEqual(r, { yazilan: 3, tasinan: 0, hatalar: [] });

  const n1 = fs.readFileSync(path.join(root, 'kutuphane/hukuk-teknolojisi/2026-01-12-surucudev-111.md'), 'utf8');
  assert.match(n1, /^---\nid: "111"\n/);
  assert.match(n1, /kullanici: "SuruCudev"/);
  assert.match(n1, /paylasan: \["me"\]/);
  assert.match(n1, /> Yargıtay kararı\n>\n> ikinci paragraf/);
  assert.match(n1, /medya: true/);

  const n2 = fs.readFileSync(path.join(root, 'kutuphane/erisilemeyen/tarihsiz-bilinmiyor-222.md'), 'utf8');
  assert.match(n2, /İçerik alınamadı/);

  const n3 = fs.readFileSync(path.join(root, 'kutuphane/ajan-araclari/2026-10-05-a-333.md'), 'utf8');
  assert.match(n3, /\*\*Alıntılanan gönderi\*\* Q \(@q\)/);
  assert.match(n3, /- https:\/\/pbs\.twimg\.com\/m\.jpg/);

  const idx = fs.readFileSync(path.join(root, 'kutuphane/_indeks.md'), 'utf8');
  assert.match(idx, /Toplam 3 gönderi/);
  assert.match(idx, /\| \[hukuk-teknolojisi\]\(hukuk-teknolojisi\/\) \| 1 \| Hukuk ve yapay zekâ araçları \|/);
});

test('kategori değişince not taşınır, kopya kalmaz', () => {
  write('plan/2.jsonl', jsonl([{ id: '111', kategori: 'ajan-araclari', etiketler: [], ozet: 'x' }]));
  const r = render(root, ['plan/2.jsonl']);
  assert.equal(r.tasinan, 1);
  assert.equal(findNotes(root).get('111'), path.join(root, 'kutuphane/ajan-araclari/2026-01-12-surucudev-111.md'));
  assert.ok(!fs.existsSync(path.join(root, 'kutuphane/hukuk-teknolojisi/2026-01-12-surucudev-111.md')));
});

test('bilinmeyen kategori, bilinmeyen kimlik ve bozuk slug hata verir, yazmaz', () => {
  write('plan/3.jsonl', jsonl([
    { id: '333', kategori: 'yeni-kategori' },
    { id: '999', kategori: 'ajan-araclari' },
    { id: '333', kategori: 'Büyük Harf' },
    { id: '333', kategori: 'ajan-araclari', etiketler: ['../kotu'] },
  ]));
  const r = render(root, ['plan/3.jsonl']);
  assert.equal(r.yazilan, 0);
  assert.equal(r.hatalar.length, 4);
  assert.match(r.hatalar[0], /kategoriler\.md'de yok/);
});

test('plan dosyası arşiv klasörü dışında olamaz', () => {
  assert.throws(() => render(root, ['../disari.jsonl']), /arşiv klasörü dışında/);
});
