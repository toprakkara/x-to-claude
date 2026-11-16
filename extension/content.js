// Adds a button to the action bar of every post on x.com, next to the bookmark button.
// A left click saves the post to the archive; a right click lists sessions from the relay and sends it to the chosen one.
// When the relay has the OpenBot target on, a switch at the top of the menu picks Claude Code or OpenBot.
(() => {
  const ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
    '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/></svg>';
  // The button icon in OpenBot mode until the relay has sent the OpenBot logo: two eyes, like OpenBot's.
  const OPENBOT_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2">' +
    '<rect x="3" y="4" width="18" height="16" rx="5"/><circle cx="9" cy="12" r="1.6" fill="currentColor"/><circle cx="15" cy="12" r="1.6" fill="currentColor"/></svg>';
  const ENTRYPOINTS = { cli: 'Terminal', 'claude-desktop': 'Desktop', 'claude-vscode': 'VS Code' };
  const pngDataUrl = (s) => (typeof s === 'string' && s.length < 50_000 && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(s) ? s : null);

  // ---- relay calls (through the service worker) ----

  async function ask(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch {
      return { ok: false, kind: 'reload', error: 'The extension was reloaded; refresh this page.' };
    }
  }

  // ---- target: Claude Code or OpenBot ----
  // Kept in chrome.storage, so every tab and every button's icon follow the switch. The OpenBot logo is kept there too,
  // so the buttons can show it before a menu has opened.
  let mode = 'claude';
  let logo = null;
  const store = chrome.storage?.local;
  store?.get(['x2cMode', 'x2cOpenbotLogo']).then(apply, () => {});
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local') apply(Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, c.newValue])));
  });

  function apply(values) {
    if ('x2cMode' in values) mode = values.x2cMode === 'openbot' ? 'openbot' : 'claude';
    if ('x2cOpenbotLogo' in values) logo = pngDataUrl(values.x2cOpenbotLogo);
    document.querySelectorAll('.x2c-btn').forEach(paintButton);
  }

  function remember(values) {
    apply(values);
    store?.set(values).catch(() => {});
  }

  function paintButton(btn) {
    if (mode === 'openbot' && logo) {
      const img = document.createElement('img');
      img.src = logo;
      img.alt = '';
      btn.replaceChildren(img);
    } else btn.innerHTML = mode === 'openbot' ? OPENBOT_ICON : ICON;
    const saved = btn.dataset.state === 'saved' ? 'In the archive' : 'Save to the archive';
    const target = mode === 'openbot' ? 'an OpenBot agent' : 'a Claude Code session';
    btn.title = `${saved} — right-click: send to ${target}`;
    btn.setAttribute('aria-label', `${saved}. Right-click or Shift+Enter: send to ${target}`);
  }

  // ---- menu and toast: a closed shadow DOM, isolated from the page's CSS ----

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
      .logo { width: 20px; height: 20px; border-radius: 6px; flex: none; align-self: center; }
      .switch { display: flex; gap: 4px; margin: 8px 12px; padding: 3px; border-radius: 9999px; background: var(--hover); }
      .seg { all: unset; flex: 1; text-align: center; padding: 6px 0; border-radius: 9999px; font-weight: 700; font-size: 14px; color: var(--dim); cursor: pointer; }
      .seg[aria-pressed="true"] { background: var(--bg); color: var(--fg); box-shadow: 0 1px 3px rgba(0,0,0,.25); }
      .seg:focus-visible { outline: 2px solid #d97757; outline-offset: -2px; }
      .cwd { font-size: 13px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
      .hint { font-size: 13px; color: var(--dim); }
      .note { padding: 12px 16px; color: var(--dim); }
      .note.error { color: #f4212e; }
      .item.login .name { color: #f4212e; }
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
      .toast.has-action:not([hidden]) { display: flex; align-items: center; gap: 12px; }
      .toast button {
        all: unset; flex: none; padding: 4px 14px; border-radius: 9999px;
        font-weight: 700; color: #0f1419; background: #fff; cursor: pointer;
      }
      .toast button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    </style>
    <div class="menu" role="menu" aria-label="Choose a Claude Code session" hidden></div>
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

  // sticky: stays on screen until the next toast (for long-running work).
  // action {label, run}: adds a button, and the toast stays longer so there's time to press it.
  function toast(text, { error = false, sticky = false, action } = {}) {
    clearTimeout(toastTimer);
    toastEl.className = `toast ${error ? 'error' : ''} ${action ? 'has-action' : ''}`;
    toastEl.textContent = text;
    if (action) {
      const b = el('button', '', action.label);
      b.addEventListener('click', action.run);
      toastEl.append(b);
    }
    toastEl.hidden = false;
    if (!sticky) toastTimer = setTimeout(() => (toastEl.hidden = true), action ? 30_000 : error ? 6000 : 3000);
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
    menu.replaceChildren(el('div', 'head', mode === 'openbot' ? 'Send to OpenBot' : 'Send to Claude Code'), note);
    place();
  }

  function failure(res) {
    const openOptions = { label: 'Open settings', run: () => ask({ type: 'openOptions' }) };
    showNote(res.error || 'Unknown error', { error: true, action: res.kind === 'config' || res.kind === 'auth' ? openOptions : undefined });
  }

  // .cwd uses direction: rtl to shorten long paths from the start; without the LRM marks,
  // neutral characters in the path such as "/" and "~" get reordered.
  function shortCwd(cwd) {
    return `\u200E${(cwd || '').replace(/^\/Users\/[^/]+/, '~')}\u200E`;
  }

  // When the Claude CLI login has expired, the relay opens the sign-in page in the browser and we wait here until it's done.
  // after: what to do once signed in (the interrupted new session). The relay enforces the time limit.
  let loginRun = 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const loginAction = (after) => ({ label: 'Sign in', run: () => startLogin(after) });

  async function startLogin(after) {
    const run = ++loginRun; // "Reopen" cancels the previous wait
    const res = await ask({ type: 'claudeLogin' });
    if (run !== loginRun) return;
    if (!res?.ok) return toast(res?.error ?? 'Couldn\'t start sign-in. Run "claude auth login" in a terminal.', { error: true });
    toast(`The Claude sign-in page opened in your browser. ${after ? 'The session will open by itself once you sign in.' : 'Finish signing in there.'}`, {
      sticky: true,
      action: { label: 'Reopen', run: () => startLogin(after) },
    });
    for (;;) {
      await sleep(2000);
      if (run !== loginRun) return;
      const s = await ask({ type: 'claudeLoginStatus' });
      if (run !== loginRun) return;
      if (s?.data?.running) continue;
      if (!s?.data?.loggedIn) return toast('Claude sign-in wasn\'t completed.', { error: true, action: loginAction(after) });
      return after ? after() : toast('Signed in to Claude.');
    }
  }

  // "New session": the relay runs the first turn in the background and opens the session in Claude Desktop (takes a few seconds).
  async function openNewSession(tweet) {
    closeMenu();
    toast('Preparing a new session; it will open in Claude in a few seconds…', { sticky: true });
    const res = await ask({ type: 'newSession', tweet });
    if (res?.kind === 'claude-login') return toast('Your Claude login has expired, so the session couldn\'t open.', { error: true, action: loginAction(() => openNewSession(tweet)) });
    if (!res?.ok) return toast(res?.error ?? 'Couldn\'t open a new session.', { error: true });
    toast(`Opened in Claude: ${res.data.name}`);
  }

  async function send(session, tweet, btn) {
    showNote(`Sending to "${session.name}"…`);
    const res = await ask({ type: 'send', sessionId: session.id, tweet });
    if (!res?.ok) return failure(res ?? {});
    closeMenu();
    const extra = res.data.batched > 1 ? ` (${res.data.batched} posts in one message)` : '';
    toast(`Sent → ${session.name}${extra}`);
  }

  // OpenBot: the relay sends the post to the agent's chat; the agent answers there.
  async function sendOpenBot(agent, tweet) {
    showNote(`Sending to "${agent.name}" in OpenBot…`);
    const res = await ask({ type: 'openbotSend', agentId: agent.id, tweet });
    if (!res?.ok) return failure(res ?? {});
    closeMenu();
    toast(`Sent → ${agent.name}; it answers in its OpenBot chat`);
  }

  // The agents with Local scripts on. Without any, the menu shows why. With the OpenBot logo from the relay, each
  // agent gets the logo; otherwise an "OpenBot" badge.
  function openBotItems(data, tweet) {
    const icon = pngDataUrl(data.icon);
    const items = data.agents.map((a) => {
      const b = el('button', 'item');
      b.setAttribute('role', 'menuitem');
      const row = el('div', 'row');
      if (icon) {
        const img = el('img', 'logo');
        img.src = icon;
        img.alt = '';
        row.append(img, el('span', 'name', a.name));
      } else row.append(el('span', 'name', a.name), el('span', 'badge', 'OpenBot'));
      b.append(row);
      b.addEventListener('click', () => sendOpenBot(a, tweet));
      return b;
    });
    if (!items.length) items.push(el('div', 'note', data.error || 'No OpenBot agent has Local scripts on.'));
    return items;
  }

  function claudeItems(sessions, tweet, btn) {
    const newItem = el('button', 'item');
    newItem.setAttribute('role', 'menuitem');
    const newRow = el('div', 'row');
    newRow.append(el('span', 'name', '＋ New session'));
    newItem.append(newRow, el('div', 'hint', 'Opens a new Claude Desktop session with this post'));
    newItem.addEventListener('click', () => openNewSession(tweet));
    return [newItem, ...sessions.map((s) => {
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
  }

  // The Claude Code | OpenBot switch at the top of the menu. A change applies to every button and every tab.
  function modeSwitch(rerender) {
    const wrap = el('div', 'switch');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Send to');
    for (const [m, label] of [['claude', 'Claude Code'], ['openbot', 'OpenBot']]) {
      const b = el('button', 'seg', label);
      b.setAttribute('aria-pressed', String(mode === m));
      b.addEventListener('click', () => {
        if (mode === m) return;
        remember({ x2cMode: m });
        rerender({ focusSwitch: true });
      });
      wrap.append(b);
    }
    return wrap;
  }

  function tweetOf(article) {
    try {
      return x2cExtract.extractTweet(article);
    } catch {
      return null;
    }
  }

  const statusIdOf = (url) => /\/status\/(\d+)$/.exec(url ?? '')?.[1] ?? null;

  // Left click: save to the archive. The relay queues the post and, if the archivist session is open, forwards it there too.
  async function save(btn, article) {
    const tweet = tweetOf(article);
    if (!tweet?.url) return toast('Couldn\'t read this post\'s link.', { error: true });
    if (btn.dataset.state === 'busy') return;
    const prev = btn.dataset.state;
    btn.dataset.state = 'busy';
    const res = await ask({ type: 'save', tweet });
    if (!res?.ok) {
      btn.dataset.state = prev ?? '';
      return toast(res?.error ?? 'Couldn\'t save.', { error: true });
    }
    markSaved(btn);
    const d = res.data;
    const told = d.notified?.length ? ` · notified ${d.notified.join(', ')}` : '';
    if (d.already) toast('This post is already in the archive.');
    else if (d.decision === 'jev') toast(`Saved → ${d.category}${told}`);
    else if (d.archivist) toast(`Sent to the archivist; ${d.archivist} is classifying it${told}`);
    else if (d.waking) {
      // The archivist runs on the CLI login; if that has expired it can't wake, and the post waits in the queue.
      const login = await ask({ type: 'claudeLoginStatus' });
      if (login?.data?.loggedIn === false) toast(`Queued. Your Claude login has expired, so the archivist can't run until you sign in${told}`, { action: loginAction() });
      else toast(`Queued; waking the archivist in the background${told}`);
    } else toast(`Queued; it will be processed when the archivist session opens${told}`);
  }

  function markSaved(btn) {
    btn.dataset.state = 'saved';
    paintButton(btn);
  }

  // Asks in bulk whether the posts on screen are already in the archive.
  const pendingIds = new Map(); // id -> buttons
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
    if (!tweet?.url) return toast('Couldn\'t read this post\'s link.', { error: true });

    clearTimeout(toastTimer); // don't let the toast at the bottom cover the menu
    toastEl.hidden = true;
    anchorBtn = btn;
    btn.setAttribute('aria-expanded', 'true');
    menu.className = `menu ${theme()}`;
    menu.hidden = false;
    showNote('Loading sessions…');

    const [res, openbot] = await Promise.all([ask({ type: 'sessions' }), ask({ type: 'openbotAgents' })]);
    if (anchorBtn !== btn) return; // closed in the meantime, or another menu opened
    if (!res?.ok) return failure(res ?? {});

    // Without the OpenBot target the menu is the Claude Code one, with no switch, and the buttons go back to its icon.
    const obOn = !!(openbot?.ok && openbot.data?.enabled);
    if (!obOn && mode === 'openbot') remember({ x2cMode: 'claude' });
    if (obOn && pngDataUrl(openbot.data.icon) !== logo) remember({ x2cOpenbotLogo: pngDataUrl(openbot.data.icon) });

    let loginExpired = false;
    const render = ({ focusSwitch = false } = {}) => {
      const top = obOn ? modeSwitch(render) : el('div', 'head', 'Send to Claude Code');
      const items = mode === 'openbot' ? openBotItems(openbot.data, tweet) : claudeItems(res.data.sessions, tweet, btn);
      if (mode === 'claude' && loginExpired) items.unshift(loginItem());
      menu.replaceChildren(top, ...items);
      place();
      const focus = focusSwitch ? top.querySelector('[aria-pressed="true"]') : menu.querySelector('.item');
      (focus ?? top.querySelector('.seg'))?.focus({ preventScroll: true });
    };
    render();

    // The login state is requested separately: it can take half a second, and the menu doesn't wait for it.
    const login = await ask({ type: 'claudeLoginStatus' });
    if (anchorBtn !== btn || login?.data?.loggedIn !== false) return;
    loginExpired = true;
    if (mode !== 'claude' || menu.querySelector('.login')) return;
    menu.querySelector('.head, .switch')?.after(loginItem());
    place();
  }

  function loginItem() {
    const item = el('button', 'item login');
    item.setAttribute('role', 'menuitem');
    const row = el('div', 'row');
    row.append(el('span', 'name', 'Claude login expired — Sign in'));
    item.append(row, el('div', 'hint', 'New sessions and the archivist won\'t work until you sign in'));
    item.addEventListener('click', () => {
      closeMenu();
      startLogin();
    });
    return item;
  }

  // Arrow-key navigation inside the menu; Escape closes it.
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('.seg, .item, .note button')];
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
  // X's timeline can scroll by itself while loading content, so the menu stays open and follows the button;
  // it closes when the button leaves the screen or the DOM.
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

  // ---- adding the button ----

  function inject(article) {
    if (article.querySelector(':scope .x2c-wrap')) return;
    const bookmark = article.querySelector('[data-testid="bookmark"], [data-testid="removeBookmark"]');
    const group = bookmark?.closest('[role="group"]') ?? article.querySelector('[role="group"]');
    if (!group) return; // the action bar isn't drawn yet; the next scan tries again

    const wrap = el('div', 'x2c-wrap');
    const btn = el('button', 'x2c-btn');
    btn.type = 'button';
    paintButton(btn);
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
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
