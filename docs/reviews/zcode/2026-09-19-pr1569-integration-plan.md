# PR #1569 → main Entegrasyon Planı v2 (bulut LLM el kitabı)

> Bu belge sunucuya erişimi OLMAYAN bir mühendis/LLM için yazıldı: yalnız GitHub
> repo'sundan çalışılır. Canlı droplet'e (89.38.97.90) dair hiçbir adım içermez.
> **v2 güncellemesi (2026-09-20):** main'in ilerlemesi incelendi; aşağıdaki
> Faz 1 iptal edildi — main'de daha iyi/eşdeğer çözümler zaten merge edilmiş.

## KAPSAM ÇİTİSİ

Bu plan **yalnızca PR #1569'un frontend + AquaMobil içeriğinin main'e
taşınmasıdır.** Repo'daki ARIA lane'leri, findings kayıtları, gateway/
infra fix'leri, dependabot ve diğer açık PR'lar (#1604–#1653 arası lane'ler
dahil) **bu planın kapsamı DIŞINDADIR** — onlara dokunulmaz, merge
edilmez, değiştirilmez. Ayrıca `infrastructure/docker/nats/nats.conf`
canlıda elle yamalıdır; ACL değişikliği yalnız generator'dan üretilir
(bkz. "Dokunma listesi").

## 0. DURUM ÖZETİ (2026-09-20 itibarıyla)

- **origin/main ilerledi** (`b5e04c653`+); canlı droplet artık main-build
  imajlarıyla çalışıyor ve login ÇALIŞIYOR (canlıda doğrulandı).
