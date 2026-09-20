# PR #1569 → main Entegrasyon Planı (bulut LLM el kitabı)

> Bu belge sunucuya erişimi OLMAYAN bir mühendis/LLM için yazıldı: yalnız GitHub
> repo'sundan çalışılır. Canlı droplet'e (89.38.97.90) dair hiçbir adım içermez —
> o ayrı bir süreçtir (belge sonundaki "Dokunma listesi").

## 1. Bağlam — bilinmesi gereken durum

- **PR #1569** — dal: `feat/suderra-session-20260917`, head `664c0b67b`, OPEN.
  main korumalı: 4 zorunlu kontrol (`sens-enterprise-summary`, `merge-gate`,
  `aria-merge-authority`, `build-status`); strict + bu dört yeşil olmadan merge yok.
- origin/main ayrılma noktasından beri **121 web commit'i** aldı: sistematik bir
  design-system kampanyası (aşağıda). PR'ın web değişikliklerinin **623 dosyası**
  bu commit'lerle çakışıyor.
- PR üç katman taşır:
  - **(A) Backend düzeltmeleri** — main ile **çakışmasız**: login token fence
    (ms-truncation), NATS inbox öneki (boş-token bug'ı), JetStream durable
    consumer re-attach, auth-service testleri (824/824 yeşil).
  - **(B) Web frontend SUDERRA portu** — farm-module, tenant-admin, shell CSS
    compat katmanı, AquaMobil v4: main'in yeni sistemiyle **çakışıyor/eskimiş**.
  - **(C) Gate/envanter dosyaları** — invariants, format-scope, lockfile.
- Canlı droplet bu içerikten LOKAL imajlarla çalışıyor (login açık, doğrulanmış);
  GitHub main'den build alan yüzeylerde tenant-admin vs. SUDERRA DEĞİL — beklenen
  davranış, iş aşağıda落地 main'e girene kadar.

## 2. main'in design-system mimarisi (uyum zorunlu)

- **Primitifler** (shared-ui): `Button/Input/Select/Textarea`, `DataTable`,
  `PageHeader`, `Spinner`, `Tabs`, `EmptyState/ErrorState`, `BottomSheet`,
  `Popover/Menu/Tooltip`, `Badge`. Sayfa kendi kontrolünü DEĞİL bunları kullanır.
- **Tek ikon sistemi:** lucide-react (703 SVG silindi).
- **Renk:** `web/shared-ui/src/styles/theme.css` TypeScript colour-token'ları +
  dark pair'ler. **SUDERRA tokenları zaten burada** (`--color-sd-paper`,
  `-parchment`, `-ink`, `-teal`...). Çiğ Tailwind hue'u yasak.
- **i18n:** hesapta kalıcı, değiştirilebilir locale; shell chrome/navigation mesaj
  haritalarında; `hardcodedText` ratchet'i — **hardcode İngilizce string YASAK**,
  mesaj anahtarı + default locale `en`.
- **Ratchet invariant'ları** (test olarak eski kalıbı yasaklar): raw-table,
  rawSpinner, rawPageTitle, inline-style, raw-palette, hardcodedText.
  `npm run invariants:fast` yerelde koşulmadan push etmeyin.
- **Doğrulama zinciri:** pre-push `type-check-changed-files.mjs` (değişen dosya
  sıkı tsc), CI'da compose süpergraf drift=0 kapısı, codegen tazelik kapısı,
  format-scope determinizmi (`npm run quality:format-scope:generate`).

## 3. Faz 0 — Dalı tazele

```
git fetch origin
git checkout feat/suderra-session-20260917
git merge origin/main      # çakışmalar Faz 1/2 prensipleriyle çözülür
```

## 4. Faz 1 — Backend split PR (acil, çakışmasız, hızlı merge)

Amaç: login/NATS üretim düzeltmelerini main'e **hemen** sokmak.

```
git checkout -b fix/auth-nats-login-chain origin/main
git checkout feat/suderra-session-20260917 -- \
  apps/auth-service/src/modules/authentication/services/token.service.ts \
  apps/auth-service/src/modules/authentication/services/token.service.spec.ts \
  libs/backend-common/src/nats/nats-connection.factory.ts \
  platform/libs/event-bus/src/nats/nats-event-bus.ts
```

