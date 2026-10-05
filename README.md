# x-to-claude

X'teki bir gönderiyi, bu Mac'te açık bir Claude Code oturumuna tek tıkla gönderir. Şartname: [SPEC.md](SPEC.md).

```
Chrome eklentisi (x.com)  ──HTTP, token──▶  yerel relay (127.0.0.1:47615)  ──Unix soket──▶  Claude Code oturumu
                                                  ▲
                              ~/.x-to-claude/sessions/*.json  ◀── SessionStart / SessionEnd hook'ları
```

## Durum

| Parça | Durum |
|---|---|
| Relay: `/sessions`, `/send`, token, Origin ve Host denetimi, boyut ve oran sınırı, ardışık gönderileri birleştiren kuyruk | Hazır, testli |
| Oturum kaydı hook'ları ve kurulum betiği | Hazır, testli; bu Mac'te kurulu (2026-10-05) |
| Chrome eklentisi: düğme, oturum menüsü, bildirim, ayarlar | Hazır; Arc'ta gerçek x.com'da uçtan uca denendi (2026-10-05) |
| Gelen kutusu soketinin mesaj formatı (`relay/inbox.mjs`) | Doğrulandı; relay'den bir Claude Code oturumuna uçtan uca teslim denendi |

## Kurulum

Gereken: Node 20+ ve Chromium tabanlı bir tarayıcı (Chrome 116+, Arc). Dış bağımlılık yok.

1. Relay'i başlat ve token'ı eklenti klasörüne yaz (`extension/relay.json`, 0600, `.gitignore`'da):
   ```bash
   npm run relay
   ```
   ```bash
   npm run extension:config
   ```
2. Hook'ları kullanıcı ayarlarına ekle (`~/.claude/settings.json`, önce yedek alınır). Önce ne yazılacağını görmek için `--dry-run` kullan:
   ```bash
   node scripts/install-hooks.mjs --dry-run
   ```
   ```bash
   npm run hooks:install
   ```
   Kurulumdan **sonra** başlayan ya da devam ettirilen oturumlar listede görünür.
3. Eklentiyi yükle: `chrome://extensions` (Arc'ta `arc://extensions`) → Geliştirici modu → "Paketlenmemiş öğe yükle" → `extension/` klasörü. Token `relay.json` dosyasından okunur. İstersen eklenti simgesine tıklayıp ayarlar sayfasında "Bağlantıyı dene"ye bas.
4. İstersen ayarlar sayfasında görünen eklenti kimliğini `~/.x-to-claude/config.json` içindeki `extensionId` alanına yaz. Bundan sonra relay yalnız bu eklentiden gelen istekleri kabul eder. Paketlenmemiş eklentinin kimliği klasör yolundan türetilir, bu yüzden klasör taşınırsa kimlik değişir.
5. Relay'in oturum açılışında başlaması ve çökerse yeniden başlaması için launchd ajanını kur:
   ```bash
   npm run launchd:install
   ```
   Durumunu görmek için `npm run launchd:status`, kod ya da `config.json` değişince yeniden başlatmak için `npm run launchd:restart`, kaldırmak için `npm run launchd:uninstall` kullan. Kayıtlar `~/.x-to-claude/relay.log` dosyasına yazılır. Ajan kurulum anındaki Node'un mutlak yolunu kullanır: nvm ile Node sürümü değişirse kurulumu yeniden çalıştır.

## Teslim kuralları

Relay hedef oturumun alt süreci değildir ve kimlik doğrulama satırı göndermez. Claude Code bu yüzden mesajı "izin sınıfı belirtmeyen başka bir oturumdan" gelmiş gibi işler:

- **İzin soran oturumlar** (normal, auto, acceptEdits) mesajı hemen teslim eder.
- **İzinleri atlayan (bypass) oturumlar** mesajı onay için bekletir:
  - Terminalde bir onay penceresi açılır.
  - Masaüstü uygulaması ve VS Code bu pencereyi gösteremez; mesaj 5 dakika sonra düşer.
  - Böyle oturumlara da göndermek istiyorsan `crossSessionInbound` ayarını `"accept"` yap. Bu ayar diğer oturumlardan gelen bütün mesajlara uygulanır.
  - Bu Mac'te ayar kullanıcı ayarlarında `"accept"`. Şu senaryo denendi ve çalıştı: launchd'ye bağlı, yani hiçbir oturumun alt süreci olmayan bir relay'den bypass modundaki bir masaüstü oturumuna gönderim. Ayar açık oturumda yeniden başlatma gerekmeden devreye girdi.

Relay'in `ok` yanıtı yalnız mesajın sokete yazıldığı anlamına gelir. Soket yanıt dönmez. Bekletilen ya da atılan mesaj relay'e bildirilmez.

Mesajda `session_id` alanı bulunur. Soket bu arada başka bir oturuma geçmişse Claude Code mesajı atar; mesaj yanlış oturuma gitmez. Bu da denendi.

## Testler

```bash
npm test
```

Testler gerçek Claude oturumlarına dokunmaz. Geçici klasörde kendi sahte gelen kutusu soketlerini açarlar. Eklentinin DOM tarafı için `test/fixtures/x-dom.html` var: `.claude/launch.json` içindeki `fixture` sunucusuyla açılır ve `chrome.runtime`'ı taklit eder. URL'ye `?mode=down|notoken|error` ve `&theme=dark` eklenebilir.

## Güvenlik

- Relay yalnız 127.0.0.1'i dinler. Her istekte `X-Relay-Token` gerekir. Bir `Origin` başlığı varsa `chrome-extension://` olmalıdır. `Host` başlığı 127.0.0.1 ya da localhost olmalıdır; bu, DNS rebinding'e karşı. Relay CORS başlığı göndermez.
- Token yalnız eklentinin service worker'ında durur; x.com sayfasına inmez.
- Gönderi metni rastgele üretilen sınırlayıcılar arasında, "veri, talimat değil" notuyla gider.
- Relay oturumun soket yolunu dışarı vermez. Hook'lar oturum token'ını kaydetmez.

## Bulgular (2026-10-05)

- Masaüstü uygulamasındaki oturumlar da gelen kutusu soketi açıyor (`CLAUDE_CODE_MESSAGING_SOCKET=/tmp/cc-socks/<pid>.sock`).
- Claude Code oturumları kendisi de `~/.claude/sessions/<pid>.json` dosyasına kaydediyor: ad, cwd, durum, `messagingSocketPath`. Bu belgelenmemiş bir iç format. Hook'lara alternatif olabilir ama sürüm değişince bozulabilir. Aynı klasörde `.key` dosyaları da var. Şimdilik belgelenmiş yol olan hook'lar kullanılıyor.
