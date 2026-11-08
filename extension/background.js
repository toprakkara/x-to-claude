// Only this service worker talks to the relay: its requests come from a chrome-extension:// origin and
// the token never reaches the content script, and so never reaches the x.com page.
const DEFAULTS = { relayUrl: 'http://127.0.0.1:47615', token: '' };

function isLocalRelay(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.pathname === '/';
  } catch {
    return false;
  }
}

// `npm run extension:config` writes relay.json to the extension folder, so the token never goes through the UI.
// The file isn't in web_accessible_resources, so only this extension can read it.
// Values saved on the settings page override the file.
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
  if (!token) return { ok: false, kind: 'config', error: 'The relay token isn\'t set. Run "npm run extension:config" in the project folder and reload the extension.' };
  if (!isLocalRelay(relayUrl)) return { ok: false, kind: 'config', error: 'The relay address must be 127.0.0.1 or localhost.' };

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
      ? { ok: false, kind: 'timeout', error: 'The relay didn\'t respond in time.' }
      : { ok: false, kind: 'unreachable', error: 'Can\'t reach the relay. Is "npm run relay" running?' };
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) return { ok: false, kind: 'auth', error: 'Invalid token. Update it in the settings.' };
  if (!res.ok) return { ok: false, kind: data.code || 'http', status: res.status, error: data.error || `HTTP ${res.status}` };
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
      // The first turn runs in the background, so this can take a while.
      callRelay('/new-session', { method: 'POST', body: { tweet: msg.tweet }, timeoutMs: 240_000 }).then(sendResponse);
      return true;
    case 'claudeLoginStatus':
      callRelay('/claude-login').then(sendResponse);
      return true;
    case 'claudeLogin':
      callRelay('/claude-login', { method: 'POST' }).then(sendResponse);
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
