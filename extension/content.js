// x.com'daki her gönderinin eylem çubuğuna, yer imi düğmesinin yanına bir düğme ekler.
// Tıklamada relay'den oturumları ister, seçilen oturuma gönderiyi yollar.
(() => {
  const ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
    '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/></svg>';
  const ENTRYPOINTS = { cli: 'Terminal', 'claude-desktop': 'Masaüstü', 'claude-vscode': 'VS Code' };

  // ---- relay çağrıları (service worker üzerinden) ----

  async function ask(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch {
      return { ok: false, kind: 'reload', error: 'Eklenti yeniden yüklendi; sayfayı yenile.' };
    }
  }

  // ---- menü ve bildirim: kapalı shadow DOM, sayfa CSS'inden yalıtık ----

  const host = document.createElement('div');
  host.id = 'x2c-host';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .menu, .toast {
        --bg: #fff; --fg: #0f1419; --dim: #536471; --line: #eff3f4; --hover: rgba(15,20,25,.06);
        --shadow: rgba(101,119,134,.2) 0 0 15px, rgba(101,119,134,.15) 0 0 3px 1px;
        font: 15px/20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: var(--fg); background: var(--bg); box-shadow: var(--shadow);
      }
      .dark .menu, .dark .toast, .menu.dark, .toast.dark {
        --bg: #000; --fg: #e7e9ea; --dim: #71767b; --line: #2f3336; --hover: rgba(231,233,234,.06);
        --shadow: rgba(255,255,255,.2) 0 0 15px, rgba(255,255,255,.15) 0 0 3px 1px;
      }
      .menu.dim, .toast.dim { --bg: #15202b; --line: #38444d; --dim: #8b98a5; }
      .menu {
        position: fixed; z-index: 2147483647; width: 320px; max-height: 360px; overflow: auto;
        border-radius: 16px; padding: 4px 0;
      }
      .menu[hidden], .toast[hidden] { display: none; }
      .head { padding: 10px 16px 8px; font-weight: 700; border-bottom: 1px solid var(--line); }
      .item {
        all: unset; box-sizing: border-box; display: block; width: 100%; padding: 10px 16px; cursor: pointer;
      }
      .item:hover, .item:focus-visible { background: var(--hover); }
      .item:focus-visible { outline: 2px solid #d97757; outline-offset: -2px; }
      .row { display: flex; align-items: baseline; gap: 8px; }
      .name { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
      .badge { font-size: 12px; color: var(--dim); border: 1px solid var(--line); border-radius: 9999px; padding: 0 8px; flex: none; }
      .cwd { font-size: 13px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
      .hint { font-size: 13px; color: var(--dim); }
      .note { padding: 12px 16px; color: var(--dim); }
      .note.error { color: #f4212e; }
      .note button {
        all: unset; display: inline-block; margin-top: 8px; padding: 4px 14px; border-radius: 9999px;
        font-weight: 700; color: var(--bg); background: var(--fg); cursor: pointer;
      }
      .toast {
        position: fixed; z-index: 2147483647; left: 50%; bottom: 32px; transform: translateX(-50%);
        max-width: min(480px, calc(100vw - 32px)); padding: 12px 20px; border-radius: 8px;
        color: #fff; background: #d97757; box-shadow: none;
      }
      .toast.error { background: #f4212e; }
    </style>
    <div class="menu" role="menu" aria-label="Claude Code oturumu seç" hidden></div>
    <div class="toast" role="status" aria-live="polite" hidden></div>`;
  const menu = root.querySelector('.menu');
  const toastEl = root.querySelector('.toast');
  let anchorBtn = null;
  let toastTimer = null;

  function theme() {
    const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(getComputedStyle(document.body).backgroundColor);
    if (!m) return '';
    const [r, g, b] = m.slice(1).map(Number);
    if (r + g + b > 600) return '';
    return r === 0 && g === 0 && b === 0 ? 'dark' : 'dark dim';
  }

  // sticky: bir sonraki bildirime kadar ekranda kalır (uzun süren işler için).
  function toast(text, { error = false, sticky = false } = {}) {
    clearTimeout(toastTimer);
    toastEl.className = `toast ${error ? 'error' : ''}`;
    toastEl.textContent = text;
    toastEl.hidden = false;
    if (!sticky) toastTimer = setTimeout(() => (toastEl.hidden = true), error ? 6000 : 3000);
  }

  function closeMenu({ restoreFocus = false } = {}) {
    if (menu.hidden) return;
    menu.hidden = true;
    menu.replaceChildren();
    anchorBtn?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) anchorBtn?.focus({ preventScroll: true });
    anchorBtn = null;
  }

  function place() {
    if (!anchorBtn) return;
    const r = anchorBtn.getBoundingClientRect();
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const below = r.bottom + 6 + h <= innerHeight;
    menu.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - 6 - h)}px`;
    menu.style.left = `${Math.min(Math.max(8, r.right - w), innerWidth - w - 8)}px`;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function showNote(text, { error = false, action } = {}) {
    const note = el('div', `note ${error ? 'error' : ''}`, text);
    if (action) {
      note.append(el('br'));
      const b = el('button', '', action.label);
      b.addEventListener('click', action.run);
      note.append(b);
    }
    menu.replaceChildren(el('div', 'head', 'Claude Code\'a gönder'), note);
    place();
  }

  function failure(res) {
    const openOptions = { label: 'Ayarları aç', run: () => ask({ type: 'openOptions' }) };
    showNote(res.error || 'Bilinmeyen hata', { error: true, action: res.kind === 'config' || res.kind === 'auth' ? openOptions : undefined });
  }

  // .cwd uzun yolu baştan kısaltmak için direction: rtl kullanır; LRM işaretleri olmadan
  // yoldaki "/" ve "~" gibi nötr karakterler ters dizilir.
  function shortCwd(cwd) {
    return `‎${(cwd || '').replace(/^\/Users\/[^/]+/, '~')}‎`;
  }

  // "Yeni oturum": relay ilk turu arka planda yapıp oturumu Claude Desktop'ta açar (birkaç saniye sürer).
  async function openNewSession(tweet) {
    closeMenu();
    toast('Yeni oturum hazırlanıyor; birkaç saniye içinde Claude\'da açılacak…', { sticky: true });
    const res = await ask({ type: 'newSession', tweet });
    if (!res?.ok) return toast(res?.error ?? 'Yeni oturum açılamadı.', { error: true });
    toast(`Claude'da açıldı: ${res.data.name}`);
  }

  async function send(session, tweet, btn) {
    showNote(`"${session.name}" oturumuna gönderiliyor…`);
    const res = await ask({ type: 'send', sessionId: session.id, tweet });
    if (!res?.ok) return failure(res ?? {});
    closeMenu();
    const extra = res.data.batched > 1 ? ` (${res.data.batched} gönderi tek mesajda)` : '';
    toast(`Gönderildi → ${session.name}${extra}`);
  }

  function tweetOf(article) {
    try {
      return x2cExtract.extractTweet(article);
    } catch {
      return null;
    }
  }

  const statusIdOf = (url) => /\/status\/(\d+)$/.exec(url ?? '')?.[1] ?? null;

  // Sol tık: arşive kaydet. Relay kuyruğa yazar; arşivci oturumu açıksa ona da iletir.
  async function save(btn, article) {
    const tweet = tweetOf(article);
    if (!tweet?.url) return toast('Bu gönderinin bağlantısı okunamadı.', { error: true });
    if (btn.dataset.state === 'busy') return;
    const prev = btn.dataset.state;
    btn.dataset.state = 'busy';
    const res = await ask({ type: 'save', tweet });
    if (!res?.ok) {
      btn.dataset.state = prev ?? '';
      return toast(res?.error ?? 'Kaydedilemedi.', { error: true });
    }
    markSaved(btn);
    const d = res.data;
    const told = d.notified?.length ? ` · ${d.notified.join(', ')} bilgilendirildi` : '';
    if (d.already) toast('Bu gönderi zaten arşivde.');
    else if (d.karar === 'jev') toast(`Kaydedildi → ${d.kategori}${told}`);
    else if (d.archivist) toast(`Arşivciye gönderildi; ${d.archivist} sınıflandırıyor${told}`);
    else if (d.waking) toast(`Kuyruğa alındı; arşivci arka planda uyandırılıyor${told}`);
    else toast(`Kuyruğa alındı; arşivci oturumu açılınca işlenecek${told}`);
  }

  function markSaved(btn) {
    btn.dataset.state = 'saved';
    btn.title = 'Arşivde — sağ tık: Claude Code oturumuna gönder';
    btn.setAttribute('aria-label', 'Arşivde. Sağ tık ya da Shift+Enter: Claude Code oturumuna gönder');
  }

  // Ekrana gelen gönderilerin arşivde olup olmadığını toplu sorar.
  const pendingIds = new Map(); // id -> düğmeler
  let savedTimer = null;
  function checkSaved(id, btn) {
    if (!id) return;
    if (!pendingIds.has(id)) pendingIds.set(id, []);
    pendingIds.get(id).push(btn);
    clearTimeout(savedTimer);
    savedTimer = setTimeout(async () => {
      const batch = new Map(pendingIds);
      pendingIds.clear();
      const res = await ask({ type: 'saved', ids: [...batch.keys()] });
      if (!res?.ok) return;
      for (const id of res.data.saved) for (const b of batch.get(id) ?? []) markSaved(b);
    }, 400);
  }

  async function openMenu(btn, article) {
    if (anchorBtn === btn) return closeMenu({ restoreFocus: true });
    closeMenu();

    const tweet = tweetOf(article);
    if (!tweet?.url) return toast('Bu gönderinin bağlantısı okunamadı.', { error: true });

    clearTimeout(toastTimer); // ekranın altındaki bildirim menüyü örtmesin
    toastEl.hidden = true;
    anchorBtn = btn;
    btn.setAttribute('aria-expanded', 'true');
    menu.className = `menu ${theme()}`;
    menu.hidden = false;
    showNote('Oturumlar yükleniyor…');

    const res = await ask({ type: 'sessions' });
    if (anchorBtn !== btn) return; // bu arada kapandı ya da başka menü açıldı
    if (!res?.ok) return failure(res ?? {});

    const sessions = res.data.sessions;
    const newItem = el('button', 'item');
    newItem.setAttribute('role', 'menuitem');
    const newRow = el('div', 'row');
    newRow.append(el('span', 'name', '＋ Yeni oturum'));
    newItem.append(newRow, el('div', 'hint', 'Bu gönderiyle Claude Desktop\'ta yeni bir oturum açar'));
    newItem.addEventListener('click', () => openNewSession(tweet));
    const items = [newItem, ...sessions.map((s) => {
      const item = el('button', 'item');
      item.setAttribute('role', 'menuitem');
      const row = el('div', 'row');
      row.append(el('span', 'name', s.name));
      if (s.entrypoint) row.append(el('span', 'badge', ENTRYPOINTS[s.entrypoint] ?? s.entrypoint));
      item.append(row);
      if (s.cwd) item.append(el('div', 'cwd', shortCwd(s.cwd)));
      item.addEventListener('click', () => send(s, tweet, btn));
      return item;
    })];
    menu.replaceChildren(el('div', 'head', 'Claude Code\'a gönder'), ...items);
    place();
    items[0].focus({ preventScroll: true });
  }

  // Menü içinde ok tuşlarıyla gezinme, Escape ile kapatma.
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('.item, .note button')];
    const i = items.indexOf(root.activeElement);
    if (e.key === 'Escape') closeMenu({ restoreFocus: true });
    else if (e.key === 'ArrowDown') items[(i + 1) % items.length]?.focus();
    else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  document.addEventListener(
    'pointerdown',
    (e) => {
      const path = e.composedPath();
      if (!menu.hidden && !path.includes(host) && !path.includes(anchorBtn)) closeMenu();
    },
    true,
  );
  // X zaman çizelgesi içerik yüklerken kendiliğinden kaydırabilir: menü kapanmaz, düğmeyi izler;
  // düğme ekrandan çıkar ya da DOM'dan kalkarsa kapanır.
  let follow = false;
  function followAnchor() {
    follow = false;
    if (menu.hidden || !anchorBtn) return;
    const r = anchorBtn.getBoundingClientRect();
    if (!anchorBtn.isConnected || r.bottom < 0 || r.top > innerHeight) closeMenu();
    else place();
  }
  function scheduleFollow() {
    if (!follow) {
      follow = true;
      requestAnimationFrame(followAnchor);
    }
  }
  addEventListener('resize', scheduleFollow);
  addEventListener('scroll', scheduleFollow, { passive: true });

  // ---- düğmeyi eklemek ----

  function inject(article) {
    if (article.querySelector(':scope .x2c-wrap')) return;
    const bookmark = article.querySelector('[data-testid="bookmark"], [data-testid="removeBookmark"]');
    const group = bookmark?.closest('[role="group"]') ?? article.querySelector('[role="group"]');
    if (!group) return; // eylem çubuğu henüz çizilmedi; bir sonraki taramada tekrar denenir

    const wrap = el('div', 'x2c-wrap');
    const btn = el('button', 'x2c-btn');
    btn.type = 'button';
    btn.innerHTML = ICON;
    btn.setAttribute('aria-label', 'Arşive kaydet. Sağ tık ya da Shift+Enter: Claude Code oturumuna gönder');
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.title = 'Arşive kaydet — sağ tık: Claude Code oturumuna gönder';
    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    btn.addEventListener('click', (e) => {
      stop(e);
      if (e.shiftKey) openMenu(btn, article);
      else save(btn, article);
    });
    btn.addEventListener('contextmenu', (e) => {
      stop(e);
      openMenu(btn, article);
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ContextMenu' || (e.shiftKey && (e.key === 'F10' || e.key === 'Enter'))) {
        stop(e);
        openMenu(btn, article);
      }
    });
    wrap.append(btn);
    checkSaved(statusIdOf(tweetOf(article)?.url), btn);

    if (bookmark) bookmark.parentElement.after(wrap);
    else group.append(wrap);
  }

  let scheduled = false;
  function scan() {
    scheduled = false;
    document.querySelectorAll('article[data-testid="tweet"]').forEach(inject);
  }
  new MutationObserver(() => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(scan);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  document.documentElement.append(host);
  scan();
})();