- Commit mesajı için kaynak: `664c0b67b` (aynı dosyalar, gerekçe açıklamaları
  commit gövdesinde hazır — aynen taşıyabilirsiniz).
- Test: `cd apps/auth-service && npx jest` (824/824 beklenir) + root
  `node scripts/ci/type-check-changed-files.mjs --base origin/main --head HEAD`.
- PR açıp 4 zorunlu kontrol yeşilince merge edin.

## 5. Faz 2 — Frontend: main'in sistemine UYARLAYARAK yaz (modül modül)

Prensip: **main'in dosyasını baz al, SUDERRA'yı token'larla ver.**

1. `git checkout origin/main -- <modül>` ile main sürümünü baz al.
2. SUDERRA görünümü: `sd-*` compat sınıfları YERİNE `theme.css`'teki
   `--color-sd-*` tokenlarını primitif üstünde kullan (PageHeader/Spinner/
   DataTable zaten temadan boyar; çoğu sayfada ek CSS GEREKMEZ).
3. İngilizce: metinleri mesaj anahtarına taşı (`shared-ui` locale kataloğu),
   default locale `en`. Hardcode string bırakma — `hardcodedText` ratchet kırmızı verir.
4. Her modül ayrı PR, sırayla: farm-module → tenant-admin → shell (compat V
   katmanı büyük olasılıkla GEREKSİZ — token yaklaşımıyla silinir) → reports
   (farm içinde) → sensor/dashboard/hr.
5. Her PR öncesi: `npm run invariants:fast` +
   `npm run quality:format-scope:generate` (yeni/anan dosyalar için).

## 6. Faz 3 — AquaMobil v4 (ayrı PR)

- main'in aquamobil'u kendi büyük refaktörünü geçti (Konsta yok, Field/Switch/
  Button/ListRow primitifleri, PageHeader, BottomSheet, pull-to-refresh).
- SUDERRA FIELD tasarımı BU sözlüğe taşınır; `feat/aquamobil-v4-merge` dalındaki
  v4 kaynaklarına bakılabilir ama birebir kopya DEĞİL (primitiflere çevir).
- Bu PR'a aquamobil'ın sair düzeltmeleri de girer: SW-ready 3s timeout,
  tenant-header token SSoT, CONNECTION-STATUS.md, validate-e2e.mjs.
- Bilinen açık iş (harita): `src/pwa/operation-registry.ts` düz mutasyon
  stringleri gql belgelerine çevrilip payload'lar `*MutationVariables['input']`
  türetilecek (ssot invariant'ının c/d/f/g kuralları bunu ister).

## 7. Faz 4 — PR #1569'un kaderi

- Faz 1 çıkınca #1569'dan o commit'ler geri çekilir (ya da #1569 kapatılıp
  kalan içerik Faz 2/3 PR'larına referansla taşınır — commit listesi:
  `664c0b67b` Faz1, `4e49d66da`+`b0df1b451` invariants, gerisi frontend).
- Kalan CI kapıları (Faz 2/3 PR'larında da karşınıza çıkacak):
  - `entity-diff-witness`: entity değişimi DDL gerektirmiyorsa PR gövdesine
    `ENTITY-DIFF-OK: <service> — <reason>` satırı; gerektiriyorsa migration.
  - `docs-check`: markdown lint (satır uzunluğu 100).
  - `validate-closes`/format-scope-derived-scalars: format-scope yenile.

## 8. Dokunma listesi (sunucu taraflı — bu belgeden İCRA EDİLMEZ)

- `infrastructure/docker/nats/nats.conf` canlıda ELLE yamalandı (yedekler
  `nats.conf.bak2/bak3`); kalıcı çözüm ACL **generator**'ünün event-bus ile
  aynı inbox-önek formülünü türetmesi. Elle düzenleme tek-sahip ilkesiyle
  sunucu tarafında yönetiliyor.
- Docker deploy / 8443 / Redis rate-limit anahtarları: sunucu operasyonu.
