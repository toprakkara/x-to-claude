import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

// macOS'ta Unix soket yolu ~104 karakterle sınırlı; kısa bir geçici klasör kullan.
export function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x2c-'));
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  return dir;
}

// Gerçek Claude oturumu yerine geçen sahte gelen kutusu: gelen her bağlantının tüm verisini kaydeder.
export function fakeInbox(dir, name = 'inbox.sock') {
  const socketPath = path.join(dir, name);
  const received = [];
  const server = net.createServer((c) => {
    let data = '';
    c.setEncoding('utf8');
    c.on('data', (d) => (data += d));
    c.on('end', () => {
      received.push(data);
      c.end('{"ok":true}\n');
    });
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve({ socketPath, received, close: () => server.close() })));
}

export function writeSession(home, rec) {
  fs.writeFileSync(path.join(home, 'sessions', `${rec.sessionId}.json`), JSON.stringify(rec));
}

export const sampleTweet = {
  url: 'https://twitter.com/someone/status/1234567890123456789?s=20',
  author: { name: 'Bir Hukukçu', handle: '@someone' },
  time: '2026-10-04T09:15:00.000Z',
  text: 'Legal tech üzerine bir gözlem.\nİkinci satır.',
  media: ['https://pbs.twimg.com/media/abc?format=jpg&name=large', 'javascript:alert(1)'],
  links: ['https://example.com/makale'],
  quoted: {
    url: null,
    author: { name: 'Diğer', handle: 'other' },
    text: 'Alıntılanan metin',
  },
};
