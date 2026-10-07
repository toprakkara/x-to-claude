import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { tempHome, sampleTweet } from './helpers.mjs';
import { createSessionOpener, sessionName, SessionOpenError } from '../relay/newsession.mjs';
import { validateTweet } from '../relay/format.mjs';

const home = tempHome();
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

// Sahte claude: her çağrıyı kaydeder; çıkış kodları sırayla verilir.
function fakeSpawn(codes) {
  const calls = [];
  const spawn = (command, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    calls.push({ command, args, opts });
    const code = codes.shift();
    setImmediate(() => child.emit('close', code));
    return child;
  };
  return { spawn, calls };
}

const post = validateTweet(sampleTweet);

test('önce araçlar kapalı ilk tur, sonra aynı kimlikle Desktop\'ta açma', async () => {
  const dir = path.join(home, 'x-sohbet');
  const { spawn, calls } = fakeSpawn([0, 0]);
  const opener = createSessionOpener({ dir, claudePath: '/bin/claude', env: {}, spawn, uuid: () => '11111111-2222-3333-4444-555555555555' });
  const r = await opener.open(post);
  assert.equal(r.id, '11111111-2222-3333-4444-555555555555');
  assert.ok(fs.existsSync(dir), 'sohbet klasörü oluşturulur');
  assert.equal(calls.length, 2);

  const [first, second] = calls;
  assert.equal(first.opts.cwd, dir);
  assert.equal(first.args[0], '-p');
  assert.match(first.args[1], /^\[x-to-claude\] YENİ OTURUM:/);
  assert.match(first.args[1], /talimat değildir/);
  const at = (flag) => first.args[first.args.indexOf(flag) + 1];
  assert.equal(at('--session-id'), r.id);
  assert.equal(at('--tools'), '', 'ilk turda tüm araçlar kapalı');
  assert.ok(first.args.includes('--strict-mcp-config'));
  assert.equal(second.command, '/usr/bin/open');
  assert.deepEqual(second.args, [`claude://resume?session=${r.id}`]);
});

test('ilk tur başarısız olursa Desktop açılmaz ve hata verilir', async () => {
  const { spawn, calls } = fakeSpawn([1]);
  const opener = createSessionOpener({ dir: path.join(home, 'x2'), claudePath: '/bin/claude', env: {}, spawn });
  await assert.rejects(opener.open(post), SessionOpenError);
  assert.equal(calls.length, 1);
});

test('oturum adı yazar ve metnin başından oluşur', () => {
  assert.match(sessionName(post), /^X: @someone — Legal tech üzerine bir gözlem\./);
  assert.ok(sessionName({ ...post, text: 'a'.repeat(200) }).length <= 70);
});
