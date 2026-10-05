// X'in DOM'undan bir gönderinin verisini çıkarır. Yalnız kullanıcının ekranda gördüğü içerik okunur.
// Saf fonksiyon: test sayfasında da aynı dosya yüklenir (test/fixtures/x-dom.html).
(() => {
  const STATUS_PATH = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/;
  const HANDLE = /@([A-Za-z0-9_]{1,15})/;

  function statusUrl(href) {
    try {
      const m = STATUS_PATH.exec(new URL(href, location.origin).pathname);
      return m ? `https://x.com/${m[1]}/status/${m[2]}` : null;
    } catch {
      return null;
    }
  }

  // t.co bağlantısının görünen metni genişletilmiş URL'dir; X sonuna "…" ekler.
  function expandedLink(a) {
    const shown = a.textContent.replace(/…$/, '').trim();
    return /^https:\/\/\S+$/.test(shown) ? shown : a.href;
  }

  // Emoji'ler <img alt>, satır sonları <br>, bağlantılar kısaltılmış metinle gelir.
  function readText(el) {
    let out = '';
    (function walk(node) {
      for (const n of node.childNodes) {
        if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue;
        else if (n.nodeName === 'IMG') out += n.alt || '';
        else if (n.nodeName === 'BR') out += '\n';
        else if (n.nodeName === 'A' && /^https:\/\/t\.co\//.test(n.href)) out += expandedLink(n);
        else if (n.nodeType === Node.ELEMENT_NODE) walk(n);
      }
    })(el);
    return out.trim();
  }

  function largeImage(src) {
    try {
      const u = new URL(src);
      if (u.hostname === 'pbs.twimg.com' && u.searchParams.has('name')) u.searchParams.set('name', 'large');
      return u.href;
    } catch {
      return null;
    }
  }

  function readPost(scope, accept) {
    const pick = (sel) => [...scope.querySelectorAll(sel)].filter(accept);
    const userName = pick('[data-testid="User-Name"]')[0];
    const textEl = pick('[data-testid="tweetText"]')[0];
    const time = pick('time[datetime]')[0];

    let author = null;
    if (userName) {
      const [nameBlock, handleBlock] = userName.children;
      author = {
        name: nameBlock ? readText(nameBlock) || null : null,
        handle: HANDLE.exec((handleBlock ?? userName).textContent)?.[1] ?? null,
      };
    }

    const links = [
      ...(textEl ? [...textEl.querySelectorAll('a[href^="https://t.co/"]')].map(expandedLink) : []),
      ...pick('[data-testid="card.wrapper"] a[href^="http"]').map((a) => a.href),
    ];
    const media = [
      ...pick('[data-testid="tweetPhoto"] img[src]').map((img) => largeImage(img.src)),
      ...pick('video[poster]').map((v) => v.poster),
    ];

    return {
      url: time ? statusUrl(time.closest('a[href*="/status/"]')?.href ?? '') : null,
      author,
      time: time?.getAttribute('datetime') ?? null,
      text: textEl ? readText(textEl) : '',
      truncated: pick('[data-testid="tweet-text-show-more-link"]').length > 0,
      media: [...new Set(media.filter(Boolean))],
      links: [...new Set(links.filter(Boolean))],
    };
  }

  function extractTweet(article) {
    // Alıntılanan gönderi, ikinci User-Name'i taşıyan role="link" kutusudur.
    const names = article.querySelectorAll('[data-testid="User-Name"]');
    const quotedBox = names[1]?.closest('div[role="link"]') ?? null;
    const post = readPost(article, (el) => !quotedBox || !quotedBox.contains(el));
    post.quoted = quotedBox ? readPost(quotedBox, () => true) : null;

    // Odaktaki gönderide zaman damgası bağlantısı yoksa, yazar eşleşiyorsa sayfa URL'sini kullan.
    if (!post.url) {
      const pageUrl = statusUrl(location.href);
      const pageHandle = pageUrl && STATUS_PATH.exec(new URL(pageUrl).pathname)[1];
      if (pageHandle && pageHandle.toLowerCase() === post.author?.handle?.toLowerCase()) post.url = pageUrl;
    }
    return post;
  }

  globalThis.x2cExtract = { extractTweet };
})();
