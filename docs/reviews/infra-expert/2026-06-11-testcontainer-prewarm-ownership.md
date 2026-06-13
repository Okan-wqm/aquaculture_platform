# Testcontainer imaj prewarm sahipliği: bağımlılık-takipli tek sahip (2026-06-11)

## INFRA-HIGH-011 — Prewarm tek tüketiciye bağlıydı; diğer tüketiciler Jest hook bütçesinde imaj indiriyordu

**Severity:** HIGH · **Owner:** infra-expert · **Cycle:** 2026-06-11-production-opening

### Gözlem

`libs/migration-harness/src/setup.ts` production-eş PostgreSQL imaj pinini
(`timescale/timescaledb-ha:pg16@sha256:b3d0...`) sahiplenir;
`bootPostgresContainer()` bu imajı Testcontainers ile boot eder. Tüketiciler:
migration-harness suite'i + db-migrate'in 3 integration spec'i
(platform-bootstrap / rollback / tenant-schema-provisioner) + gelecekteki her
tüketici.

CI prewarm'ı (`ci-affected.yml` harness adımı, 2026-05-06 + dünkü retry
sertleştirmesi 53a5caa30) YALNIZ `migration-harness` affected olduğunda
koşuyordu; üstelik adımın dosya filtresi kök `package.json` değişikliklerini
bilinçli dışlıyor. Sonuç: kök package metadata'sını değiştiren her PR'da
(örn. #393'ün güvenlik override'ı) db-migrate affected olur, harness adımı
6 saniyede atlar, `Run tests (affected only)` soğuk runner'da multi-GB imajı
`beforeAll`'un 120s bütçesinde indirmeye çalışır → hook timeout, 5 test
kırmızı. #393 round-1 ve round-3'te aynı imza (146s suite, prewarm'sız);
#392'de şans eseri sığmış — yapısal olarak bütçe-yetersiz, "kırmızı ya da
şanslı" sınıfı.

### Kök neden

Prewarm sahipliği TEK tüketici projeye (harness adımına) gömülüydü; oysa
bağımlılık imaja ait ve imajın tüketici kümesi Nx graph'ında zaten tanımlı
(`db-migrate → migration-harness` kenarı mevcut). Sahiplik, bağımlılığı
izlemiyordu.

### Düzeltme (bu PR)

1. **`scripts/ci/prewarm-postgres-testcontainer.ts` (yeni, Node 22
   type-stripping):** affected test projeleri (`nx show projects --affected
   --with-target=test --json`) ∩ `migration-harness`'in Nx-graph ters-geçişli
   bağımlıları boş değilse, kanonik imajı (mevcut
   `print-migration-harness-postgres-image.mjs` SSOT okuyucusuyla — digest
   kopyası YOK) 3-deneme/backoff ile çeker; çekilemezse fail-closed exit 1
   (Jest'e düşen örtük hook-timeout kırmızısına çevrilmez).
2. **`ci-affected.yml`:** test adımlarından ÖNCE bağımsız
   "Prewarm PostgreSQL testcontainer image (dependency-aware)" adımı;
   harness adımındaki inline for-loop prewarm söküldü — tek prewarm sahibi.

### Tier sınıfı

Tier-2 (make it automatic): yeni tüketici eklemek = Nx graph kenarı eklemek;
prewarm kapsamı otomatik genişler, YAML/script değişikliği gerekmez.

### Kanıt

- `.github/workflows/ci-affected.yml:365` (önceki harness-içi prewarm)
- `apps/db-migrate/src/__tests__/platform-bootstrap.integration.spec.ts:107`
  (beforeAll 120s)
- #393 run 27360241408 `test` job'ı: harness adımı 6s (atlandı) →
  platform-bootstrap 5×hook-timeout 146s
- Lokal uçtan uca koşu: tüketiciler `invariants, migration-harness,
  farm-service, db-migrate` doğru çözüldü, pinli digest çekildi
