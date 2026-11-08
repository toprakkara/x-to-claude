// Delivery to the target session's inbox socket (a Unix domain socket).
//
// Wire format (verified on Claude Code 2.1.286, 2026-10-05; undocumented): line-delimited JSON per connection.
//   {"type":"auth","token":"..."}   optional; not needed on macOS. The relay doesn't use it (the token belongs to the session's child processes).
//   {"type":"user","message":{"role":"user","content":"<text>"},"from":"<sender>","session_id":"<target>","priority":"now|next|later"}
// With session_id set, a message that doesn't match the target session's ID is dropped, so it can't reach the wrong session if the socket changed hands.
// "from" doesn't start with "uds:", so the receiver sees no reply address. The server sends no reply line; the line limit is 1,048,576 characters.
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
  if (line.length > MAX_LINE) throw new DeliveryError('message exceeds the socket line limit');
  return line;
}

// target: { socket, sessionId, priority }. Opens the connection only when the message is ready
// (the socket closes if no complete line arrives within 30 s).
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
    sock.on('error', (e) => done(new DeliveryError(`socket error: ${e.code || e.message}`)));
    sock.on('close', () => done(null, reply.trim() || null));
    const timer = setTimeout(() => done(new DeliveryError('socket timeout')), timeoutMs);
  });
}
