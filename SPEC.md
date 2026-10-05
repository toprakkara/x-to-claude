# x-to-claude: X'teki bir gönderiyi seçilen Claude Code oturumuna gönderme

> Bu klasör `method_path` araştırma defterinden ayrı bir yazılım projesi. Şartname 2026-10-05'te, `method_path` oturumunda resmî Claude Code dokümanlarına bakılarak hazırlandı.

## Amaç

- **Eklenti:** x.com'daki her gönderinin eylem çubuğuna, yer imi düğmesinin yanına, bir düğme ekleyen bir Chrome eklentisi.
- **Akış:** Düğmeye basınca bu Mac'te açık Claude Code oturumlarının listesi çıkar: terminaldekiler ve masaüstü uygulamasındakiler. Seçilen oturuma gönderi mesaj olarak gider. Mesajın içeriği: URL, metin, yazar, tarih, varsa alıntılanan gönderi ve medya bağlantıları.
- **İlk kullanım:** Legal tech araştırması için ilginç gönderileri `method_path` oturumuna ya da başka proje oturumlarına göndermek.

## Mimari (önerilen)

```
Chrome eklentisi (x.com)
  │  GET /sessions, POST /send   (127.0.0.1, token + Origin kontrolü)
  ▼
Yerel relay (Bun ya da Node)
  │  ~/.x-to-claude/sessions/*.json  ← SessionStart / SessionEnd hook'ları yazar
  ▼
Hedef oturumun gelen kutusu soketi (cross-session messaging, macOS'ta Unix socket)
  ▼
Claude Code oturumu (mesajı bir sonraki turda okur; boştaysa yeni tur başlar)
```

1. **Chrome eklentisi (Manifest V3):**
   - Content script x.com'da gönderileri (`article[data-testid="tweet"]`) MutationObserver ile izler ve eylem çubuğuna bir düğme ekler.
   - Tıklamada küçük bir menü oturumları listeler. Liste relay'in `GET /sessions` yanıtından gelir.
   - Gönderi verisini sayfadaki DOM'dan, yani kullanıcının gördüğü içerikten okur.
2. **Yerel relay:** Yalnız 127.0.0.1'i dinler.
   - `GET /sessions` yaşayan oturumları döndürür: ad, çalışma klasörü, son görülme.
   - `POST /send {sessionId, tweet}` mesajı biçimlendirir ve oturumun gelen kutusu soketine yazar.
3. **Oturum kaydı, Claude Code hook'larıyla:**
   - `SessionStart` hook'u şu bilgileri `~/.x-to-claude/sessions/<id>.json` dosyasına yazar: `CLAUDE_CODE_MESSAGING_SOCKET` (soket yolu), oturum adı, çalışma klasörü ve pid.
   - `SessionEnd` hook'u bu dosyayı siler. Relay ölü soketleri ayrıca temizler.
   - Hook'lar kullanıcı ayarlarına (user scope) eklenir; böylece tüm projelerdeki oturumlar listede görünür.
4. **Teslim:** Oturumlar arası mesajlaşmanın gelen kutusu soketi kullanılır. Mesaj düz metin olarak gider.

## İlk yapılacaklar: doğrulanması gerekenler

1. **Soketin tel formatı:** Doküman bağlantının ilk satırı olarak isteğe bağlı `{"type":"auth","token":"<CLAUDE_CODE_MESSAGING_TOKEN>"}` gönderilebileceğini söylüyor (macOS'ta zorunlu değil). Mesaj satırının alanları o sayfada yazmıyor. `env-vars` ve `cross-session-messaging` sayfalarından ya da kendi oturumuna küçük bir testle belirle. Bağlantı ancak mesaj hazır olduğunda açılmalı; 30 saniye içinde tam satır gelmezse kapanıyor.
2. **Gelen mesaj kuralları:**
   - Relay oturumun alt süreci olmadığı için mesajı başka bir oturumdan geliyormuş gibi işleniyor.
   - Varsayılan kural: İzin soran (normal mod) bir oturum mesajı teslim eder. İzinleri atlayan (bypass) bir oturum mesajı bekletir.
   - Masaüstü uygulaması onay penceresi gösteremez; bekletilen mesaj süre dolunca düşer.
   - Gerekirse hedef oturumlarda `crossSessionInbound: "accept"` kullan.
3. **Masaüstü oturumları:** Dokümana göre masaüstü uygulamasındaki oturumlar da soket açıyor (VS Code ve Desktop için bekletilen mesajlardan söz ediliyor). Test edilmeli.

## MVP adımları

1. Soket formatını kendi oturumuna yazan bir betikle doğrula.
2. SessionStart ve SessionEnd hook'larıyla oturum kaydını kur.
3. Relay'i yaz: `/sessions`, `/send`, token, Origin kontrolü, boyut ve oran sınırı.
4. Eklentiyi yaz: düğme, oturum menüsü, gönderim, hata ve başarı bildirimi.
5. Uçtan uca test: terminal oturumu ve masaüstü oturumu.

## Güvenlik

- **Relay erişimi:** Relay yalnız 127.0.0.1'i dinlemeli. Token (`X-Relay-Token`) ve Origin (`chrome-extension://<id>`) kontrolü şart, çünkü herhangi bir web sayfası localhost'a istek atabilir.
- **İçerik güvenilmez veridir:** Mesaj zarfı gönderinin X'ten geldiğini ve talimat değil veri olduğunu açıkça söylemeli. Bu, prompt injection'a karşı önlem.
- **Sınırlar:** Mesaj boyutu ~1 milyon karakterin altında kalmalı (dokümandaki sınır). Hızlı ardışık gönderimleri oturumun gelen kutusu reddeder; relay bunları kuyruğa alıp birleştirmeli.
- **Kapsam:** Yalnız kullanıcının tıkladığı gönderi gider. DM ya da özel içerik gönderilmez.

## Yedek yol: Channels (araştırma önizlemesi)

- Kendi kanal MCP sunucumuz `capabilities.experimental['claude/channel']` bildirir ve `notifications/claude/channel` yayar.
- Önizleme döneminde hedef oturum `claude --dangerously-load-development-channels server:<ad>` ile başlatılmalı.
- Masaüstü uygulamasında çalışıp çalışmadığı dokümanda yazmıyor.
- Sabit bir "gelen kutusu oturumu" için uygun; "herhangi bir oturumu seç" akışı için değil.

## Kaynaklar

- https://code.claude.com/docs/en/cross-session-messaging ("The session's inbox socket" bölümü)
- https://code.claude.com/docs/en/channels ve https://code.claude.com/docs/en/channels-reference
- https://code.claude.com/docs/en/hooks

## Not

`method_path` oturumuna gönderilen gönderiler o defterin veri ilkelerine tabi: yalnız açık mesleki içerik, X dışı eşleştirme yok, deftere kişi dosyası değil topluluk düzeyinde özet.
