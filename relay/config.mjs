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
  // Arşiv klasörü ve arşivci oturumunun adı (sol tık "kaydet" buraya gider).
  if (typeof cfg.archiveDir !== 'string') {
    cfg.archiveDir = path.join(os.homedir(), '_DEV', 'x-arsiv');
    changed = true;
  }
  if (typeof cfg.archivistName !== 'string') {
    cfg.archivistName = 'x-arsiv';
    changed = true;
  }
  // jev: kategori güveni bu eşiği geçerse not doğrudan yazılır, geçmezse arşivciye devredilir.
  if (typeof cfg.jevThreshold !== 'number') {
    cfg.jevThreshold = 0.85;
    changed = true;
  }
  // jev anahtarı (OPENROUTER_API_KEY ya da TYPESAFE_API_KEY) bu dosyadan okunur; config.json'a yazılmaz.
  if (!('jevEnvFile' in cfg)) {
    cfg.jevEnvFile = path.join(os.homedir(), '_DEV', 'jev-browser', '.env');
    changed = true;
  }
  // Kaydedilen gönderi bir hedefin konusuyla ilgiliyse (jev noul ≥ threshold) relay o oturuma bildirim yollar.
  if (!Array.isArray(cfg.notifyRoutes)) {
    cfg.notifyRoutes = [
      {
        name: 'Method Path',
        topic: 'hukuk teknolojisi: hukuk alanında yapay zekâ ve legal-tech; avukatlar, hukuk büroları, şirket hukukçuları ve mahkemeler için ürünler, ajanlar ve şirketler (ör. Harvey, Legora, Spellbook, CoCounsel, Argüman, Yargı Pro, Apilex, De Jure, Defendiora); hukuk benchmark\'ları; içtihat ve mevzuat arama, UYAP/UDF araçları; ürün adı geçmese bile bir hukuk iş akışını (sözleşme inceleme, dava hazırlığı, hukuki araştırma) anlatan gönderiler.',
        threshold: 0.7,
      },
    ];
    changed = true;
  }
  // Arşivci kapalıyken kuyruğa kayıt düşerse relay onu arka planda `claude -p` ile uyandırır.
  if (typeof cfg.archivistWake !== 'object' || cfg.archivistWake === null) {
    cfg.archivistWake = { enabled: true, claudePath: path.join(os.homedir(), '.local', 'bin', 'claude'), model: null };
    changed = true;
  }
  // Sağ tık menüsündeki "Yeni oturum": gönderi için Claude Desktop'ta yeni Code oturumu. Code oturumları bir klasör
  // istediği için gönderi sohbetlerine ayrılmış boş bir klasör kullanılır.
  if (typeof cfg.newSession !== 'object' || cfg.newSession === null) {
    cfg.newSession = { enabled: true, dir: path.join(os.homedir(), '_DEV', 'x-sohbet'), model: null };
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

// .env dosyasından yalnız jev'in ihtiyaç duyduğu anahtarları okur; process.env'e yazmaz.
const JEV_KEYS = ['OPENROUTER_API_KEY', 'TYPESAFE_API_KEY', 'JEV_MODEL'];
export function loadJevEnv(file) {
  const env = {};
  for (const k of JEV_KEYS) if (process.env[k]) env[k] = process.env[k];
  if (!file) return env;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return env;
  }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && JEV_KEYS.includes(m[1]) && !env[m[1]]) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
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
