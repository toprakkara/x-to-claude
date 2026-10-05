const form = document.getElementById('form');
const statusEl = document.getElementById('status');

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = kind;
}

async function bundledConfig() {
  try {
    const res = await fetch(chrome.runtime.getURL('relay.json'));
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

async function load() {
  const [stored, file] = await Promise.all([chrome.storage.local.get(['relayUrl', 'token']), bundledConfig()]);
  form.relayUrl.value = stored.relayUrl || file.relayUrl || 'http://127.0.0.1:47615';
  form.token.value = stored.token || '';
  // Alan boş kalırsa relay.json'daki token kullanılır.
  form.token.placeholder = file.token ? 'relay.json dosyasından okunuyor' : '';
  document.getElementById('extId').value = chrome.runtime.id;
}

function normalizeRelayUrl(value) {
  const u = new URL(value.trim() || 'http://127.0.0.1:47615');
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname)) {
    throw new Error('Relay adresi http://127.0.0.1:<port> ya da http://localhost:<port> olmalı.');
  }
  return `${u.protocol}//${u.host}/`;
}

async function save() {
  const relayUrl = normalizeRelayUrl(form.relayUrl.value);
  await chrome.storage.local.set({ relayUrl, token: form.token.value.trim() });
  form.relayUrl.value = relayUrl;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await save();
    setStatus('Kaydedildi.', 'ok');
  } catch (err) {
    setStatus(err.message, 'err');
  }
});

document.getElementById('test').addEventListener('click', async () => {
  try {
    await save();
  } catch (err) {
    return setStatus(err.message, 'err');
  }
  setStatus('Deneniyor…');
  const res = await chrome.runtime.sendMessage({ type: 'sessions' });
  if (!res?.ok) return setStatus(res?.error ?? 'Bilinmeyen hata', 'err');
  const n = res.data.sessions.length;
  setStatus(n ? `Bağlantı tamam: ${n} açık oturum kayıtlı.` : 'Bağlantı tamam, ama kayıtlı açık oturum yok.', 'ok');
});

load();
