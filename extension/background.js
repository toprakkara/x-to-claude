// Relay ile yalnız bu service worker konuşur: istekleri chrome-extension:// kaynağından gider ve
// token içerik betiğine, dolayısıyla x.com sayfasına hiç inmez.
const DEFAULTS = { relayUrl: 'http://127.0.0.1:47615', token: '' };

function isLocalRelay(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.pathname === '/';
  } catch {
    return false;
  }
}

// `npm run extension:config` eklenti klasörüne relay.json yazar; token böylece arayüzden geçmez.
// Dosya web_accessible_resources'ta olmadığı için yalnız bu eklenti okuyabilir.
// Ayarlar sayfasında kaydedilen değerler dosyadakileri ezer.
async function bundledConfig() {
  try {
    const res = await fetch(chrome.runtime.getURL('relay.json'));
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

async function relayConfig() {
  const [stored, file] = await Promise.all([chrome.storage.local.get(['relayUrl', 'token']), bundledConfig()]);
  return {
    relayUrl: stored.relayUrl || file.relayUrl || DEFAULTS.relayUrl,
    token: stored.token || file.token || DEFAULTS.token,
  };
}

async function callRelay(path, { method = 'GET', body, timeoutMs = 8_000 } = {}) {
  const { relayUrl, token } = await relayConfig();
  if (!token) return { ok: false, kind: 'config', error: 'Relay token\'ı ayarlanmamış. Proje klasöründe "npm run extension:config" çalıştırıp eklentiyi yeniden yükle.' };
  if (!isLocalRelay(relayUrl)) return { ok: false, kind: 'config', error: 'Relay adresi 127.0.0.1 ya da localhost olmalı.' };

  let res;
  try {
    res = await fetch(new URL(path, relayUrl), {
      method,
      headers: { 'X-Relay-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return e.name === 'TimeoutError'
      ? { ok: false, kind: 'timeout', error: 'Relay zamanında yanıt vermedi.' }
      : { ok: false, kind: 'unreachable', error: 'Relay\'e ulaşılamadı. Terminalde "npm run relay" çalışıyor mu?' };
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) return { ok: false, kind: 'auth', error: 'Token geçersiz. Ayarlardan güncelle.' };
  if (!res.ok) return { ok: false, kind: 'http', status: res.status, error: data.error || `HTTP ${res.status}` };
  return { ok: true, data };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  switch (msg?.type) {
    case 'sessions':
      callRelay('/sessions').then(sendResponse);
      return true;
    case 'send':
      callRelay('/send', { method: 'POST', body: { sessionId: msg.sessionId, tweet: msg.tweet }, timeoutMs: 20_000 }).then(sendResponse);
      return true;
    case 'newSession':
      // İlk tur arka planda çalıştığı için uzun sürebilir.
      callRelay('/new-session', { method: 'POST', body: { tweet: msg.tweet }, timeoutMs: 240_000 }).then(sendResponse);
      return true;
    case 'save':
      callRelay('/save', { method: 'POST', body: { tweet: msg.tweet }, timeoutMs: 20_000 }).then(sendResponse);
      return true;
    case 'saved': {
      const ids = (Array.isArray(msg.ids) ? msg.ids : []).filter((id) => /^\d{1,25}$/.test(id)).slice(0, 200);
      if (!ids.length) {
        sendResponse({ ok: true, data: { saved: [] } });
        return false;
      }
      callRelay(`/saved?ids=${ids.join(',')}`).then(sendResponse);
      return true;
    }
    case 'openOptions':
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return false;
    default:
      return false;
  }
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