- **PR #1569'un backend katmanı ARTIK GEREKSİZ** — main'de eşdeğerleri var:

  | PR #1569'daki bulgu | main'deki çözüm (daha temiz) |
  |---|---|
  | login fence `updatedAt` ms-truncation | `6a7b90b33` — tamsayı **credentialVersion** fence'i (ORPHAN-CRITICAL-808) |
  | NATS inbox önekindeki boş-token | `012bc5f3a` (PR #1637) — noktasız önek + her JetStream kullanıcısına `$JS.API.INFO` |
  | durable consumer "already exists" | PR #1642 — mevcut consumer yerinde güncellenir |

  → **Faz 1 (backend split PR) İPTAL.** Bu üç konuda #1569'dan bir şey taşıma;
  #1569'dan geriye kalan tek gerçek blok **frontend + mobil** işi.

- **Kalan içerik (yalnız #1569'da, main'de YOK):**
  1. SUDERRA restyle — farm-module (`sd-*` kabukları: storage/tasks/maintenance/
     harvest/reports/environment/water-chemistry/finance/analytics), tenant-admin,
     shell CSS compat katmanı (I–V)
  2. AquaMobil v4 (SUDERRA FIELD) — tablet/phone kabuk ayrımı, SUDERRA logo +
     PWA ikonları, web-login minyatürü, offline/i18n/SSoT düzeltmeleri
  3. i18n tek-katalog (m.*) + `CONNECTION-STATUS.md` + `validate-e2e.mjs` +
     `ui-walkthrough.js`
  4. TR→EN çeviri geçişleri (main'in kendi i18n mimarisi var — bkz. Faz 2)
- Kaynak dallar (hepsi GitHub'da): `feat/suderra-session-20260917` (PR #1569
  başı — TÜM içerik push'lu) ve `feature/aquamobil-v4-redesign` (v4'ün orijinali).
  Bu belge yalnız GitHub'dan erişilebilir varlıklara referans verir; sunucudaki
  iş- çalışma ağaçları referans DEĞİLDİR.

## 1. main'in design-system mimarisi (uyum ZORUNLU)

- **Primitifler** (shared-ui): `Button/Input/Select/Textarea`, `DataTable`,
  `PageHeader`, `Spinner`, `Tabs`, `EmptyState/ErrorState`, `BottomSheet`,
  `Popover/Menu/Tooltip`, `Badge`. Sayfa kendi kontrolünü DEĞİL bunları kullanır.
- **Tek ikon sistemi:** lucide-react.
- **Renk:** `web/shared-ui/src/styles/theme.css` TypeScript colour-token'ları +
  dark pair'ler. **SUDERRA tokenları zaten burada** (`--color-sd-paper`,
  `-parchment`, `-ink`, `-teal`, ...). Çiğ Tailwind hue'u yasak.
- **i18n:** hesapta kalıcı, değiştirilebilir locale; `hardcodedText` ratchet'i —
  **hardcode İngilizce string YASAK**, mesaj anahtarı + default locale `en`.
- **Ratchet invariant'ları:** raw-table, rawSpinner, rawPageTitle, inline-style,
  raw-palette, hardcodedText. Push öncesi `npm run invariants:fast` koş.
- **Doğrulama zinciri:** pre-push `type-check-changed-files.mjs` (değişen dosya
  sıkı tsc), CI compose süpergraf drift=0, codegen tazelik, format-scope
  determinizmi (`npm run quality:format-scope:generate`).

## 2. FAZ A — Dalı tazele

```
git fetch origin
git checkout feat/suderra-session-20260917
git merge origin/main   # çakışmalar Faz B prensipleriyle çözülür:
                        # main'in dosyası BAZ ALINIR, bizim katman yeniden uygulanır
```

## 3. FAZ B — Frontend: main'in sistemine UYARLAYARAK yaz (modül modül)

Prensip: **main'in dosyasını baz al, SUDERRA'yı token'larla ver.**

1. `git checkout origin/main -- <modül>` ile main sürümünü baz al.
2. SUDERRA görünümü: `sd-*` compat sınıfları YERİNE `theme.css`'teki
   `--color-sd-*` tokenlarını primitifler üstünde kullan (PageHeader/Spinner/
   DataTable zaten temadan boyar; çoğu sayfada ek CSS GEREKMEZ).
3. İngilizce: metinler mesaj anahtarına (shared-ui locale kataloğu), default
   locale `en`. Hardcode string bırakma — ratchet kırmızı verir.
4. Sırayla ayrı PR: farm-module → tenant-admin → shell (compat V katmanı
   büyük olasılıkla GEREKSİZ — token yaklaşımıyla silinir) → reports (farm
   içinde) → sensor/dashboard/hr kalıntıları.
5. Her PR öncesi: `npm run invariants:fast` + format-scope generate.

**#1569'dan ne kopyalanır:** her sayfanın *yaptıkları* değil *gördükleri* —
bilgi amaçlı: eyebrow/serif başlık/sd-stat-card desenleri, İngilizce metinler
(anahtar kaynağı olarak), DATA SOURCES notları, `sd-stat-card--danger` gibi
davranışsal kalıplar. Uygulama main'in primitifleriyle yeniden yazılır.

## 4. FAZ C — AquaMobil v4 (ayrı PR)

- main'in aquamobil'u kendi büyük refaktöründen geçti (Konsta yok,
  Field/Switch/Button/ListRow, PageHeader, BottomSheet, pull-to-refresh).
- SUDERRA FIELD tasarımı BU sözlüğe taşınır — birebir kopya DEĞİL.
  GitHub-görünür referanslar: **PR #1569 dalındaki** (`feat/suderra-session-20260917`)
  aquamobil ağacı (uyarlanmış, testli hali) ve origin'deki
  `feature/aquamobil-v4-redesign` (v4'ün orijinali).
- Aynı PR'a: SW-ready 3s timeout (serviceWorker.ready yarışı), tenant-header
  token-claim SSoT, `CONNECTION-STATUS.md`, `scripts/validate-e2e.mjs` +
  `scripts/ui-walkthrough.js`, PWA ikon/manifest.
- ssot invariant'ının (c)/(d)/(f)/(g) istediği: `src/pwa/operation-registry.ts`
  düz mutasyon stringleri gql belgelerine, payload'lar
  `*MutationVariables['input']` türetmesine.

## 5. FAZ D — PR #1569'un kaderi

Faz B/C PR'ları main'e girince **#1569 kapatılır** (içeriği taşınmış olur;
backend kısmı zaten main'de). Kapatan kişi, kapatma notunda bu belgeye atıf
yapsın: `docs/reviews/zcode/2026-09-19-pr1569-integration-plan.md`.

**CI gate playbook'u (Faz B/C'de karşınıza çıkacak):**
- `entity-diff-witness`: entity değişimi DDL gerektirmiyorsa PR gövdesine
  `ENTITY-DIFF-OK: <service> — <reason>`; gerektiriyorsa migration.
- `docs-check`: markdown satır uzunluğu ≤ 100.
- `validate-closes` / format-scope-derived-scalars: format-scope yenile.
- Compose/codegen kapıları: GraphQL operasyonları süpergrafa göre yaz;
  v4-backend şeması isteyen (VFD/feeder) operasyonlar HARİÇ tutulmalı
  (bkz. `codegen.ts` içindeki mevcut exclusion + açıklama).

## 6. Dokunma listesi (sunucu taraflı — bu belgeden İCRA EDİLMEZ)

- `infrastructure/docker/nats/nats.conf` canlıda elle yamalandı; kalıcı çözüm
  ACL generator'ünün event-bus ile aynı önek formülünü türetmesi. Elle düzenleme
  tek-sahip ilkesiyle sunucu tarafında yönetiliyor.
- Docker deploy / 8443 / Redis rate-limit anahtarları: sunucu operasyonu.
