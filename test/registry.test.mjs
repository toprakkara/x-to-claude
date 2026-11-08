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

test('the current title kept by Claude Code takes priority over the hook\'s name', () => {
  writePeer({ pid: process.pid, sessionId: 's-1', name: 'DeepSeek Ultrafast availability' });
  assert.equal(shownName(), 'DeepSeek Ultrafast availability');
});

test('when the title changes later, the new title is shown', () => {
  writePeer({ sessionId: 's-1', name: 'Old title' });
  assert.equal(shownName(), 'Old title');
  writePeer({ sessionId: 's-1', name: 'New title' });
  assert.equal(shownName(), 'New title');
});

test('lookups by name (notice targets) see the current title too', () => {
  writePeer({ sessionId: 's-1', name: 'Research' });
  assert.ok(liveSessions({ prune: false }).find((s) => s.name === 'Research'));
});

test('if the PID now belongs to another session, that session\'s name is not used', () => {
  writePeer({ sessionId: 'other-session', name: 'Another title' });
  assert.equal(shownName(), rec.name);
});

test('if the file is missing or broken, or the name is empty, the hook\'s name is used', () => {
  assert.equal(shownName(), rec.name, 'no file');
  for (const peer of ['broken{', { sessionId: 's-1' }, { sessionId: 's-1', name: '   ' }, { sessionId: 's-1', name: 42 }]) {
    writePeer(peer);
    assert.equal(shownName(), rec.name, JSON.stringify(peer));
  }
});

test('whitespace around the name is trimmed', () => {
  writePeer({ sessionId: 's-1', name: '  UI  ' });
  assert.equal(shownName(), 'UI');
});

test('without a valid PID in the record, no file is looked up', () => {
  writeSession(home, { ...rec, pid: null });
  try {
    writePeer({ sessionId: 's-1', name: 'Title' });
    assert.equal(shownName(), rec.name);
  } finally {
    writeSession(home, rec);
  }
});
