#!/usr/bin/env node
// Oturum kaydı hook'larını kullanıcı ayarlarına (~/.claude/settings.json) ekler ya da kaldırır.
//   node scripts/install-hooks.mjs              ekle (önce yedek alır)
//   node scripts/install-hooks.mjs --dry-run    yalnız ne yazılacağını göster
//   node scripts/install-hooks.mjs --uninstall  kaldır
// Hook komutları bu Node'un mutlak yolunu kullanır; masaüstü uygulamasının PATH'ine güvenmez.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARK = 'x-to-claude';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const settingsPath = process.env.CLAUDE_SETTINGS_PATH || path.join(os.homedir(), '.claude', 'settings.json');
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const uninstall = args.has('--uninstall');

const q = (s) => `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
const cmd = (script) => `${q(process.execPath)} ${q(path.join(root, 'hooks', script))} # ${MARK}`;

const ours = {
  SessionStart: { hooks: [{ type: 'command', command: cmd('register.mjs'), timeout: 10 }] },
  SessionEnd: { hooks: [{ type: 'command', command: cmd('unregister.mjs'), timeout: 5 }] },
};

let settings = {};
let original = null;
try {
  original = fs.readFileSync(settingsPath, 'utf8');
  settings = JSON.parse(original);
} catch (e) {
  if (e.code !== 'ENOENT') {
    console.error(`${settingsPath} okunamadı: ${e.message}`);
    process.exit(1);
  }
}

const isOurs = (group) => group?.hooks?.some((h) => typeof h.command === 'string' && h.command.includes(`# ${MARK}`));

settings.hooks ??= {};
for (const [event, group] of Object.entries(ours)) {
  const kept = (settings.hooks[event] ?? []).filter((g) => !isOurs(g));
  settings.hooks[event] = uninstall ? kept : [...kept, group];
  if (!settings.hooks[event].length) delete settings.hooks[event];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

const next = JSON.stringify(settings, null, 2) + '\n';

if (dryRun) {
  console.log(`# ${settingsPath} için yazılacak hooks bölümü:`);
  console.log(JSON.stringify(settings.hooks ?? {}, null, 2));
  process.exit(0);
}
if (next === original) {
  console.log('Değişiklik yok.');
  process.exit(0);
}
if (original !== null) {
  const backup = `${settingsPath}.bak-${MARK}-${Date.now()}`;
  fs.writeFileSync(backup, original, { mode: 0o600 });
  console.log(`Yedek: ${backup}`);
}
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, next);
console.log(uninstall ? 'Hook\'lar kaldırıldı.' : 'Hook\'lar eklendi. Yeni başlayan oturumlar kaydolacak.');
