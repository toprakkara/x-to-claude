// Hedef oturumun gelen kutusu soketine (Unix domain socket) teslim.
//
// Tel formatı (Claude Code 2.1.286'da doğrulandı, 2026-10-05): bağlantı başına satır satır JSON.
//   {"type":"auth","token":"..."}   isteğe bağlı; macOS'ta gerekmez. Relay kullanmaz (token'ı oturumun alt süreçlerine ait).
//   {"type":"user","message":{"role":"user","content":"<metin>"},"from":"<gönderen>","session_id":"<hedef>","priority":"now|next|later"}
// session_id verilirse hedef oturumun kimliğiyle eşleşmeyen mesaj atılır: soket başka bir oturuma geçmişse yanlış yere gitmez.
// "from" "uds:" ile başlamadığı için alıcı bir yanıt adresi görmez. Sunucu yanıt satırı göndermez; satır sınırı 1.048.576 karakter.
import net from 'node:net';

export const SENDER = 'x-to-claude';
const MAX_LINE = 1_048_576;

export class DeliveryError extends Error {}

export function encodeLine(text, { sessionId, priority } = {}) {
  const line =
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
      from: SENDER,
      ...(sessionId && { session_id: sessionId }),
      ...(priority && { priority }),
    }) + '\n';
  if (line.length > MAX_LINE) throw new DeliveryError('mesaj soket satır sınırını aşıyor');
  return line;
}

// target: { socket, sessionId, priority }. Bağlantıyı yalnız mesaj hazırken açar
// (soket 30 sn içinde tam satır gelmezse kapanıyor).
export function deliver(target, text, { encode = encodeLine, timeoutMs = 5_000 } = {}) {
  const payload = encode(text, target);
  return new Promise((resolve, reject) => {
    let reply = '';
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      err ? reject(err) : resolve(value);
    };
    const sock = net.createConnection(target.socket, () => {
      sock.end(payload);
    });
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      reply += d;
    });
    sock.on('error', (e) => done(new DeliveryError(`soket hatası: ${e.code || e.message}`)));
    sock.on('close', () => done(null, reply.trim() || null));
    const timer = setTimeout(() => done(new DeliveryError('soket zaman aşımı')), timeoutMs);
  });
}
