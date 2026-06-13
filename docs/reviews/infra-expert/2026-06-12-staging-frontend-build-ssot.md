# Staging frontend build listesi katalog SSOT'una bağlandı (2026-06-12)

## INFRA-MEDIUM-002 — staging↔production frontend build-yöntemi tutarsızlığı

**Severity:** MEDIUM · **Owner:** infra-expert · **Cycle:** 2026-06-10-round2 (K7)

### Gözlem

`deploy-staging.yml` "Build all frontend modules" adımı build listelerini
HARDCODE ediyordu: NX={shell,dashboard,farm-module,admin-panel,tenant-admin}
+ non-NX `npm --workspace`={sensor-module,hr-module,hydroponics-module} +
web/shared-ui. Oysa production deploy'u (deploy-digitalocean.yml:395)
generated `service-catalog.deploy.vars`'tan
`CATALOG_NX_FRONTEND_PROJECTS` / `CATALOG_NON_NX_FRONTEND_PROJECTS`
okuyor — ve katalog SSOT'u (frontendPrebuildPlan) 8 frontend'in HEPSİNİ NX
projesi sayıyor (NON_NX boş). Sonuç: sensor/hr/hydroponics modülleri
staging'de FARKLI toolchain'le (npm workspace) build ediliyor, production'da
NX'le — staging, production'dan farklı derlenmiş frontend gönderebilir.

### Düzeltme (bu PR)

- `deploy-staging.yml` build adımı production deseniyle birebir: aynı
  `service-catalog.deploy.vars`'ı source eder, `CATALOG_NX_FRONTEND_PROJECTS`
  → `nx run-many`, `CATALOG_NON_NX_FRONTEND_PROJECTS` → npm workspace
  (boşsa atlanır). Hardcode liste silindi.
- **Invariant** (`deploy-ssot-contract.spec.ts`): staging build'i katalog
  SSOT'unu tüketmeli + drift'li hardcode liste geri gelemez (Tier-3).

### Tier sınıfı

Tier-2 (make it automatic): yeni frontend eklemek = katalog girdisi;
staging ve production build listesi otomatik aynı kaynaktan akar.

## INFRA-MEDIUM-004 — compose ${VAR:?} ↔ bootstrap env parity (AYRI TAKİP)

**Durum:** OPEN (bu PR'da YOK — neden ayrı: yanlış-invariant deploy bloklar)

`docker-compose.droplet.yml` 32 distinct `${VAR:?}`-zorunlu var taşıyor;
`REQUIRED_ENV_SECRETS` (droplet-bootstrap-env.sh) yalnız 8 generate ediyor.
Fark (24) çoğunlukla `*_SERVICE_DB_PASS` — bunlar bootstrap'ta generate
EDİLMİYOR, GitHub secrets → env → compose ile DIŞARIDAN sağlanıyor. Doğru
INFRA-MEDIUM-004 invariant'ı: her compose `:?` var ∈ {REQUIRED_ENV_SECRETS
∪ dış-sağlanan-allowlist}. Dış-sağlanan allowlist'i (DB-pass'ler + TAG +
POSTGRES_USER + ...) deploy workflow'unun pass-through env'inden DOĞRU
çıkarmadan yazılan invariant, meşru bir deploy'u bloklar. Bu yüzden ayrı,
dikkatli takibe bırakıldı — INFRA-HIGH-012 (TAG) ve CONFIG_ENCRYPTION_KEY/
SERVICE_IDENTITY (ampirik deploy hatalarıyla REQUIRED'a eklendi) bu sınıfın
geçmiş örnekleri. Allowlist tam çıkarılınca ayrı PR.

### Kanıt

- `.github/workflows/deploy-staging.yml:319` (önceki hardcode)
- `.github/workflows/deploy-digitalocean.yml:395` (production SSOT deseni)
- `infrastructure/deploy/service-catalog.deploy.vars` (CATALOG_NX=8, NON_NX boş)
