# SUDERRA tenant-admin port — pilot recipe (TenantUsers = exemplar)

Bu dal `origin/main`'den temiz başlar; push/PR yalnız **tavan kapısı** main'e
girdikten sonra yapılır (koordinasyon kararı, 2026-09-20).

## Port reçetesi (dosya başına)

1. **main'in dosyası BAZ** — primitifler (`PageHeader`, `Button`, `DataTable`,
   `Spinner`) ve mevcut sınıflar olduğu gibi kalır. Bizim dalın dosyası yalnız
   *gördükleri* için referans alınır (`origin/feat/suderra-session-20260917`).
2. **SUDERRA görünümü token utility'leriyle:** `@theme` bloğu `--color-sd-*`
   tokenlarını Tailwind v4 utility'sine çevirir → `bg-sd-paper`,
   `text-sd-ink`, `text-sd-teal`, `bg-sd-parchment` vb. Serif başlık:
   `font-display` (`--font-display` token). **Çiğ hue YAZMA** — ratchet sayar.
3. **Eyebrow:** `PageHeader`'ın `eyebrow` slot'una sd-teal uppercase etiket.
4. **Metinlere DOKUNMA** — `hardcodedText` ratchet'i *birebir eşitlik*
   (`count === ceiling`, tenant-admin=503). Bir string'i mesaj anahtarına
   taşıyorsan YAML tavanını AYNI commit'te düşür; hiç dokunmuyorsan sayı
   değişmez. Bu pilotta görsel katman tek başına taşındı → tavan sabit.
5. Doğrulama: `cd web/modules/tenant-admin && npx vitest run` (146/146) +
   root'ta `npx jest --config tests/invariants/jest.config.ts --selectProjects
   layer-1 --testPathPatterns web-design-system-ratchet` (17/17).
6. Eksik 40 SUDERRA rengi için: tavan-kapısı PR'ındaki yeni tokenları bekle
   (bulut LLM 20 adet hazırladı); o gelene kadar mevcut 22 tokenla sınırlı kal.

## Eyebrow ve tavan etkileşimi (doğrulanmış nüans)

Eyebrow'a eklenen "People & access" YENİ bir görünür metin — ama sayıcıya
düşmüyor, çünkü kaynakta `&amp;` olarak yazılı ve dedektörün JSX-metin
regex'i karakter sınıfından `;`'yi dışlıyor (`[^<>{};=]`). Ayrıca `title`
değişimi net-sıfır: main'deki `title="Users"` ATTR sayacından gelirken,
bizim `<span>Users</span>` JSX sayacından geliyor — birebir takas.
**Canlı sayım: 503 === tavan 503** (aynı regex'lerle programatik doğrulandı).

KIRILGANLIK UYARISI: metni düz `&` ile yazan herkes sayıyı 504 yapar ve
kırmızı görür. Rebase'te (#1629 sonrası tavan 500'e düşer) canlı sayım
yeniden doğrulanmalı — bu dosyada metin eklememek koşuluyla 500'de kalır.

## Örnek diff özeti (TenantUsers.tsx)

- kök: `space-y-6` → `min-h-screen bg-sd-paper text-sd-ink space-y-6`
- PageHeader: `title={<span className="font-display tracking-tight">Users</span>}`
  + `eyebrow={<span className="text-[11px] font-bold uppercase
  tracking-[0.13em] text-sd-teal">People & access</span>}`
