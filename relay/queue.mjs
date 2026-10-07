// Oturum başına gönderim kuyruğu. Oturumun gelen kutusu hızlı ardışık mesajları reddettiği için
// kısa aralıkla gelen gönderileri tek mesajda birleştirir ve aynı oturuma iki teslim arasında
// en az minGapMs bırakır. Her istek, kendi gönderisini taşıyan teslimin sonucunu bekler.
import { formatMessage, LIMITS } from './format.mjs';

export function createQueue({ deliver, debounceMs = 700, minGapMs = 3_000, now = Date.now } = {}) {
  // Şerit anahtarı soket + istek türü: aynı oturuma giden "gönder" ve "kaydet" istekleri tek mesajda karışmaz.
  const lanes = new Map(); // "socket|intent" -> { key, target, pending: [], timer, lastSentAt, flushing }
  const keyOf = (target) => `${target.socket}|${target.intent ?? 'send'}`;

  function lane(target) {
    const key = keyOf(target);
    let l = lanes.get(key);
    if (!l) {
      l = { key, target, pending: [], timer: null, lastSentAt: 0, flushing: false };
      lanes.set(key, l);
    }
    l.target = target; // aynı sokette oturum kimliği değiştiyse en yenisi geçerli
    return l;
  }

  function schedule(l) {
    if (l.timer || l.flushing) return;
    const wait = Math.max(debounceMs, l.lastSentAt + minGapMs - now());
    l.timer = setTimeout(() => flush(l), wait);
  }

  // Sınırı aşmadan sığan en uzun önek tek mesaja girer; kalanlar sonraki tura kalır.
  function takeBatch(l) {
    let n = l.pending.length;
    while (n > 1 && formatMessage(l.pending.slice(0, n).map((x) => x.post), { intent: l.target.intent }).length > LIMITS.message) n--;
    return l.pending.splice(0, n);
  }

  async function flush(l) {
    l.timer = null;
    if (!l.pending.length) return;
    l.flushing = true;
    const batch = takeBatch(l);
    try {
      const reply = await deliver(l.target, formatMessage(batch.map((x) => x.post), { intent: l.target.intent }));
      batch.forEach((x) => x.resolve({ batched: batch.length, reply }));
    } catch (e) {
      batch.forEach((x) => x.reject(e));
    } finally {
      l.lastSentAt = now();
      l.flushing = false;
      if (l.pending.length) schedule(l);
      else lanes.delete(l.key);
    }
  }

  return {
    // target: { socket, sessionId, priority, intent }
    enqueue(target, post) {
      const l = lane(target);
      const dup = l.pending.find((x) => x.post.url === post.url);
      if (dup) return dup.promise;
      let resolve, reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      l.pending.push({ post, promise, resolve, reject });
      schedule(l);
      return promise;
    },
  };
}
