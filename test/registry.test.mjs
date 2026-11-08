import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempHome, fakeInbox, writeSession } from './helpers.mjs';

const home = tempHome();
const claudeDir = path.join(home, 'claude', 'sessions');
fs.mkdirSync(claudeDir, { recursive: true });
process.env.X2C_HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');

const { liveSessions, publicView } = await import('../relay/registry.mjs');

const inbox = await fakeInbox(home);
const peerFile = path.join(claudeDir, `${process.pid}.json`);
const rec = { sessionId: 's-1', socket: inbox.socketPath, pid: process.pid, name: 'scratch-2026-11-08-39906b', cwd: '/x/scratch-2026-11-08-39906b', entrypoint: 'claude-desktop', registeredAt: 1 };
writeSession(home, rec);

test.afterEach(() => fs.rmSync(peerFile, { force: true }));
test.after(() => {
  inbox.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const writePeer = (peer) => fs.writeFileSync(peerFile, typeof peer === 'string' ? peer : JSON.stringify(peer));
const shownName = () => publicView(liveSessions()[0]).name;

test('Claude Code\'un tuttuğu güncel başlık hook\'un yazdığı adın önüne geçer', () => {
  writePeer({ pid: process.pid, sessionId: 's-1', name: 'DeepSeek Ultrafast availability' });
  assert.equal(shownName(), 'DeepSeek Ultrafast availability');
});

test('başlık sonradan değişirse yeni başlık görünür', () => {
  writePeer({ sessionId: 's-1', name: 'Eski başlık' });
  assert.equal(shownName(), 'Eski başlık');
  writePeer({ sessionId: 's-1', name: 'Yeni başlık' });
  assert.equal(shownName(), 'Yeni başlık');
});

test('adla arayanlar (bildirim hedefi) da güncel başlığı görür', () => {
  writePeer({ sessionId: 's-1', name: 'Method Path' });
  assert.ok(liveSessions({ prune: false }).find((s) => s.name === 'Method Path'));
});

test('PID başka oturuma geçmişse o oturumun adı alınmaz', () => {
  writePeer({ sessionId: 'baska-oturum', name: 'Başkasının başlığı' });
  assert.equal(shownName(), rec.name);
});

test('dosya yoksa, bozuksa ya da ad boşsa hook\'un yazdığı ad kullanılır', () => {
  assert.equal(shownName(), rec.name, 'dosya yok');
  for (const peer of ['bozuk{', { sessionId: 's-1' }, { sessionId: 's-1', name: '   ' }, { sessionId: 's-1', name: 42 }]) {
    writePeer(peer);
    assert.equal(shownName(), rec.name, JSON.stringify(peer));
  }
});

test('adın baş ve sonundaki boşluklar atılır', () => {
  writePeer({ sessionId: 's-1', name: '  UI  ' });
  assert.equal(shownName(), 'UI');
});

test('kayıtta geçerli PID yoksa dosya aranmaz', () => {
  writeSession(home, { ...rec, pid: null });
  try {
    writePeer({ sessionId: 's-1', name: 'Başlık' });
    assert.equal(shownName(), rec.name);
  } finally {
    writeSession(home, rec);
  }
});
