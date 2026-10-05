// Relay yapılandırması: ~/.x-to-claude/config.json
// İlk çalıştırmada rastgele bir token üretir. Dosya yalnız kullanıcıya açıktır (0600).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 47615;

export function baseDir() {
  return process.env.X2C_HOME || path.join(os.homedir(), '.x-to-claude');
}

export function sessionsDir() {
  return path.join(baseDir(), 'sessions');
}

function configPath() {
  return path.join(baseDir(), 'config.json');
}

export function loadConfig() {
  fs.mkdirSync(baseDir(), { recursive: true, mode: 0o700 });
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let changed = false;
  if (typeof cfg.token !== 'string' || cfg.token.length < 32) {
    cfg.token = crypto.randomBytes(24).toString('base64url');
    changed = true;
  }
  if (!Number.isInteger(cfg.port)) {
    cfg.port = DEFAULT_PORT;
    changed = true;
  }
  // extensionId boşsa her chrome-extension:// kaynağı kabul edilir (token yine şart).
  if (!('extensionId' in cfg)) {
    cfg.extensionId = null;
    changed = true;
  }
  // Gelen kutusu önceliği: "now" | "next" | "later". Boşsa Claude Code varsayılanı ("next") geçerli.
  if (!('priority' in cfg)) {
    cfg.priority = null;
    changed = true;
  } else if (cfg.priority !== null && !['now', 'next', 'later'].includes(cfg.priority)) {
    throw new Error(`config.json: priority "${cfg.priority}" geçersiz (now, next, later ya da null)`);
  }
  if (changed) {
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  }
  return cfg;
}

// `npm run token`: eklenti ayarlarına yapıştırılacak değerleri yazdırır.
// `npm run extension:config`: aynı değerleri extension/relay.json dosyasına yazar; eklenti token'ı oradan okur.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  const relayUrl = `http://127.0.0.1:${cfg.port}/`;
  if (process.argv.includes('--write-extension')) {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'relay.json');
    fs.writeFileSync(file, JSON.stringify({ relayUrl, token: cfg.token }, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    console.log(`Yazıldı: ${file}`);
    console.log('Eklenti zaten yüklüyse eklentiler sayfasından yeniden yükle.');
  } else {
    console.log(`Relay adresi: ${relayUrl}`);
    console.log(`Token:        ${cfg.token}`);
  }
}
