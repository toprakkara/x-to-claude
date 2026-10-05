#!/usr/bin/env node
// Relay'i oturum açılışında başlatan ve çökerse yeniden başlatan launchd ajanı.
//   node scripts/launchd.mjs install     plist'i yazar, ajanı yükler ve başlatır (zaten yüklüyse yeniler)
//   node scripts/launchd.mjs uninstall   ajanı durdurur ve plist'i siler
//   node scripts/launchd.mjs restart     relay'i yeniden başlatır (kod ya da config.json değişince)
//   node scripts/launchd.mjs status      ajanın durumunu gösterir
// Ajan bu Node'un mutlak yolunu kullanır: nvm ile Node sürümü değişirse install'ı yeniden çalıştır.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LABEL = 'local.x-to-claude.relay';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const logPath = path.join(os.homedir(), '.x-to-claude', 'relay.log');
const domain = `gui/${process.getuid()}`;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(process.execPath)}</string>
    <string>${esc(path.join(root, 'relay', 'server.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${esc(root)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${esc(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(logPath)}</string>
</dict>
</plist>
`;
}

function loaded() {
  return spawnSync('launchctl', ['print', `${domain}/${LABEL}`], { stdio: 'ignore' }).status === 0;
}

function bootout() {
  if (loaded()) execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`]);
}

const cmd = process.argv[2];
if (cmd === 'install') {
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  bootout();
  fs.writeFileSync(plistPath, plist());
  execFileSync('launchctl', ['bootstrap', domain, plistPath]);
  console.log(`Yüklendi: ${plistPath}`);
  console.log(`Kayıt:    ${logPath}`);
} else if (cmd === 'uninstall') {
  bootout();
  fs.rmSync(plistPath, { force: true });
  console.log('Ajan durduruldu ve kaldırıldı.');
} else if (cmd === 'restart') {
  if (!loaded()) {
    console.error('Ajan yüklü değil; önce install.');
    process.exit(1);
  }
  execFileSync('launchctl', ['kickstart', '-k', `${domain}/${LABEL}`]);
  console.log('Relay yeniden başlatıldı.');
} else if (cmd === 'status') {
  if (!loaded()) {
    console.log('Ajan yüklü değil.');
  } else {
    const out = execFileSync('launchctl', ['print', `${domain}/${LABEL}`], { encoding: 'utf8' });
    const pick = (k) => new RegExp(`^\\s*${k} = (.*)$`, 'm').exec(out)?.[1] ?? '-';
    console.log(`durum: ${pick('state')}  pid: ${pick('pid')}  son çıkış: ${pick('last exit code')}`);
  }
} else {
  console.error('Kullanım: node scripts/launchd.mjs install|uninstall|restart|status');
  process.exit(2);
}
