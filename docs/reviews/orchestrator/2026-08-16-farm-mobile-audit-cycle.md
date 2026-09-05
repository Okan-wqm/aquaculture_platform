# Farm-service + AquaMobil — çok-ajanlı denetim döngüsü — 2026-08-16

**Cycle:** `2026-08-16-farm-mobile-agent-audit` · **Lane:** A (kod incelemesi) \+ B (ürün denetimi)
\+ D (veritabanı E2E)
**Kapsam:** (241
TS/TSX dosyası, offline-first PWA)

```text
apps/farm-service` (1.604 TS dosyası, 40+ bounded context) ve `web/apps/aquamobil
```

**Verdict:** BLOCK

## Nasıl koşturuldu

Üç Workflow, toplam 59 ajan, 0 ajan hatası.

1. **Denetim** (27 ajan, ~113 dk, 4.727.253 token) — 12 uzman ajan paralel taradı, her uzmanın
   CRITICAL/HIGH iddiası bağımsız bir doğrulayıcıya verildi, ardından iki lane sentezi ve
   bir `*completeness` `critic*` ("bu denetim neyi kaçırdı") çalıştı.
2. **MEDIUM/LOW doğrulaması** (25 ajan, ~47 dk, 2.017.001 token) — ilk turda protokol dışında kalan
   her MEDIUM ve LOW iddia aynı çürütmeden geçti; bu turda severity iki yönlü hareket edebiliyordu.
3. **Kalanların kapatılması** (7 ajan, ~12 dk, 697.476 token) — hâlâ `NOT VERIFIED` duran her bulgu,
   sentez aşamasının kendi CRITICAL/HIGH bulguları dahil.

|                                       |                                           |
| ------------------------------------- | ----------------------------------------- |
| Ham bulgu                             | 149 (131 uzman + 18 sentez)               |
| Doğrulamayı geçen                     | 128                                       |
| Çürütülen                             | 21                                        |
| Doğrulanmadan kalan                   | 0                                         |
| Severity dağılımı (doğrulama sonrası) | CRITICAL 3 · HIGH 20 · MEDIUM 67 · LOW 38 |
| Severity düşürülen                    | 56                                        |
| Severity YÜKSELTİLEN                  | 1                                         |

> **Doğrulama okuması.** Bu döngüde açılan **her** bulgu — CRITICAL'dan LOW'a — aynı çürütme
> protokolünden geçti: bağımsız bir doğrulayıcı her kanıt satırını yeniden açtı ve iddiayı çürütmeye
> çalıştı; kanıt net durmuyorsa varsayılan "çürütüldü". Doğrulanmamış bulgu yok.
>
> 21 iddia düştü. 56 iddia gerçek ama filenden küçük çıktı ve indirildi: CRITICAL→HIGH 5,
> CRITICAL→MEDIUM 2, HIGH→MEDIUM 29, HIGH→LOW 2, MEDIUM→LOW 18.
>
> 1 iddia filenden BÜYÜK çıktı ve yükseltildi: LOW→HIGH 1.
>
> Yani 149 ham iddianın 77 tanesi ya düştü ya da açıldığından daha küçük çıktı. Uzmanların ilk
> severity ataması sistematik olarak şişikti; aşağıdaki tablolar doğrulama sonrası hâli gösterir.
>
> Bu döngüde hiçbir test koşturulmadı — `CTX-MEDIUM-009` tam olarak bunu işaretliyor.

## Uzman raporları

| Ajan                       | Lane   | Verdict     | Bulgu             | Rapor                                                                                                                                              |
| -------------------------- | ------ | ----------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `farm-expert`              | farm   | BLOCK       | 11 (+1 çürütüldü) | [`2026-08-16-farm-service-domain-audit.md`](../../../docs/reviews/farm-expert/2026-08-16-farm-service-domain-audit.md)                             |
| `db-audit-farm-production` | farm   | BLOCK       | 12                | [`2026-08-16-production-biology-partition.md`](../../../docs/reviews/db-audit/db-audit-farm-production/2026-08-16-production-biology-partition.md) |
| `db-audit-farm-operations` | farm   | BLOCK       | 11 (+1 çürütüldü) | [`2026-08-16-operations-partition.md`](../../../docs/reviews/db-audit/db-audit-farm-operations/2026-08-16-operations-partition.md)                 |
| `data-expert`              | farm   | CONDITIONAL | 6 (+4 çürütüldü)  | [`2026-08-16-farm-service-data-layer.md`](../../../docs/reviews/data-expert/2026-08-16-farm-service-data-layer.md)                                 |
| `tenant-isolation-auditor` | farm   | CONDITIONAL | 5 (+2 çürütüldü)  | [`2026-08-16-farm-mobile-tenant-isolation.md`](../../../docs/reviews/tenant-isolation-auditor/2026-08-16-farm-mobile-tenant-isolation.md)          |
| `test-runner`              | farm   | BLOCK       | 11                | [`2026-08-16-farm-mobile-test-health.md`](../../../docs/reviews/test-runner/2026-08-16-farm-mobile-test-health.md)                                 |
| `mobile-app-auditor`       | mobile | BLOCK       | 9 (+1 çürütüldü)  | [`2026-08-16-aquamobil-e2e-audit.md`](../../../docs/reviews/mobile-app-auditor/2026-08-16-aquamobil-e2e-audit.md)                                  |
| `frontend-expert`          | mobile | CONDITIONAL | 12                | [`2026-08-16-aquamobil-architecture.md`](../../../docs/reviews/frontend-expert/2026-08-16-aquamobil-architecture.md)                               |
| `form-write-auditor`       | mobile | BLOCK       | 12                | [`2026-08-16-aquamobil-form-write-paths.md`](../../../docs/reviews/form-write-auditor/2026-08-16-aquamobil-form-write-paths.md)                    |
| `realtime-sync-auditor`    | mobile | BLOCK       | 11                | [`2026-08-16-aquamobil-offline-sync.md`](../../../docs/reviews/realtime-sync-auditor/2026-08-16-aquamobil-offline-sync.md)                         |
| `access-boundary-auditor`  | mobile | BLOCK       | 12                | [`2026-08-16-aquamobil-access-boundaries.md`](../../../docs/reviews/access-boundary-auditor/2026-08-16-aquamobil-access-boundaries.md)             |
| `contract-parity-enforcer` | cross  | CONDITIONAL | 6 (+4 çürütüldü)  | [`2026-08-16-farm-mobile-contract-parity.md`](../../../docs/reviews/contract-parity-enforcer/2026-08-16-farm-mobile-contract-parity.md)            |

## Doğrulanmış CRITICAL / HIGH bulgular

Hepsi bağımsız bir doğrulayıcı tarafından yeniden okundu ve savunuldu. Sentez aşamasının bulguları
da dahil.

| ID                            | Sev      | Bulgu                                                                                                                                                                                   | Kaynak                     |
| ----------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `MOB-CRITICAL-018`            | CRITICAL | Presigned yükleme/indirme URL'leri iç ağa özel `minio:9000` host'una üretiliyor — üretimde tüm medya hattı (kanıt fotoğrafı, mesaj eki, sesli mesaj) tarayıcıdan erişilemez             | `mobileSynthesis`          |
| `PRODUCT-FORM-CRITICAL-001`   | CRITICAL | Mobile Water Quality submits a `parameters` field the backend contract no longer has — every measurement is rejected, and the offline lane still claims success                         | `form-write-auditor`       |
| `PRODUCT-MOBILE-CRITICAL-001` | CRITICAL | Mobile water-quality recording is rejected by the server on every submission; offline it renders a green false success                                                                  | `mobile-app-auditor`       |
| `DB-FARMOPS-HIGH-003`         | HIGH     | ApproveInventoryCount applies variance to `storage_inventory` but never recomputes the item roll-up or the low-stock signal                                                             | `db-audit-farm-operations` |
| `FARM-HIGH-300`               | HIGH ⬇  | AI feeding advice and growth prediction are fabricated from hardcoded constants and served as per-tank/per-batch AI output                                                              | `farm-expert`              |
| `FARM-HIGH-302`               | HIGH     | `skipCapacityCheck` on transferBatch is reachable by `MODULE_USER` with no role gate and produces no audit-log row                                                                      | `farm-expert`              |
| `FARM-HIGH-305`               | HIGH     | AllocateToTankHandler — the initial stocking write — is the last stock mutation still outside the fail-closed tenant transaction boundary                                               | `farm-expert`              |
| `FARM-HIGH-312`               | HIGH     | Transfer yazma yolu hiçbir audit satırı üretmiyor; can güvenliği bypass'ı public GraphQL input'unda                                                                                     | `farmSynthesis`            |
| `FE-HIGH-065`                 | HIGH     | Shipped CSP cannot reach the presigned MinIO origin \- photo/voice/incident upload and attachment rendering are blocked in production                                                   | `frontend-expert`          |
| `MOB-HIGH-019`                | HIGH ⬇  | Mevcut GraphQL kapısı değişken (input) şeklini yapısal olarak göremez: mobil yazma yolunun input tipleri el yazımı aynalar, bu yüzden CRITICAL-001 sınıfı sapma bir kez daha kaçınılmaz | `mobileSynthesis`          |
| `PARITY-LOW-010`              | HIGH ⬆  | Mobile-shaped response DTOs expose domain enums as GraphQL `String!`, and the client silently narrows them back to closed TS unions with no runtime validation                          | `contract-parity-enforcer` |
| `PRODUCT-ACCESS-HIGH-003`     | HIGH     | Feeding entitlement enforcement was lost in the v2 meal cutover — the live mobile write path `recordMealFeeding`/`skipMeal` carries no `@RequiresMobileFeature`                         | `access-boundary-auditor`  |
| `PRODUCT-FORM-HIGH-002`       | HIGH     | Offline clock-in/clock-out carry no event timestamp — hr-service stamps server-`now` at replay, so payroll hours and the attendance date are wrong by the entire offline window         | `form-write-auditor`       |
| `PRODUCT-FORM-HIGH-004`       | HIGH     | `harvestPlanId` is mandatory for large harvests but has no GraphQL input field — harvests over 10 t / 50 k fish are unconditionally rejected with no way to comply                      | `form-write-auditor`       |
| `PRODUCT-FORM-HIGH-005`       | HIGH     | Leave request `totalDays` is client-computed and server-trusted; the Half Day toggle collapses any date range to 0.5 charged days                                                       | `form-write-auditor`       |
| `PRODUCT-MOBILE-HIGH-002`     | HIGH     | Logout — including the automatic one on a failed token refresh — permanently destroys the unsynced offline queue with no warning                                                        | `mobile-app-auditor`       |
| `PRODUCT-MOBILE-HIGH-004`     | HIGH     | Critical alarm acknowledgement shows "Acknowledged" unconditionally from a local queue write, with no queued/failed state and no offline-cache reconciliation                           | `mobile-app-auditor`       |
| `PRODUCT-SYNC-HIGH-001`       | HIGH ⬇  | Logout — including the automatic fail-closed logout — destroys the entire unsynced offline queue with no warning, export or recovery                                                    | `realtime-sync-auditor`    |
| `PRODUCT-SYNC-HIGH-002`       | HIGH     | Exponential backoff is dead code; retries are a fixed 30s loop capped at 5, after which a queued record is permanently undeliverable and can only be deleted                            | `realtime-sync-auditor`    |
| `TEST-HIGH-001`               | HIGH ⬇  | AquaMobil PWA has 66 spec files and no CI execution path — the offline-first suite never runs                                                                                           | `test-runner`              |
| `TEST-HIGH-002`               | HIGH ⬇  | ci-affected.yml `test:invariant` gate resolves to zero projects — permanently green no-op whose comment claims the opposite                                                             | `test-runner`              |
| `TEST-HIGH-004`               | HIGH     | 80 CQRS handler classes and 46 of 51 GraphQL resolvers in farm-service have no spec; coverage floor is ratcheted to 20.39% functions                                                    | `test-runner`              |
| `TEST-HIGH-005`               | HIGH     | ~3,600 lines of feeding-domain service logic have no spec — the highest-frequency operational path in the product                                                                       | `test-runner`              |

⬇ = daha yüksek severity ile açıldı, doğrulayıcı indirdi. ⬆ = daha düşük severity ile açıldı,
doğrulayıcı yükseltti.

## Sentez aşamasında bulunan bulgular

Lane sentezcileri ve completeness critic, uzmanların kaçırdığı bulguları çıkardı. Bunlar da uzman
bulgularıyla aynı çürütme protokolünden geçti (üçüncü tur).

| ID                 | Sev      | Bulgu                                                                                                                                                                                   | Kaynak              |
| ------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `FARM-HIGH-312`    | HIGH     | Transfer yazma yolu hiçbir audit satırı üretmiyor; can güvenliği bypass'ı public GraphQL input'unda                                                                                     | farm sentezi        |
| `FARM-MEDIUM-313`  | MEDIUM   | Uydurulmuş AI yüzeyi üretimde kayıtlı ve `MODULE_USER'a` açık; tek bariyer bir env değişkeni                                                                                            | farm sentezi        |
| `FARM-LOW-314`     | LOW      | PRODUCT-TENANT-HIGH-001'in blast radius listesi MinIO-orphan cron'unu hatalı kapsıyor                                                                                                   | farm sentezi        |
| `MOB-CRITICAL-018` | CRITICAL | Presigned yükleme/indirme URL'leri iç ağa özel `minio:9000` host'una üretiliyor — üretimde tüm medya hattı (kanıt fotoğrafı, mesaj eki, sesli mesaj) tarayıcıdan erişilemez             | mobil sentezi       |
| `MOB-HIGH-019`     | HIGH     | Mevcut GraphQL kapısı değişken (input) şeklini yapısal olarak göremez: mobil yazma yolunun input tipleri el yazımı aynalar, bu yüzden CRITICAL-001 sınıfı sapma bir kez daha kaçınılmaz | mobil sentezi       |
| `MOB-LOW-020`      | LOW      | Presigned PUT imzası Content-Type'a bağlanmıyor: MIME allow-list yalnız presign isteğinde uygulanıyor, imzalı URL'e herhangi bir içerik türü yüklenebiliyor                             | mobil sentezi       |
| `CTX-CRITICAL-001` | CRITICAL | The GraphQL INPUT/variable axis was audited by nobody — it is exactly where the one CRITICAL defect lives, and 14 more hand-written input types sit on the same ungated path            | completeness critic |
| `CTX-LOW-002`      | LOW      | Seven NATS request-reply responders — including a write path — got zero audit attention from both the access-boundary and tenant-isolation agents                                       | completeness critic |
| `CTX-MEDIUM-003`   | MEDIUM   | farm-expert declared nine setup contexts clean with a blanket unverified claim; ten `restore*` mutations in exactly those contexts bypass the CommandBus and emit no domain event       | completeness critic |
| `CTX-MEDIUM-004`   | MEDIUM   | Observability was examined by no agent — and the metrics/alerting stack structurally cannot see the audit's own CRITICAL defect                                                         | completeness critic |
| `CTX-HIGH-005`     | HIGH     | Legal hold and GDPR erasure enforcement is exercised only by specs in the dead test:integration lane — data-expert reported the mechanism as present without noting it is unexecuted    | completeness critic |
| `CTX-MEDIUM-006`   | MEDIUM   | Performance was examined by no agent: 112 @ResolveField against 6 DataLoaders, no query-budget gate, no load test                                                                       | completeness critic |
| `CTX-MEDIUM-007`   | MEDIUM   | Four of the five backends aquamobil actually calls were never read, yet three agents made behavioral claims about them                                                                  | completeness critic |
| `CTX-MEDIUM-008`   | MEDIUM   | Nine aquamobil pages (~2,980 lines) were never opened, including the WebAuthn enrollment half of the accessType bypass the access agent reported                                        | completeness critic |
| `CTX-LOW-009`      | LOW      | Every claim about what CI executes, what is green, and what is stale is a static file read — nothing in this audit was run                                                              | completeness critic |
| `CTX-MEDIUM-010`   | MEDIUM   | farm-service infrastructure and cross-cutting directories got no inventory row from any agent                                                                                           | completeness critic |
| `CTX-MEDIUM-011`   | MEDIUM   | Billing coupling was never examined and does not exist: farm-service has no subscription or plan-tier gate on any write path                                                            | completeness critic |
| `CTX-LOW-012`      | LOW      | Three agents each filed the same water-quality defect as a top finding, inflating the apparent finding count and splitting ownership of one root cause                                  | completeness critic |

### FARM-HIGH-312

**Title:** Transfer yazma yolu hiçbir audit satırı üretmiyor; can güvenliği bypass'ı public GraphQL
input'unda

**Severity:** HIGH · **State:** OPEN · **Kaynak:** farm sentezi (açılış ID `SYNTH-HIGH-001`)
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/batch/handlers/transfer-batch.handler.ts:226 \- yorum: 'skipCapacityCheck is
  honoured for the pre-existing escape hatch used by internal reconciliation jobs'
- apps/farm-service/src/batch/handlers/transfer-batch.handler.ts \- dosya
  genelinde `audit|auditLog|FarmAuditLog` grep'i SIFIR eşleşme (mortality/cull yollarının aksine)
- apps/farm-service/src/batch/dto/batch-resolver.dto.ts:136
  \- `skipCapacityCheck?: boolean` TransferBatchInput üzerinde public @Field
- apps/farm-service/src/batch/resolvers/batch.resolver.ts:463
  \- `@Roles(TENANT_ADMIN, MODULE_MANAGER, MODULE_USER)` transferBatch üzerinde

**Rule violated:**

CLAUDE.md Architectural Approach tier 1 (make-impossible); FARM-HIGH-002'nin genişletilmesi

**Proposed fix direction:**

Kaçış kapısını public şemadan çıkar: `skipCapacityCheck` alanını TransferBatchInput'tan sil, ayrı
bir internal `ReconcileTankAllocationCommand` (yalnızca servis-kimliğiyle erişilebilir) tanımla.
Ayrıca transfer handler'ına mortality/cull ile aynı dayanıklı audit satırını ekle — stok hareketi
üreten her yazma yolu, ortak bir `StockMutationContext` tipi üzerinden audit satırı yazmadan
derlenemesin.

**Affected surface (ripple set):**

- `apps/farm-service/src/batch/commands/transfer-batch.command.ts:23`
- `apps/farm-service/src/batch/resolvers/batch.resolver.ts:466`
- `grading yolu TransferBatchCommand'ı besliyor — aynı gate'i miras alır`
- `apps/farm-service/schema.graphql (SDL snapshot yenilenmeli)`

**Verifier note:**

Verified. batch-resolver.dto.ts:136 does expose `skipCapacityCheck` as a public @Field on
TransferBatchInput (schema.graphql:9898 confirms it is in the published SDL), batch.resolver.ts:463
does gate transferBatch at `MODULE_USER`, and the resolver body (:473-482) spreads `...rest` into
the payload, so the flag reaches the command unfiltered.
transfer-batch.handler.ts:228 `if (!payload.skipCapacityCheck)` skips the TankCapacityService
hard-mode life-safety enforcement. A repo-wide grep for `skipCapacityCheck` finds NO role check
anywhere — the only other authority claim is a false one in
web/modules/farm-module/src/pages/production/components/TransferModal.tsx:173 ('bypass
requires `FARM_MANAGER` role'), which no server code implements. Contrast
allocate-to-tank.handler.ts:195/265-275, where the capacity override is restricted
to `SUPER_ADMIN/TENANT_ADMIN` and writes a `CAPACITY_BLOCKED` `farm_audit_logs` row; transfer has
neither. The audit half of the claim is narrower than filed: grep for audit/AuditLogService in
transfer-batch.handler.ts is indeed zero, but the path is not trailless — it writes
TankOperation `TRANSFER_OUT/TRANSFER_IN` rows and enqueues a BatchTransferredEvent into the
transactional outbox pre-commit (:501-517). So 'no durable trace' overstates;
'no `farm_audit_logs` row, unlike mortality/cull' is accurate. The ungated life-safety escape hatch
on a `MODULE_USER-reachable` public input carries HIGH on its own.

### FARM-MEDIUM-313

**Title:** Uydurulmuş AI yüzeyi üretimde kayıtlı ve `MODULE_USER'a` açık; tek bariyer bir env
değişkeni

**Severity:** MEDIUM · **State:** OPEN · **Kaynak:** farm sentezi (açılış ID `SYNTH-MEDIUM-002`)
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/app.module.ts:461 \- `AiInsightsModule` imports listesinde kayıtlı
- apps/farm-service/src/ai-insights/ai-insights.resolver.ts:41,58,92 \- her
  Query `@Roles(TENANT_ADMIN, MODULE_MANAGER, MODULE_USER)`
- apps/farm-service/src/ai-insights/services/mcp-client.service.ts:81
  \- — kod
  düzeyinde başka guard yok

  ```text
  this.mcpEnabled = this.configService.get<string>('MCP_ENABLED', 'false') === 'true'
  ```

- apps/farm-service/src/ai-insights/services/ai-insights.service.ts:279-287
  \-
  girdi
  değil

  ```text
  predict_feeding_impact` sabit `feedKg: 5.0, biomassKg: 500, tankVolumeM3: 50` ile; `tankId
  ```

**Rule violated:**

CLAUDE.md Architectural Approach tier 1 — 'Make it impossible'

**Proposed fix direction:**

Uydurma girdi sabitlerini savunma katmanına değil tip sistemine taşı: MCP tool çağrılarının girdi
tipi yalnızca repository'den türetilebilen branded bir aggregate snapshot
(ör. `BatchGrowthSnapshot`, `TankFeedingSnapshot`) kabul etsin; literal nesne
derlenmesin. `tenantId` cache anahtarı değil tool payload'unun zorunlu alanı olsun. Düzeltme inmeden
modülün AppModule kaydı snapshot yolunun varlığına bağlansın.

**Affected surface (ripple set):**

- `apps/farm-service/src/ai-insights/services/mcp-client.service.ts`
- `apps/farm-service/src/ai-insights/ai-insights.resolver.ts (5 query)`

  ```text
  apps/farm-service/schema.graphql — TankRiskAssessment/BatchGrowthPrediction/FeedingAdvice
  ```

- `ai-insights dizininde sıfır spec var — düzeltmeyle birlikte spec zorunlu`

**Verifier note:**

Verified, and slightly understated. app.module.ts:461 registers AiInsightsModule unconditionally;
ai-insights.resolver.ts:41,58,77,92,109 gate all five queries
at `@Roles(TENANT_ADMIN`, `MODULE_MANAGER`, `MODULE_USER`) and schema.graphql:5620/5629 shows
tankRiskAssessment/feedingAdvice in the published SDL. mcp-client.service.ts:81 is the only
barrier (`MCP_ENABLED` default 'false'); no other code-level guard exists. The fabricated-input
claim holds at ai-insights.service.ts:279-287 — `predict_feeding_impact` is called with literal
feedKg:5.0/biomassKg:500/tankVolumeM3:50/temperature:22/currentPH:7.5, and the caller's `tankId` is
used ONLY as a Redis cache key and echoed back in the result. The claimer missed a second instance:
getBatchGrowthPrediction (:154-161) calls `calculate_growth_metrics` with literal
currentWeightG:100/currentQuantity:10000/sgr:2.0 and never passes batchId, then returns the result
labelled with the requested batchId. The ripple set also checks out: find over
apps/farm-service/src/ai-insights returns zero `*.spec.ts`. Impact stays MEDIUM rather than higher
only because `MCP_ENABLED` is nowhere set to true in any compose/env file, so the surface currently
returns null/empty in every deployment — the fabrication is shipped but latent.

### FARM-LOW-314

**Title:** PRODUCT-TENANT-HIGH-001'in blast radius listesi MinIO-orphan cron'unu hatalı kapsıyor

**Severity:** LOW · **State:** OPEN · **Kaynak:** farm sentezi (açılış ID `SYNTH-LOW-003`)
**Verification:** REFUTED

**Evidence:**

- apps/farm-service/src/scheduler/cron-jobs.service.ts:945
  \- `await withTenantContext(tenantId, async () => {` — minioOrphanCleanup doğru şekilde tenant
  bağlamı içinde
- apps/farm-service/src/scheduler/cron-jobs.service.ts:908-917 \- gerekçe yorumu: 'Driving it
  per-tenant inside withTenantContext makes the live-set scope and the bucket-delete scope
  structurally identical'
- apps/farm-service/src/scheduler/cron-jobs.service.ts:316-328 \- overdue-maintenance döngüsünde
  withTenantContext yok (bulgu bu cron'lar için geçerli)

**Rule violated:**

Review Finding Traceability — bulgu kapsamı kanıtla birebir örtüşmeli

**Proposed fix direction:**

PRODUCT-TENANT-HIGH-001'in etkilenen-iş listesinden minioOrphanCleanup çıkarılsın; bu cron diğer
cron'lar için hedeflenen `forEachTenantSchema` helper'ının referans uygulaması olarak kullanılsın —
doğru desen zaten repoda mevcut, helper'a çıkarmak tier-2 make-automatic düzeltmesini ucuzlatır.

**Affected surface (ripple set):**

- `apps/farm-service/src/scheduler/feeding-scheduler.service.ts`
- `libs/backend-common forEachTenantSchema helper`

**Verifier note:**

Refuted — the claimer read only the two lines that support the claim and missed the evidence line
inside the finding it is correcting. PRODUCT-TENANT-HIGH-001
(docs/reviews/tenant-isolation-auditor/2026-08-16-farm-mobile-tenant-isolation.md:100-103) already
states that cron-jobs.service.ts:945 withTenantContext 'proves the correct pattern exists in the
same file' AND gives the reason it is still in the blast radius: 'its own discovery query at
:927-928 is still outside it, so that cron self-disables too'. That reason is correct.
cron-jobs.service.ts:923-937 opens a bare discoveryRunner, does a raw `SET search_path`, and calls
resolveTenantIdForSchema (:991-1000), which SELECTs from `batch_documents` and chemicals. Those
tables carry the `tenant_isolation_policy` — database/migrations/1800000000000-Baseline.ts:656 calls
applyTenantRlsToSchema with excludeTables: [] — and the discovery runs with no AsyncLocalStorage
tenant, so rls-connection-bootstrap.service.ts readRlsContext (:255-273) returns tenantId '' →
NULLIF(...)::uuid → NULL → deny-by-default → zero rows → tenantId null
→ `if (!tenantId) continue` at :942 for every schema. minioOrphanCleanup therefore processes zero
tenants, exactly as the original finding says. Its inclusion in the blast radius is correct, not
erroneous; the proposed 'remove it from the list' edit would delete true evidence.

### MOB-CRITICAL-018

**Title:** Presigned yükleme/indirme URL'leri iç ağa özel `minio:9000` host'una üretiliyor —
üretimde tüm medya hattı (kanıt fotoğrafı, mesaj eki, sesli mesaj) tarayıcıdan erişilemez

**Severity:** CRITICAL · **State:** OPEN · **Kaynak:** mobil sentezi (açılış
ID `PRODUCT-MOBILE-SYNTH-CRITICAL-001`)
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- libs/storage/src/minio-client.service.ts:288
  \- — URL,
  client'ın `endPoint: config.endpoint` değerinden türetilir; hiçbir public-endpoint yeniden yazımı
  yok

  ```text
  const url = await this.client.presignedPutObject(this.bucket, path, expirySeconds);
  ```

- apps/farm-service/src/app.module.ts:410
  \- `endpoint: configService.get<string>('MINIO_ENDPOINT', 'localhost')`
- docker-compose.droplet.yml:885 \- farm-service
  bloğunda
  `MINIO_ENDPOINT: minio` / `MINIO_PORT: 9000` / `MINIO_USE_SSL: 'false'` (messaging-service için
  aynısı :1651)
- docker-compose.droplet.yml:615-641 \- `minio:` servisi
  yalnızca `aqua-internal` ağında; `ports:` bloğu yok, nginx conf'larında minio proxy'si yok
- apps/farm-service/src/fish-health/services/incident-media.service.ts:70
  \-
  —
  bu URL doğrudan istemciye döner

  ```text
  const uploadUrl = await this.minio.getPresignedUploadUrl(storageKey, UPLOAD_URL_TTL_SECONDS, input.mimeType);
  ```

**Rule violated:**

CLAUDE.md Architectural Approach — root-cause only; 'Make it impossible' (Tier 1). Ayrıca ADR-045
çok-kiracılı runtime dağıtım sözleşmesi.

**Proposed fix direction:**

Storage config'ine ayrı bir `*public*` endpoint ekle (imzalama için kullanılan tek
SSoT): `StorageConfig` içinde `publicEndpoint`/`publicUseSSL` zorunlu alan olsun
ve `MinioClientService` presign işlemlerini bu endpoint'e bağlı ikinci bir client (ya da imza
sonrası host yeniden yazımı yerine doğrudan doğru endPoint) ile üretsin — Tier 1: iç host'a
imzalanmış bir URL üretmek tip/konfig düzeyinde imkânsız hale gelsin. Alternatif ve tercih
edilebilir dağıtım biçimi: minio'yu nginx altında aynı origin'de `/storage/` yolundan
proxy'le, `publicEndpoint`'i o origin'e sabitle — böylece CSP `connect-src 'self'` zaten yeterli
olur ve ikinci duvar kendiliğinden kalkar. Her iki durumda da üretim profilinde iç ağ
adı (`minio`, `localhost`) tespit edilirse servis cold-start'ta fail-closed olsun (mevcut
schema-drift validator ile aynı idiom). CSP snippet'i ayrı bir origin
seçilirse `connect-src`/`img-src`'a o origin'i eklemeli — ama bu, endpoint düzeltmesinin ardından
gelen ikincil adımdır, tek başına yeterli değildir.

**Affected surface (ripple set):**

```text
web/apps/aquamobil incident/lice/welfare kanıt fotoğrafı hattı (useIncidentMediaUpload.ts)
```

```text
messaging medya + sesli mesaj hattı (useMediaUpload.ts, useOfflineQueue.tsx:111-115 blob replay)
```

```text
SW kapalı-uygulama drain'inin blob atlama kararı (bu hat zaten çalışmıyorken 'sonraki foreground'a ertele' garantisi anlamsız)
```

- `admin-api rapor artefaktları (aynı MINIO_ENDPOINT kalıbı, :1051)`
- `infrastructure/docker/nginx/snippets/security-headers.conf CSP satırı`
- `FE-HIGH-002 bulgusu: CSP tek başına kök neden değil, ikinci duvar`

  ```text
  PRODUCT-MOBILE-MEDIUM-006 / form-auditor 'incident photo' bulguları: offline lane eklense bile bu düzeltilmeden kanıt sunucuya ulaşmaz
  ```

**Verifier note:**

Verified end to end, no mitigating path found. libs/storage/src/minio-client.service.ts:287-291
signs with `this.client.presignedPutObject(...)`, and the client is constructed at :35-47
from `endPoint: config.endpoint` alone; buildFileUrl (:426-436) likewise
concatenates `this.endpoint`. Repo-wide grep for `publicEndpoint`/`MINIO_PUBLIC` returns zero hits —
there is no second endpoint and no post-signature host rewrite anywhere in apps/ or libs/.
docker-compose.droplet.yml (the production runtime per docs/DEPLOY.md:170)
sets `MINIO_ENDPOINT`: minio / `MINIO_PORT`: 9000 for farm-service (:685-687), admin-api (:1051) and
messaging (:1651), while the minio service block (:615-641) is on aqua-internal only with
NO `ports:` mapping, and no nginx conf under infrastructure/docker/nginx/ proxies it. The signed URL
therefore has host `minio:9000`, which the browser cannot resolve. The client consumes it directly:
useOfflineQueue.tsx:111-115 and useIncidentMediaUpload.ts:252-256 / useMediaUpload.ts:236-240
fetch(uploadUrl, {method:'PUT'}). incident-media.service.ts:70 returns that URL straight to the
caller. No invariant test covers MINIO env at all (grep MINIO over tests/invariants is empty).
Whole-feature production outage across evidence photos, message media and voice notes — CRITICAL
stands.

### MOB-HIGH-019

**Title:** Mevcut GraphQL kapısı değişken (input) şeklini yapısal olarak göremez: mobil yazma
yolunun input tipleri el yazımı aynalar, bu yüzden CRITICAL-001 sınıfı sapma bir kez daha kaçınılmaz

**Severity:** HIGH · **State:** OPEN · **Kaynak:** mobil sentezi (açılış
ID `PRODUCT-MOBILE-SYNTH-CRITICAL-002`)
**Kayıt:** registry'de `MOB-HIGH-019` olarak kayıtlı (2026-09-05; bu rapordaki
etiket registry tarafından tahsis edilmemişti, numara tesadüfen örtüştü).
`CTX-CRITICAL-001` aynı kök nedenin kopyası olarak REFUTED edildi ve
kaydedilmedi. Sınıfın gerçekleşmiş örneği `PRODUCT-FORM-CRITICAL-001` /
`PRODUCT-MOBILE-CRITICAL-001` registry'de `MOB-CRITICAL-018`.
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/pwa/operation-registry.ts:169
  \- `mutation CreateWaterQualityMeasurement($input: CreateWaterQualityInput!)` — doküman metni
  geçerli; sapma metinde değil, değişken şeklinde
- web/apps/aquamobil/src/types/index.ts:571 \- `parameters: WaterQualityParameters;` — el yazımı
  ayna alanı ZORUNLU kılıyor, yani tip sistemi bozuk şekli aktif olarak dayatıyor
- apps/farm-service/src/water-quality/dto/create-water-quality.input.ts:75-78
  \- `legacy fixed-shape 'parameters' field was removed` yorumunun ardından
  yalnız `@Field(() => GraphQLJSON) dynamicParameters`
- codegen.ts:47 \- `const aquamobilDocuments = ['web/apps/aquamobil/src/graphql/**/*.ts'];` — kuyruk
  registry'si ve sayfalar dışarıda
- web/apps/aquamobil/src/types/index.ts:418
  \- `MortalityInput | CullInput | HarvestInput | … | CreateWaterQualityInput | …` — TÜM kuyruk
  payload birleşimi el yazımı aynalardan oluşuyor

**Rule violated:**

CLAUDE.md Architectural Approach — Tier 1 'Make it impossible' / Tier 3 'Make it detectable';
Event/Contract Rules — istemci payload'ı sunucu sözleşmesine birebir uymalı

**Proposed fix direction:**

İki adımlı Tier-1 kapanış: (a)
codegen olacak
şekilde genişletip `Types` (input) çıktısını da üret; (b) `types/index.ts` içindeki input aynalarını
sil ve `QueuedPayload` birleşimini üretilen input tiplerinden
türet (`import type { CreateWaterQualityInput } from '@/generated/graphql'`). Böylece sunucudan bir
alan kalktığında derleyici hatası çıkar — doküman metni doğrulaması yerine tip düzeyinde
imkânsızlık. Ek Tier-3 emniyet: `OperationType` → üretilen input tipi
eşlemesini idiomu
— kuyruğa yeni bir op tipi eklendiğinde üretilmiş input tipi olmadan build kırılsın.

```text
documents` globunu `web/apps/aquamobil/src/{graphql,pwa,pages,hooks}/**/*.{ts,tsx}
```

```text
satisfies Record<OperationType, …>` ile bağla, aynı `SYNC_INVALIDATION_SEGMENTS
```

**Affected surface (ripple set):**

- `23 offline replay mutation'ı + 10 colocated gql dokümanı`
- `web/apps/aquamobil/src/types/index.ts:418 QueuedPayload birleşimi`
- `PRODUCT-MOBILE-CRITICAL-001 / PRODUCT-FORM-CRITICAL-001 (aynı kök neden)`

  ```text
  PARITY-MEDIUM-009 el yazımı enum kopyaları (TaskStatus/TaskCategory/TaskPriority/MealStatus)
  ```

  ```text
  contract-parity-enforcer'ın 'baseline ZERO' güvencesi — bu eksen için yanlış güven veriyor
  ```

- `no-bare-graphql-query-string lint muafiyetinin dayandığı yazılı önerme`

**Verifier note:**

Mechanism verified; severity trimmed as duplicate-root-cause inflation. Every cited line holds:
operation-registry.ts:169 declares `$input: CreateWaterQualityInput!` (document text valid);
types/index.ts:562-576 hand-writes CreateWaterQualityInput
with `parameters: WaterQualityParameters` REQUIRED and equipmentId/dynamicParameters OPTIONAL, while
the server DTO create-water-quality.input.ts:66-82 has no `parameters` field at all (removed, per
the comment) and makes equipmentId \+ dynamicParameters non-nullable required; types/index.ts:418
builds OperationPayload from those hand-written mirrors; codegen.ts:47 scopes documents
to `web/apps/aquamobil/src/graphql/**/*.ts`, excluding pwa/ and pages/. I checked the gate the claim
says is blind: scripts/ci/validate-graphql-operations.mjs DOES scan web/apps (`SCAN_ROOTS:56`) but
runs `graphql.validate(schema, parse(op))` on document text only — a variables object is never seen,
so the claim that this axis is structurally invisible is exactly right, and the graphql-fe-drift
baseline's ceiling of 0 (tests/invariants/graphql-fe-drift-baseline-no-grow.spec.ts:34) gives false
assurance for it. WaterQualityRecordPage.tsx:207-215 shows the live consequence: it
sends `parameters: {}` alongside dynamicParameters. Downgraded to HIGH because this is the
detectability half of a defect already filed twice in the same report (CRITICAL-001 and
CTX-CRITICAL-001); on its own it adds no new production failure beyond the one already counted.

### MOB-LOW-020

**Title:** Presigned PUT imzası Content-Type'a bağlanmıyor: MIME allow-list yalnız presign isteğinde
uygulanıyor, imzalı URL'e herhangi bir içerik türü yüklenebiliyor

**Severity:** LOW · **State:** OPEN · **Kaynak:** mobil sentezi (açılış
ID `PRODUCT-MOBILE-SYNTH-MEDIUM-003`)
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- libs/storage/src/minio-client.service.ts:282-292
  \-
  ardından `presignedPutObject(this.bucket, path, expirySeconds)` — `reqParams` HİÇ kullanılmıyor
  (ölü değişken)

  ```text
  const reqParams: Record<string, string> = {}; if (contentType) { reqParams['Content-Type'] = contentType; }
  ```

- apps/farm-service/src/fish-health/services/incident-media.service.ts:49-51
  \-
  —
  sınırlama dürüstçe belgelenmiş ama Tier 4'te bırakılmış

  ```text
  the shared getPresignedUploadUrl does not enforce Content-Type, so this is the request-time gate
  ```

- apps/farm-service/src/fish-health/services/incident-media.service.ts:70-73
  \- `contentType` parametresi geçiliyor, çağrılan taraf yok sayıyor

**Rule violated:**

CLAUDE.md Security — girdi doğrulama trust boundary'de yapılmalı; Architectural Approach Tier 1
(yanlış davranış yapısal olarak imkânsız olmalı) — mevcut çözüm Tier 4 (yorumla belgelenmiş)

**Proposed fix direction:**

`getPresignedUploadUrl`, `contentType` verildiğinde imzayı o başlığa bağlayan bir presign üretmeli
(MinIO/S3 için `presignedPutObject` yerine Content-Type'ı imzalanmış policy'ye dahil eden POST
policy ya da imzalı başlık listesi). Parametreyi sessizce yutmak yerine, ya bağla ya da imza yolunu
tipte ayır: `contentType` opsiyonel bir string değil, imzaya girdiği garanti edilen zorunlu bir
argüman olsun — sessiz yok sayma derleme zamanında imkânsız hale gelsin. Ölü `reqParams` bloğu
kaldırılmalı (yanlış güven veriyor).

**Affected surface (ripple set):**

- `apps/farm-service incident/lice/welfare kanıt medyası`
- `messaging-service medya + sesli mesaj presign hattı`
- `libs/storage kullanan admin-api rapor artefaktları`
- `orphan-cleanup.service.ts'in beklediği nesne türü varsayımları`
- `SYNTH-CRITICAL-001 ile birlikte ele alınmalı (aynı dosya, aynı imzalama yolu)`

**Verifier note:**

Mechanism confirmed but severity inflated. libs/storage/src/minio-client.service.ts:283-292 does
build reqParams['Content-Type'] and never pass it to presignedPutObject — real dead code, and the
SDK port type at libs/storage/src/minio-client.types.ts:47-51 has no reqParams slot (binding
Content-Type on a presigned PUT is impossible with this API; it needs presignedPostPolicy). The
security conclusion, however, does not hold: the claimer read incident-media.service.ts:50-70 and
missed the finalize gate at :109-126 in the same file, where every key is re-validated against the
tenant prefix (:109), object existence (:113-116), the object's REAL Content-Type via statObject
against the same allowlist (:117-121, isAllowedIncidentMediaMime(stats.contentType)), and the size
bound (:122-126). So the allowlist is not 'advisory' — request-time is advisory, finalize is the
enforcing gate. Grep of apps/farm-service/src shows getPresignedUrl is never called for incident
media, so an object uploaded with a disallowed type is orphaned: no `farm_incident_media` row is
written and it is never served back to a browser. This is also a documented design decision, stated
in three places: incident-media.service.ts:5-14 ('The presigned PUT cannot bind Content-Type, so the
request-time check is advisory and the finalize check is the real gate'), :48-52, and
constants/incident-media.constants.ts:9-11. What genuinely remains is a false contract in a shared
lib, not a bypass: the JSDoc at minio-client.service.ts:272-275 claims 'the presigned URL will
include a Content-Type condition so that browsers must upload with the matching content type', which
is untrue and contradicts farm-service's own comments; **tests**/incident-media.service.spec.ts:96
asserts the no-op argument is passed, locking the illusion in. A future second caller trusting that
JSDoc could skip its own finalize check. Real but narrow — LOW, not MEDIUM. Fix is to delete the
dead param \+ wrong JSDoc, or move to presignedPostPolicy.

### CTX-CRITICAL-001

**Title:** The GraphQL INPUT/variable axis was audited by nobody — it is exactly where the one
CRITICAL defect lives, and 14 more hand-written input types sit on the same ungated path

**Severity:** CRITICAL · **State:** OPEN · **Kaynak:** completeness critic (açılış
ID `GAP-CRITICAL-001`)
**Verification:** REFUTED

**Evidence:**

- web/apps/aquamobil/src/types/index.ts:562 —
  hand-written
  — `parameters` REQUIRED and `equipmentId`/`dynamicParameters` OPTIONAL, exactly inverted from the
  server

  ```text
  export interface CreateWaterQualityInput { ... parameters: WaterQualityParameters; dynamicParameters?: ...; equipmentId?: string; }
  ```

- apps/farm-service/src/water-quality/dto/create-water-quality.input.ts:78
  — `@Field(() => GraphQLJSON, ...) dynamicParameters!: Record<...>` REQUIRED, and the file header
  at :6 states the fixed `parameters` field 'were removed so there is exactly ONE code path'
- web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx:212
  — `parameters: {},` type-checks cleanly BECAUSE the hand-written type still declares it
- web/apps/aquamobil/src/types/index.ts — 15 hand-written `*Input {` interfaces total, none derived
  from codegen, none schema-checked
- codegen.ts:47 — `const aquamobilDocuments = ['web/apps/aquamobil/src/graphql/**/*.ts'];`

**Rule violated:**

CLAUDE.md Architectural Approach tier 1 (make it impossible) \+ Event/Contract Rules;
contract-parity-enforcer's own four-axis charter

**Proposed fix direction:**

The audit needed a fourth contract axis: variable-VALUE conformance. Document-text validation
(validate-graphql-operations.mjs) structurally cannot see this class — `parameters: {}` lives in the
variables object, not the document. Tier 1: delete every hand-written `*Input` interface in
web/apps/aquamobil/src/types/index.ts and re-export the codegen `InputMaybe`-typed equivalents,
which makes the inverted-nullability shape a compile error. Tier 3 backstop: an invariant asserting
no `*Input` interface is declared outside src/generated.

**Affected surface (ripple set):**

```text
contract-parity-enforcer's CONDITIONAL verdict is too lenient — it inventoried 'result-type contract' as PARTIAL and never listed an input-type row at all
```

```text
mobile-app-auditor, form-write-auditor and frontend-expert each reported the symptom (three duplicate CRITICAL/HIGH findings) with three different fix directions, none of which removes the class
```

```text
Every other queued OperationType payload (mortality, cull, harvest, transfer, stock movement, lice, welfare, escape) is typed by the same hand-written file and carries the same latent risk
```

**Verifier note:**

The cited lines are all real (web/apps/aquamobil/src/types/index.ts:562-575
declares `parameters: WaterQualityParameters` required with equipmentId/dynamicParameters optional;
apps/farm-service/src/water-quality/dto/create-water-quality.input.ts:66-80 makes equipmentId and
dynamicParameters required with no `parameters` field at all; WaterQualityRecordPage.tsx:212 does
send `parameters: {}`; codegen.ts:47 globs only `src/graphql/**`; 15
hand-written `*Input` interfaces exist at
types/index.ts:103,114,125,148,165,192,213,274,282,330,359,531,562,591,611). But the GAP itself is
false. The input/variable axis is precisely form-write-auditor's charter: its scope paragraph
(docs/reviews/form-write-auditor/2026-08-16-aquamobil-form-write-paths.md:20-33) says it read
types/index.ts and 'Traced each submitted field through the GraphQL documents into apps/farm-service
(harvest DTO, batch-resolver.dto RecordCull/RecordMortality/TransferBatch, water-quality create
input \+ schema.graphql, fish-health field-capture inputs, feeding-protocol meal-execution inputs,
storage record-stock-movement/transfer-stock inputs, task update-task.dto), apps/hr-service
(clock-in-out.input, create-leave-request.input), apps/alert-engine (AcknowledgeAlertInput)' — i.e.
the server counterpart of every one of the 15 hand-written inputs, with filed findings naming
HarvestInput, ClockInInput/ClockOutInput, CreateLeaveRequestInput and EscapeIncidentInput by name.
The ripple claim 'three different fix directions, none of which removes the class' is contradicted
by the reports: form-write-auditor:97-99 proposes 'remove the hand-written mirror entirely: generate
the mobile input types from the farm-service supergraph through the existing aquamobil codegen
gate', and mobile-app-auditor:115-118 proposes the identical Tier-1 codegen-emitted-type fix.
contract-parity-enforcer also touched hand-written inputs (PARITY-HIGH-004 discusses
types/index.ts:463-468 vs SetChecklistItemInput). Surface exists, was covered, and the Tier-1 fix
was already proposed — no uncovered gap remains.

### CTX-LOW-002

**Title:** Seven NATS request-reply responders — including a write path — got zero audit attention
from both the access-boundary and tenant-isolation agents

**Severity:** LOW · **State:** OPEN · **Kaynak:** completeness critic (açılış ID `GAP-HIGH-002`)
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/task/responders/create-task.responder.ts:48
  — `@MessagePattern('request.farm.createTask')` then
  :55 `if (!payload?.tenantId || !payload.createdBy)` — tenantId AND the acting user identity are
  taken from the NATS payload, with no check that createdBy belongs to tenantId, no @Roles, no
  mobile entitlement
- apps/farm-service/src/common/authz/permission-matrix.guard.ts:64
  — `if (context.getType<GqlContextType>() !== 'graphql') { return true; }` — the fail-closed matrix
  guard is a no-op for every responder
- apps/farm-service/src/common/authz/resolver-scanner.ts:2 — 'Walks every `*.resolver.ts`' —
  responders are structurally invisible to the permission matrix SSoT and its invariant spec
- libs/backend-common/src/bootstrap/create-service-app.ts:733
  — with
  no `inheritAppConfig`, so which enhancers reach RPC handlers is undetermined and untested

  ```text
  app.connectMicroservice<MicroserviceOptions>({ strategy: new NatsV3Server(...) })
  ```

- apps/farm-service/src/main.ts:25 — `natsTransport: { queue: 'farm-service' }` — the transport is
  live in production

**Rule violated:**

CLAUDE.md Security / Tenant-ID sourcing: 'JWT claims are the trust anchor'; Layer Rules #1

**Proposed fix direction:**

access-boundary-auditor scoped itself to GraphQL resolvers \+ FeatureRoute; tenant-isolation-auditor
scoped itself to request path, crons and NATS `*consumers*` (subscribe side) — the
request-reply `*responder*` side fell in the seam. Tier 1: give responders a
typed `NatsActorContext` that can only be constructed from a verified caller assertion, so a bare
payload tenantId cannot compile. Tier 3: extend resolver-scanner to walk `*.responder.ts` and
require every @MessagePattern to appear in a responder authorization matrix.

**Affected surface (ripple set):**

```text
ai-service's create_task actuation tool is the caller; ADR-015 makes cert CN the only identity, so any service holding a valid cert can address any tenant through this responder
```

```text
Six read responders (batch/tank/feeding/harvest/water-quality overview, site validation) expose per-tenant production data on the same unaudited path
```

```text
test-runner listed farm-service coverage by context and never mentioned responders, though all 7 do have specs — so even the coverage map is incomplete
```

**Verifier note:**

Coverage half confirmed: 7 responders exist
(batch/feeding/harvest/site/tank/task/water-quality `.../responders/*.responder.ts`) and grepping
all cycle reports for responder/MessagePattern returns hits ONLY in test-runner
(2026-08-16-farm-mobile-test-health.md:553,567,593, a coverage-invariant note) — neither
access-boundary-auditor nor tenant-isolation-auditor touched them. permission-matrix.guard.ts:63-65
does return true for any non-graphql context, resolver-scanner.ts:2-3 walks
only `*.resolver.ts`, create-service-app.ts:731-737 connects the microservice with no
inheritAppConfig, main.ts:25 sets `natsTransport: { queue: 'farm-service' }`, and
create-task.responder.ts:48/:55 takes tenantId+createdBy from the payload. But the security
consequence the claim rests on is blocked by a control it missed. NATS publish is a per-subject
allowlist keyed to the cert CN: infrastructure/docker/nats/nats.conf
grants `request.farm.createTask` in publish to exactly ONE user, `CN=ai_service` (line
399\); `farm_service` has it only under subscribe (line 172), and no other CN can publish
any `request.farm.*` write subject (only `messaging_service` holds getTankRegistry, line 579). So
the ripple 'any service holding a valid cert can address any tenant through this responder' is
false. The sole authorized caller, apps/ai-service/src/tools/farm/create-task.tool.ts:106-110,
passes ctx.tenantId/ctx.userId from ToolExecutionContext, documented at
tools/core/tool.interface.ts:43 as 'populated from JWT, never from Claude', self-assigns (assignedTo
= ctx.userId, so createdBy and tenantId are consistent by construction), and the tool carries
requiresConfirmation:true; the responder writes inside runInTenantTransaction pinned to that
tenantId. Real audit blind spot with a legitimate Tier-3 fix (extend resolver-scanner
to `*.responder.ts`), but no reachable authz or tenant-crossing defect today — LOW, not HIGH.

### CTX-MEDIUM-003

**Title:** farm-expert declared nine setup contexts clean with a blanket unverified claim;
ten `restore*` mutations in exactly those contexts bypass the CommandBus and emit no domain event

**Severity:** MEDIUM · **State:** OPEN · **Kaynak:** completeness critic (açılış ID `GAP-HIGH-003`)
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/department/department.resolver.ts:117
  —
  at
  :123, going resolver → service → repository with no CommandBus dispatch

  ```text
  async restoreDepartment(...)` calls `return this.restoreService.restore(this.departmentRepository, Department, id, ...)
  ```

- apps/farm-service/src/common/services/restore.service.ts — grep
  for `outbox|Outbox|createBaseEvent|eventBus` returns ZERO matches; a restored entity produces an
  audit row but no downstream event
- 10 restore mutations found across resolvers: restoreBatchFeedAssignment, restoreChemical,
  restoreConsumable, restoreDepartment, restoreFeed, restoreFeedingProgram, restoreSite,
  restoreSpecies, restoreSupplier, restoreSystem
- farm-expert inventory row: 'Consumable / supplier / chemical / species / site / department / farm
  / worker: Uniform CQRS shape ... No layering violations found in these contexts.' — no file:line
  cited for any of the nine contexts (42 mutations)
- apps/farm-service/src/common/services/restore.service.ts:5 — the service's own docstring admits
  'each wires the read \+ mutate \+ audit-log plumbing by hand — different tenant checks, different
  permission assertions'

**Rule violated:**

CLAUDE.md Layer Rules #1 (Controller → Service → Command/Query Bus → Handler → Repository) and #4
(use createBaseEvent)

**Proposed fix direction:**

The claim is shape-inference, not verification: the agent matched CreateX/UpdateX/DeleteX naming and
stopped. A blanket IMPLEMENTED over 42 mutations with zero evidence lines is the audit's weakest
load-bearing assertion, and it is demonstrably wrong. Re-audit the nine contexts per-mutation; route
restore through a RestoreEntityCommand \+ handler and emit an EntityRestored outbox event so
soft-delete reversal is visible downstream.

**Affected surface (ripple set):**

```text
farm-expert's FARM-HIGH-004 count of '~34 write mutations bypass the CommandBus' is understated by at least 10
```

```text
A restored Feed/Supplier/Species re-enters availability with no event — alert-engine, finance derivation and the farm-stock projection cannot observe it
```

```text
The same nine contexts are where test-runner found every create/update/delete handler untested, so neither the static claim nor a test backs them
```

**Verifier note:**

Substantively confirmed, severity inflated. department.resolver.ts:117-131 does go
resolver `->` restoreService.restore `->` repository while :56/:71/:103 on the same resolver
dispatch through commandBus; grep of common/services/restore.service.ts for
outbox|createBaseEvent|eventBus returns ZERO matches (it emits only an AuditLogService entry), and
its docstring at :5-11 is as quoted. The count is understated, not overstated: 11 restore mutations
exist (the 10 listed plus restoreFinanceCategory at finance/resolvers/finance.resolver.ts:286). The
event asymmetry is real and has a downstream consumer:
department/handlers/{create,delete}-department.handler.ts:95/149 emit
DepartmentCreated/DepartmentDeleted through OutboxPublisher, and
apps/gateway-api/src/websocket/farm-nats-bridge.service.ts:123-126,399-409 subscribes to
SiteDeleted/DepartmentDeleted and broadcasts them over WebSocket — a restore produces no such
broadcast. Three things cap it below HIGH. (1) farm-expert's inventory row
(2026-08-16-farm-service-domain-audit.md:1064) explicitly says 'with restore paths and role gates',
so 'matched CreateX/UpdateX/DeleteX naming and stopped' overstates; the role gates are
real (`@Roles(Role.TENANT_ADMIN`) at department.resolver.ts:114) and RestoreService enforces tenant
check \+ uniqueness pre-check \+ audit log. (2) The CommandBus-bypass class was already filed and
adversarially verified DOWN to MEDIUM as FARM-MEDIUM-304 (raised as FARM-HIGH-004), explicitly
because 'no correctness, isolation, or security consequence is demonstrated'; the same reasoning
applies to restore. (3) Impact is a stale real-time cache until refetch, not data loss. Real,
uncovered, but MEDIUM.

### CTX-MEDIUM-004

**Title:** Observability was examined by no agent — and the metrics/alerting stack structurally
cannot see the audit's own CRITICAL defect

**Severity:** MEDIUM · **State:** OPEN · **Kaynak:** completeness critic (açılış ID `GAP-HIGH-004`)
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/common/metrics/farm-metrics.interceptor.ts:2 — 'Wraps every GraphQL resolver
  invocation' — an `APP_INTERCEPTOR`; a GraphQL input-coercion rejection (the
  unknown `parameters` field) fails before resolver execution and never
  increments `farm_mutation_errors_total`
- infrastructure/monitoring/prometheus/alerts/farm-data-ssot-alerts.yml:56
  — `alert: FarmMutationErrorRateHigh`, :83 `FarmMutationErrorRateCritical` — both derive from those
  resolver-scoped series, so 100% failure of mobile water-quality capture fires nothing
- apps/farm-service/src/common/metrics/farm-domain-metrics.service.ts:12 — 'NONE of these series
  carry a tenant label' — a single-tenant or single-surface outage is undetectable by design,
  documented but never assessed against the defects this audit found
- infrastructure/monitoring/prometheus/alerts/farm-data-ssot-alerts.yml — 15 alerts, all on
  outbox/regulatory/environment; none on cron rows-processed, so tenant-isolation-auditor's
  PRODUCT-TENANT-HIGH-001 (crons silently no-op and log success) is invisible in production too
- libs/backend-common/src/bootstrap/create-service-app.ts:681 — `initTelemetry(serviceName)` exists;
  no agent verified span coverage, sampling, or PII in span attributes

**Rule violated:**

CLAUDE.md Architectural hierarchy tier 3 (make it detectable)

**Proposed fix direction:**

Add an observability lane to the audit charter. Concretely: move mutation error accounting to a
GraphQL formatError hook (or an Apollo plugin) so validation/coercion failures are counted, and add
a `farm_cron_rows_processed_total` gauge with a zero-for-N-cycles alert so a fail-closed RLS no-op
is detectable rather than a green log line.

**Affected surface (ripple set):**

```text
Every CRITICAL/HIGH in this audit is a defect that shipped; the reason none was caught in production is an observability gap nobody audited
```

```text
The alerting SSoT and the code SSoT were never diffed — 15 farm alerts vs ~10 metric families
```

**Verifier note:**

Gap confirmed. The cycle roster is 10 agent reports (`docs/reviews/*/2026-08-16-*.md`) and none is
an observability lane; grepping tenant-isolation-auditor and data-expert for
prometheus/metric/alert/telemetry returns no observability assessment.
farm-metrics.interceptor.ts:1-8 is as quoted ('Wraps every GraphQL resolver invocation',
an `APP_INTERCEPTOR`), so a variable-coercion failure that never enters a resolver cannot
increment `farm_mutation_errors_total`; farm-data-ssot-alerts.yml:56 FarmMutationErrorRateHigh and
:83 FarmMutationErrorRateCritical both
divide `farm_mutation_errors_total` by `farm_mutation_duration_seconds_count`, i.e. the same
resolver-scoped series; farm-domain-metrics.service.ts:11-17 states 'NONE of these series carry a
tenant label'; create-service-app.ts:679-681 calls initTelemetry with no agent having assessed
span/PII coverage. I also checked the fallback path the claim did not: slo-alerts.yml:284-290
SloErrorRateHigh keys on `aquaculture:http_error_ratio:rate5m`, which is 5xx-only, so a GraphQL 400
genuinely fires nothing platform-wide either. Two corrections cap it at MEDIUM. The evidence bullet
'15 alerts, all on outbox/regulatory/environment' is self-contradictory — 2 of the 15 are the
mutation alerts the same claim cites — and cron observability is not absent:
FarmRegulatoryRetrySweepStalled (:211), FarmRegulatoryCronErrored (:229),
FarmEnvironmentProviderSyncStalled (:250), FarmEnvironmentRetentionStalled (:274) and
FarmEnvironmentCronFailures (:295) are heartbeat/error alerts; only the rows-processed dimension is
missing. This is a Tier-3 detectability gap with no production defect of its own — MEDIUM, not HIGH.

### CTX-HIGH-005

**Title:** Legal hold and GDPR erasure enforcement is exercised only by specs in the dead
test:integration lane — data-expert reported the mechanism as present without noting it is
unexecuted

**Severity:** HIGH · **State:** OPEN · **Kaynak:** completeness critic (açılış ID `GAP-HIGH-005`)
**Verification:** REFUTED

**Evidence:**

- apps/farm-service/src/compliance/services/tenant-erasure.service.ts:294
  — `await this.legalHoldService.assertNoHold(tenantId, 'tenant');` is the only hard gate before a
  tenant-wide destructive cascade
- —
  imports `LegalHoldEntity, LegalHoldService`; it is a `*.postgres.spec.ts`, i.e. the file class
  test-runner proved runs in no workflow

  ```text
  apps/farm-service/src/compliance/**tests**/tenant-erasure-topology.postgres.spec.ts:2
  ```

- test-runner TEST-HIGH-003 established `test:integration` is invoked by zero workflows — but scoped
  its consequence to tenant-schema-routing, never to legal hold or erasure
- data-expert inventory row 'Outbox × legal hold / GDPR erasure' is PARTIAL and discusses only the
  outbox purge gap — it does not state that the enforcement path has no executing test

**Rule violated:**

ADR-012 / CLAUDE.md Test Rules; GDPR Art.17(3)(b) legal-hold carve-out

**Proposed fix direction:**

Cross-agent linkage was never made: one agent found the dead lane, another audited the mechanism,
neither intersected. Wire test:integration into ci-full, and until then treat every finding whose
only evidence is a `*.postgres.spec.ts` as unverified.

**Affected surface (ripple set):**

```text
The same dead lane hides 8 postgres tenant-isolation specs and the CLAUDE.md-mandated tenant-schema-routing.architecture.spec.ts
```

```text
An erroneous erasure under an active legal hold is legally irreversible and currently has no executing regression guard
```

**Verifier note:**

The load-bearing assertion — 'exercised only by specs in the dead test:integration lane' and
'currently has no executing regression guard' — is false. The gate at
compliance/services/tenant-erasure.service.ts:294
(`await this.legalHoldService.assertNoHold(tenantId, 'tenant')`) is directly covered
by `apps/farm-service/src/compliance/**tests**/tenant-erasure.service.spec.ts`, a plain unit spec in
the normal lane: :1255-1262 is a docblock 'COMPLIANCE-HIGH-004 — legal-hold precedence specs. Pin
the contract: a tenant under active legal hold MUST NOT have farm-side data deleted', :1264 'throws
when LegalHoldService.assertNoHold reports the tenant on hold; cascade does NOT run' (asserting
executed === [] and the ticket is not consumed), and :1289-1302 'passes through to the cascade when
no legal hold is active' asserting assertNoHold was called with (TENANT, 'tenant'). That file is
neither a `*.postgres.spec.ts` nor under **tests**/integration/, so it is NOT excluded by
apps/farm-service/jest.config.ts:12-23 and runs under the `test` target (project.json:42-48), which
ci-affected.yml:393 selects via `nx show projects --affected --with-target=test`. The claimer cited
only tenant-erasure-topology.postgres.spec.ts and missed the sibling unit spec in the same **tests**
directory. The dead-test:integration-lane fact is real but is already filed as TEST-HIGH-003; the
legal-hold-specific consequence asserted here does not exist.

### CTX-MEDIUM-006

**Title:** Performance was examined by no agent: 112 @ResolveField against 6 DataLoaders, no
query-budget gate, no load test

**Severity:** MEDIUM · **State:** OPEN · **Kaynak:** completeness critic (açılış
ID `GAP-MEDIUM-006`)
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src — 112 `@ResolveField` declarations in non-test source
- apps/farm-service/src/{batch,equipment}/dataloaders/ — only 6 loader files exist (batch-species,
  tank-batch, feed-selection, batch-feed-assignment, batch-location, batch-document)
- apps/farm-service/src/batch/dataloaders/batch-location.dataloader.ts — a loader
  for `batch_locations`, which db-audit-farm-production proved has ZERO writers, so a loader exists
  for a permanently empty table while ~106 resolve-fields have none
- apps/farm-service/src/common/cache/cacheable.interceptor.ts — the only latency control examined,
  and only for its tenant-key defect (PRODUCT-TENANT-MEDIUM-004), never for hit rate or invalidation
  correctness

**Rule violated:**

CLAUDE.md Architectural hierarchy tier 3

**Proposed fix direction:**

No agent in the roster owned latency/throughput. Add a performance lane, or at minimum a Tier-3
invariant asserting every @ResolveField that crosses a table boundary resolves through a
request-scoped DataLoader.

**Affected surface (ripple set):**

```text
aquamobil is a field app on cellular links; a per-row resolve-field fanout on the tank list is a user-visible failure mode no agent could have reported
```

```text
The farm_mutation_duration_seconds histogram exists but no agent read its distribution or set an SLO
```

**Verifier note:**

Counts confirmed: 112 `@ResolveField` across 22 files in apps/farm-service/src, and exactly 6
dataloader files
(batch/dataloaders/{batch-document,batch-feed-assignment,batch-location}.dataloader.ts \+
equipment/dataloaders/{batch-species,feed-selection,tank-batch}.dataloader.ts). Grepping all 13
cycle reports for N+1/latency/query-budget finds no agent that owned performance — the only
dataloader mentions are tenant-scoping (tenant-isolation-auditor:327) and spec coverage
(test-runner:621), and no k6/artillery/load-test harness exists in the repo. The gap is real and it
has teeth: apps/farm-service/src/system/system.resolver.ts:248,271,291,315 fire one queryBus.execute
per parent for site/department/parentSystem/childSystems, and
apps/farm-service/src/tank/resolvers/tank.resolver.ts:360-363 does a
per-tank `tankBatchRepository.findOne` — genuine unbatched N+1 over list queries. Two caveats that
cap this at MEDIUM rather than higher: the '112 vs 6' ratio is misleading, since the large majority
of those ResolveFields are pure in-memory computations on the already-loaded parent
(growth.resolver.ts:593-655, harvest-plan.resolver.ts:385-444, batch.resolver.ts:578-601) with zero
DB access, and the relational ones on Batch already route through DataLoaders
(batch.resolver.ts:603-636, comment 'FARM-MEDIUM-005 ... eliminates N+1'); and
apps/gateway-api/src/app.module.ts:350-385 does enforce a graphql-query-complexity cap, which is not
a query budget but is a partial DoS control the claim does not acknowledge.

### CTX-MEDIUM-007

**Title:** Four of the five backends aquamobil actually calls were never read, yet three agents made
behavioral claims about them

**Severity:** MEDIUM · **State:** OPEN · **Kaynak:** completeness critic (açılış
ID `GAP-MEDIUM-007`)
**Verification:** REFUTED

**Evidence:**

- web/apps/aquamobil/src/hooks/useMySchedule.ts:53
  — `mySchedule(weekStartDate: $weekStartDate, limit: 1)` resolves in hr-service; no agent read
  apps/hr-service
- apps/alert-engine/src/alert/services/{farm-signal-incident,water-quality-critical-alert,low-stock-alert,fcr-alert}.service.ts
  — a live consumer side for farm events that no agent opened; alert-engine appears in zero
  inventories
- form-write-auditor PRODUCT-FORM-HIGH-002 asserts 'hr-service stamps new Date() at replay time' — I
  verified this at
  apps/hr-service/src/attendance/handlers/clock-in.handler.ts:93 `const nowUtc = new Date();`, so
  the claim holds, but it was made from mobile-side reading alone
- access-boundary-auditor PRODUCT-ACCESS-LOW-001 notes messaging authorization 'lives in
  messaging-service channel ACLs (out of this audit's read set)' — an explicitly acknowledged hole
  left open

**Rule violated:**

CLAUDE.md Working Style: 'Report faithfully ... unverified, say so with the evidence'

**Proposed fix direction:**

Scope the next cycle by consumer graph, not by directory: every backend a target frontend calls is
in-scope. The highest-value missing link is alert-engine — db-audit-farm-operations proved the
low-stock chain is dead (minStock has no editor) while
apps/alert-engine/src/alert/services/low-stock-alert.service.ts sits waiting for an event that can
never fire; no agent joined those two halves.

**Affected surface (ripple set):**

```text
farm-expert found the maintenance context emits zero domain events and data-expert found 9 event contracts with no producer — whether alert-engine has live handlers starved by those gaps is unknown
```

```text
hr-service backs three mobile surfaces (attendance, leave, schedule) with real payroll consequences
```

**Verifier note:**

Inverted. Four of the five backends were read, with file:line citations, and I confirmed the cited
lines exist. access-boundary-auditor's scope paragraph (report lines 35-36) names
apps/hr-service/src/{attendance/attendance.resolver.ts,leave/leave.resolver.ts,app.module.ts} and
apps/alert-engine/src/alert/resolvers/alert.resolver.ts; its findings cite
attendance.resolver.ts:386 (`clockIn` mutation — real, at line 388),
leave.resolver.ts:425 (`createLeaveRequest` — real, at line 427) and
alert.resolver.ts:156 (`acknowledgeAlert` — real, at line 157). form-write-auditor's scope (line
31-32) traces into apps/hr-service (clock-in-out.input \+ clock-in.handler \+ create-leave-request
\+ calculate-leave-days) and apps/alert-engine (AcknowledgeAlertInput \+ alert-rule.service).
realtime-sync-auditor cites hr-service leave/handlers/submit-leave-request.handler.ts:54,
leave-state-machine.ts:46, create-leave-request.handler.ts:101. frontend-expert cites
apps/messaging-service/src/shared/messaging-s3-client.factory.ts:21 and
message/services/media.service.ts:112. Only notification-service is thinly covered (appears in
ripple sets, no line citations) — one backend, not four. The premise 'only farm-service read in
expert scope paragraphs' is contradicted by the scope paragraphs themselves.

### CTX-MEDIUM-008

**Title:** Nine aquamobil pages (~2,980 lines) were never opened, including the WebAuthn enrollment
half of the accessType bypass the access agent reported

**Severity:** MEDIUM · **State:** OPEN · **Kaynak:** completeness critic (açılış
ID `GAP-MEDIUM-008`)
**Verification:** REFUTED

**Evidence:**

- web/apps/aquamobil/src/pages/account/AccountPage.tsx — 777 lines, the largest unopened page;
  :25 `import { useWebAuthn, storeBiometricEmail } from '@/hooks/useWebAuthn'` and
  :280 `storeBiometricEmail(user.email)` — this is where a biometric credential is ENROLLED
- web/apps/aquamobil/src/hooks/useWebAuthn.ts:685
  — `localStorage.setItem('webauthn_email', email);` — unscoped by tenant and user (logout does
  clear it, verified at useAuth.tsx:181, so the wipe claim holds)
- access-boundary-auditor PRODUCT-ACCESS-CRITICAL-002 audited `loginWithToken` (the consume half)
  and concluded accessType is unchecked — but never asked whether a `PANEL_ONLY` account can enroll
  the credential in the first place
- Never opened: HomePage.tsx (386), operations/OperationsHubPage.tsx (281),
  operations/StaffHubPage.tsx (237), operations/StockEventsHubPage.tsx (299),
  schedule/MySchedulePage.tsx (236), notifications/NotificationsPage.tsx (179),
  tank/TankDetailPage.tsx (276), NotFoundPage.tsx
- web/apps/aquamobil/src/pages/schedule/MySchedulePage.tsx:23
  — `return new Date().toISOString().split('T')[0] === dateStr;` — the same UTC-vs-local-day class
  as PRODUCT-FORM-MEDIUM-010, on a shift-schedule screen, found by nobody

**Rule violated:**

Audit scope completeness

**Proposed fix direction:**

Read-set completeness was never asserted by any agent. Require each frontend agent to emit the
enumerated set of route components it opened and diff it against the router's route table; an
unopened route is a MISSING inventory row, not an absence of finding.

**Affected surface (ripple set):**

```text
TankDetailPage is the destination of the tankView entitlement that access-boundary-auditor declared a dead control — the page that would consume it was never read
```

```text
StaffHubPage and StockEventsHubPage render cross-worker and HARVEST data on a tenant-wide read (PRODUCT-ACCESS-HIGH-005) that was reported from the resolver side only
```

**Verifier note:**

The nine pages are enumerated in the cycle report at line 843 (HomePage, 4 operations hubs,
schedule, notifications, tank detail, account). Most were opened with line-precise citations:
AccountPage.tsx (777 lines, 26% of the claimed 2,980) is cited by frontend-expert at :744-757 and
:659-670, realtime-sync-auditor at :81/:83 (:747, :764) and mobile-app-auditor at
:165/:167/:214/:216 (:746-747, :764, :407); HomePage.tsx by db-audit-farm-production at :125,
frontend-expert at :370-371, access-boundary-auditor at :221; MySchedulePage.tsx by frontend-expert
at :616 (:53,95 UTC/locale bug — so the 'unreported' UTC-day bug was in fact reported);
TankDetailPage.tsx in db-audit-farm-production's scope and access-boundary-auditor's route analysis;
DailyOpsHubPage in realtime-sync-auditor's ripple set and `pages/operations/*` in
access-boundary-auditor's scope. The headline hook fails outright: the WebAuthn enrollment logic is
not in AccountPage — AccountPage.tsx:25,263-274 only calls the hook — and the hook
web/apps/aquamobil/src/hooks/useWebAuthn.ts (701 lines,
holding `REGISTRATION_CHALLENGE_MUTATION:45`, `REGISTER_CREDENTIAL_MUTATION:57` and
registerCredential:397-459 alongside `VERIFY_LOGIN_MUTATION:77`) is explicitly cited at :82 in the
access agent's own accessType finding. Residue is at most
StaffHubPage/OperationsHubPage/StockEventsHubPage/NotificationsPage, ~940 lines of hub/list pages,
not 2,980.

### CTX-LOW-009

**Title:** Every claim about what CI executes, what is green, and what is stale is a static file
read — nothing in this audit was run

**Severity:** LOW · **State:** OPEN · **Kaynak:** completeness critic (açılış ID `GAP-MEDIUM-009`)
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- `ls -d node_modules` at repo root → 'No such file or directory' — no install, no jest, no vite, no
  graphql compose was possible for any of the twelve agents
- test-runner states this honestly up front ('No test run was possible ... this is static analysis
  only'); the other eleven do not
- contract-parity-enforcer: 'its drift baseline is currently ZERO' and 'Codegen is NOT stale' — both
  derived from reading a baseline file and counting 67 operations against 67 generated types, not
  from executing validate-graphql-operations.mjs or codegen
- contract-parity-enforcer inventory: 'the aquamobil codegen output is complete (67 operations in
  src/graphql, 67 generated result types)' — a count-equality argument that cannot detect a shape
  change inside a matched pair
- data-expert: 'the migration manifest matches the 76 files on disk' — verifiable statically and
  probably sound, but stated with the same confidence as the executable claims

**Rule violated:**

CLAUDE.md Working Style: 'Verification is judgment ... prefer a tool that proves the answer over a
claim that asserts it'

**Proposed fix direction:**

Two evidence tiers were conflated. Require every agent to tag each claim as READ (static) or RUN
(executed) and to downgrade any RUN-shaped claim it could not execute. The duplicated
contract-parity-enforcer entry in this cycle's report (submitted twice, verbatim) also suggests the
roster ran with an unnoticed duplicate slot instead of a twelfth distinct lane.

**Affected surface (ripple set):**

```text
'Codegen is NOT stale' is the specific reassurance that makes GAP-CRITICAL-001 look covered when it is not
```

```text
A green CI claim that was never executed is the most expensive kind of audit output
```

**Verifier note:**

Factually accurate but much narrower than MEDIUM. test-runner's own report states it at lines 33-34
and 38 ('NO test was executed: `npx jest --listTests` failed ... `node_modules` is not installed in
this sandbox'; 'static analysis only, stated up front'), and the cycle report already records it at
line 854. So the audit disclosed the limitation rather than hiding it, and the substance of the CI
findings — which workflow invokes which target, whether aquamobil declares a `test` target,
whether `test:invariant` resolves to any project — is exactly the kind of claim a static read of
.github/workflows and project.json settles correctly. I found only one genuine green-without-running
assertion: data-expert:392 calls e2e/tests/integration/schema-invariants.spec.ts 'green and
CI-wired', and only the CI-wired half is statically verifiable (it is —
.github/workflows/db-migration-check.yml:96,105). contract-parity-enforcer's 'codegen is NOT stale'
(line 46, 606) rests on a 67-operations-vs-67-result-types count, weak but not baseless. Worth
noting against the claimer's framing: `node_modules` IS present in the repo now (1,382 packages,
with jest/nx/vitest/tsc in `node_modules/.bin`), so the 'could not run' condition was
environment-specific, not structural.

### CTX-MEDIUM-010

**Title:** farm-service infrastructure and cross-cutting directories got no inventory row from any
agent

**Severity:** MEDIUM · **State:** OPEN · **Kaynak:** completeness critic (açılış
ID `GAP-MEDIUM-010`)
**Verification:** REFUTED

**Evidence:**

- apps/farm-service/src/health/tenant-schema-readiness.service.ts — the cold-start gate that decides
  whether a tenant schema is serviceable; no inventory row anywhere
- apps/farm-service/src/infrastructure/watchdog-cron.service.ts — a cron watchdog, directly relevant
  to tenant-isolation-auditor's PRODUCT-TENANT-HIGH-001 (crons silently no-op); never opened, so
  whether the watchdog would catch the silent no-op is unknown
- apps/farm-service/src/filters/global-exception.filter.ts — the global error boundary; test-runner
  noted only 'no spec', no agent audited whether it leaks internals or masks domain errors
- apps/farm-service/src/common/jsonb/jsonb-patch.service.ts — the mutation path for every jsonb
  column in the service (growthMetrics, fcr, statistics), audited by nobody despite ~15 jsonb
  columns in db-audit findings
- apps/farm-service/src/mobile-dashboard/ — 8 files backing three mobile hub pages; touched only
  glancingly by access-boundary-auditor's site-scoping finding, never inventoried as a bounded
  context

**Rule violated:**

CLAUDE.md Layer Rules; audit scope completeness

**Proposed fix direction:**

The roster partitioned farm-service by `*domain*` context and left the `*technical*` contexts
unowned. Add an explicit residual-sweep step: enumerate top-level src/ directories, subtract every
directory named in an inventory row, and require a row for the remainder.

**Affected surface (ripple set):**

```text
watchdog-cron is the one component that could have downgraded PRODUCT-TENANT-HIGH-001 from 'silent' to 'detected'
```

```text
jsonb-patch is the shared write primitive under several columns the db agents declared correctly written
```

**Verifier note:**

The named directories are not uncovered. filters/global-exception.filter.ts and
cache/farm-cache.service.ts have an explicit inventory row — test-runner report line 757
('cache/farm-cache.service.ts is a 0-byte file imported by nothing.
filters/global-exception.filter.ts (5.6 KB) has no spec'), and I confirmed farm-cache.service.ts is
literally 0 lines. common/ carries filed findings across four agents: tenant-isolation-auditor cites
common/cache/cacheable.interceptor.ts:116-131 and cache-evict.interceptor.ts:111-126, the cycle
report cites common/authz/permission-matrix.guard.ts:64, resolver-scanner.ts:2,
common/services/restore.service.ts:5, common/metrics/farm-metrics.interceptor.ts:2 and
farm-domain-metrics.service.ts:12, access-boundary-auditor lists common/authz/permission-matrix.ts,
tenant-isolation-auditor lists common/file-cleanup/farm-orphan-cleanup.service.ts. events/ is
covered by data-expert (harvest-completed.listener.ts:250, mortality-recorded.listener.ts),
farm-expert (:300, :333, :355) and tenant-isolation-auditor
(farm-stock-projection.listener.ts:113-120). The real residue is two files, not six directories:
infrastructure/watchdog-cron.service.ts (109 lines) and types/uuid.d.ts (14 lines) — and the
watchdog is a platform-wide WatchdogRunner.runFullScan wrapped in CronHeartbeatService.track (lines
37,45), not the per-tenant cron class the claim implies it would have illuminated. That residue is
already its own separate row in the cycle report at line 847.

### CTX-MEDIUM-011

**Title:** Billing coupling was never examined and does not exist: farm-service has no subscription
or plan-tier gate on any write path

**Severity:** MEDIUM · **State:** OPEN · **Kaynak:** completeness critic (açılış
ID `GAP-MEDIUM-011`)
**Verification:** REFUTED

**Evidence:**

- apps/farm-service/src — grep for `planTier|subscriptionStatus|SubscriptionGuard|entitlement` in
  non-test, non-migration source returns only SEC-HIGH-052 MobileFeatureGuard comments (per-user
  mobile feature flags), never a subscription or plan check
- apps/farm-service/src/app.module.ts:518-560 — the global guard chain is ServiceIdentity → Tenant →
  Roles → Throttler → PermissionMatrix; no billing/entitlement guard
- No agent lists billing in any inventory row; the word appears in farm-service source only in
  compliance/tenant-export, an archived migration, and listener comments

**Rule violated:**

CLAUDE.md Tenant row placement (D14): 'billing is the SSoT for subscription state'

**Proposed fix direction:**

An absent coupling is an audit result, not an absence of scope. Decide explicitly whether a lapsed
or suspended subscription should degrade farm write access, and if so make it a guard (tier 2)
rather than an unstated assumption; if not, record the decision so the next audit does not re-open
it.

**Affected surface (ripple set):**

```text
A tenant whose billing lapses retains full production-write capability indefinitely
```

```text
billing-service is one of the 15 runtime services and appears in no inventory row across all twelve reports
```

**Verifier note:**

The load-bearing half — 'does not exist: farm-service has no subscription or plan-tier gate on any
write path' — is false. apps/farm-service/src/tank/handlers/create-tank.handler.ts:65-71
reads `resolvePlanLimits(tenantPlanFromLevel(planLevel)).maxPonds` and
calls `assertWithinQuota('ponds', currentPonds, maxPonds)`, and
apps/farm-service/src/site/handlers/create-site.handler.ts:58-64 does the same for maxFarms — both
marked SSOT-C-13, both counted INSIDE runInTenantTransaction so concurrent creates cannot both slip
past, both sourced from the canonical `PLAN_CATALOG` in @platform/event-contracts that billing
itself projects from (apps/billing-service/src/billing/plan-limits.util.ts:1-27). The gate is live,
not dead code: planLevel is a JWT claim
(libs/backend-common/src/decorators/current-user.decorator.ts:68) threaded resolver→command→handler
at tank.resolver.ts:267,271 and site.resolver.ts:57,60. A separate mobile entitlement layer also
exists (libs/backend-common/src/guards/mobile-feature.guard.ts, fail-closed on a missing claim,
applied via @RequiresMobileFeature in 6 farm-service resolvers). Billing coupling was indeed not
audited this cycle, but the surface the claim asserts is missing is implemented and correct, so
there is no defect to file.

### CTX-LOW-012

**Title:** Three agents each filed the same water-quality defect as a top finding, inflating the
apparent finding count and splitting ownership of one root cause

**Severity:** LOW · **State:** OPEN · **Kaynak:** completeness critic (açılış ID `GAP-LOW-012`)
**Verification:** REFUTED

**Evidence:**

- mobile-app-auditor PRODUCT-MOBILE-CRITICAL-001 :: WaterQualityRecordPage.tsx:212
- form-write-auditor PRODUCT-FORM-CRITICAL-001 :: WaterQualityRecordPage.tsx:212 — same line
- frontend-expert FE-HIGH-003 and mobile-app-auditor PRODUCT-MOBILE-HIGH-003 :: both cite
  codegen.ts:47 with the same argument
- access-boundary-auditor / tenant-isolation-auditor / realtime-sync-auditor / frontend-expert all
  separately report the logout-destroys-queue behaviour (useAuth.tsx:194-196) under four different
  IDs and two different severities (CRITICAL vs HIGH vs MEDIUM)

**Rule violated:**

Review Finding Traceability (MANDATORY) — one finding ID per defect

**Proposed fix direction:**

Deduplicate by evidence anchor (file:line) before the report is assembled, and assign one owner per
anchor. The current shape means a fix commit cannot write a single honest `Closes:` line, and
severity is decided by whichever agent shouted loudest rather than by consequence.

**Affected surface (ripple set):**

```text
The audit reads as ~100 findings; the distinct defect count is materially lower, which distorts triage
```

```text
Duplicate reporting consumed roster capacity that left observability, performance and billing unowned
```

**Verifier note:**

Two agents, not three. The third instance is asserted, not shown: grepping
contract-parity-enforcer/2026-08-16-farm-mobile-contract-parity.md for `parameters` returns nothing,
its only water mention is line 599 (an inventory row about un-typed GraphQL documents), and its
finding list is PARITY-MEDIUM-001/005/006/007/008/009, PARITY-LOW-010 plus three struck HIGHs — no
water-quality defect at any severity. The cycle report contradicts the claim directly at line 842:
'contract-parity audited result types only; no agent examined input/variable conformance, which is
exactly where the CRITICAL water-quality defect lives.' On the remaining duplicate pair, the
orchestrator had already deduped before this claim was raised — line 255 tags
PRODUCT-MOBILE-CRITICAL-001 / PRODUCT-FORM-CRITICAL-001 'aynı kök neden', line 1000 notes 'iki ajan
bağımsız buldu'. Two independently-scoped lanes converging on one defect and being merged upstream
is the protocol working, not a finding.

## Farm-service sentezi

### 1. Farm domain'in genel durumu

**Çekirdek üretim-biyolojisi yazma yolları sağlam.** Batch yaşam döngüsü, mortalite/cull, transfer,
hasat, yemleme ve büyüme; pessimistic lock \+ `runInTenantTransaction` \+ transactional outbox
\+ `createBaseEvent` üzerinde çalışıyor. Sayım
SSoT'u (`tank_batches.batchDetails` → `TankBatchService.applyBatchDelta`) gerçekten tek yazıcı;
biyokütle, FCR ve SGR formülleri tek otoriteye sahip. Depo
tarafında `storage_inventory + stock_movements` yakınsaması tamamlanmış, FEFO \+ lot izlenebilirliği
(EU 178/2002) ayakta. ADR-011 yerleşimi kusursuz: partisyondaki ~98 entity doğru sınıflandırılmış,
sadece üç entity `schema:'farm'` deklare ediyor ve üçü de meşru cross-tenant kümede. Sentinel Hub
sunucu tarafı CDSE'ye doğru şekilde emekli edilmiş. Regülasyon (Mattilsynet/Altinn) servisin en
derin ve en iyi test edilmiş yüzeyi.

**Kırılganlık merkezde değil, kenarlarda.** İki bağımsız lane BLOCK verdi ve nedenleri örtüşüyor.

### 2. Bulguların ardındaki sistemik desenler

Bireysel bulgular altı tekrar eden desene indirgeniyor:

- **P1 — İstek yolu dışı tenant sızıntısı.** Fail-closed
  sınır (`runInTenantTransaction`, `search_path` read-back, FORCE RLS) yalnızca HTTP/GraphQL
  isteğinde geçerli. Cron'lar, ham `QueryRunner` kullanan
  handler'lar (`allocate-to-tank.handler.ts:114` — dosyada tek
  bir `pinTenantTransactionSearchPath`/`assertTenantTransactionContext` çağrısı yok,
  **doğrulandı**), `WaterQualityService.create` ve NATS tüketicileri bu sınırın dışında.
  Cron'larda `search_path` pinleniyor ama RLS GUC bağlanmıyor → politika her satırı reddediyor, iş
  "başarılı" loglayarak sessizce no-op oluyor.
- **P2 — Yazıcısı olmayan dayanıklı yüzeyler (provenance boşluğu).** `batch_locations` (okuyucu:
  traceability raporu, `Batch.locations`, hedef-FCR zinciri — **hiçbir yazıcı yok,
  doğrulandı**), `batches_v2.sgr` (**hiçbir `.sgr =` ataması yok, `doğrulandı**`; iki forecast yolu
sessizce 1.5 %/gün sabitine
düşüyor),
`escape_incidents.varslingReportId`,
`farm_incident_media`, `protocolId`, `inbox_messages`, `event_dlq`. Şema var, UI var, veri asla
  yok.
- **P3 — Katman disiplininin bölgesel çöküşü.** Water-quality, task, maintenance ve fish-health'te
  ~34 mutation CommandBus'ı atlıyor; maintenance sıfır domain event yayıyor;
  fish-health'te `commands/` dizini hiç yok. Aynı serviste batch/storage/finance tam CQRS. Kural
  yazılı, gate yok → yeni bounded context'ler ihlalle doğuyor.
- **P4 — Uydurulmuş
  çıktı.**
  `ai-insights.service.ts:156-163`
  (`currentWeightG: 100, currentQuantity: 10000, sgr: 2.0`)
  ve `:279-287` (`feedKg: 5.0, biomassKg: 500`) — `batchId`/`tankId` MCP çağrısına **hiç girdi
  olarak geçmiyor**, yalnızca cache anahtarında ve sonuçta yankılanıyor
  (**doğrulandı**). `tenantId` de aynı şekilde yalnızca cache anahtarı.
  Modül `app.module.ts:461`'de kayıtlı ve `MODULE_USER`'a açık; tek
  bariyer `MCP_ENABLED` varsayılan `false`.
- **P5 — Yeşil ama çalışmayan gate'ler.** AquaMobil'in 66 spec'i hiçbir CI yolunda
  koşmuyor (`package.json`'da `test` script'i yok, `project.json` yok —
  **doğrulandı**); `ci-affected.yml`'ın `test:invariant` adımı sıfır projeye
  çözülüyor; `farm-service:test:integration` hiçbir workflow tarafından çağrılmıyor, yani
  CLAUDE.md'nin adıyla andığı tenant-schema-routing spec'i ve 8 postgres izolasyon spec'i **yazılmış
  ama koşmuyor**. Invariant'lar yalnızca `*.handler.ts` tarıyor. Bu, P1 ve P3'ün neden yeşil suite
  ile yaşayabildiğinin açıklaması.
- **P6 — Yönetilmeyen geçiş penceresi.** `feed_inventory` (okuyucusuz/yazıcısız ama her tenant
  şemasına klonlanan öksüz tablo), v1/v2 yem protokolü çift yolu, hâlâ çağrılabilir legacy
  feeding-program mutation'ları, `BatchService:567`'deki ölü ikinci `tank_batches` yazıcısı.
  Cutover'lar okuma tarafında bitmiş, yazma yüzeyi kapatılmamış.

### 3. Öncelikli düzeltme sırası (mimari tier ile)

1. **Cron/scheduler tenant bağlamı** (P1) — `*make-impossible*`: `forEachTenantSchema` helper'ı
   yalnızca `withTenantContext` \+ `runInTenantTransaction` içinden bir manager verebilsin;
   ham `QueryRunner`'a erişim tipten kaldırılsın. `SET search_path TO "${schema}"` interpolasyonu
   helper içine gömülüp `validateTenantSchemaName`'den geçsin.
2. **AI-insights** (P4) — `*make-impossible*`: uydurma sabitlerle çağrılan iki tool yolu silinsin;
   tool girdisi batch/tank agregatından türetilmedikçe derlenmesin (branded snapshot
   tipi). `tenantId` MCP çağrısının zorunlu parametresi olsun.
3. **`skipCapacityCheck`** — `*make-impossible*`: public `TransferBatchInput`'tan kaldırılıp
   yalnızca internal reconciliation komutunda kalsın; can güvenliği bypass'ı GraphQL şemasında
   görünmesin.
4. **`AllocateToTankHandler` \+ `WaterQualityService.create`** (P1)
   — `*make-automatic*`: `runInTenantTransaction`'a taşınsın;
   ham `createQueryRunner()` farm-service'te lint kuralıyla yasaklansın.
5. **CI gate'lerinin gerçekten koşması** (P5)
   — `*make-detectable*`: aquamobil'e `test` target'ı, `test:integration`'ın workflow'a
   bağlanması, `test:invariant`'ın tanımlanması ya da kaldırılması, invariant
   tarayıcısının `*.service.ts|*.resolver.ts|*.dataloader.ts`'e genişletilmesi. Bu adım 1–4'ün
   regresyonunu da kilitler.
6. **Yazıcısız kolon/tablo sınıfı** (P2) — `*make-detectable*`: "declared+read but never written"
   invariant'ı (entity kolonu \+ GraphQL `@Field` var, repoda atama yok → kırmızı).
   Ardından `batch_locations` ve `batches_v2.sgr` yazıcıları eklensin (growth handler SGR'yi zaten
   hesaplıyor, yalnızca persist etmiyor).
7. **CommandBus \+ event disiplini** (P3) — `*make-detectable*`: resolver
   mutation'larının `commandBus.execute` çağırmasını zorlayan invariant; maintenance/fish-health
   için outbox event'leri.
8. **Harvest `batch.status` yazımı** — `*make-impossible*`: `status` setter'ı private olsun, geçiş
   yalnızca `BatchLifecyclePolicyService` üzerinden; entity'deki kopya geçiş tablosu silinsin.
9. **Geçiş penceresi kapatma** (P6) — `*make-automatic*`: `feed_inventory` retirement migration'ı,
   legacy mutation'ların API'den kaldırılması, ölü ikinci `tank_batches` yazıcısının silinmesi.

### 4. Gerçekten eksik olan vs. yalnızca tamamlanmamış

**Gerçekten EKSİK (hiç yok):**

- Cron/scheduler yolunda tenant izolasyonu — hem mekanizma hem testi yok.
- Inbox (dayanıklı tüketici dedupe) ve event DLQ — tablo var, kod sıfır.
- AquaMobil offline kuyruğunun kimlik (userId) boyutu ve oturum-kurulum artık temizliği.
- NATS tüketici zarf↔payload tenant çapraz kontrolü (`TenantValidatingConsumer` sıfır
  adopsiyon; `handle()` subject almıyor).
- PO→supplier master ve PO→finance ledger bağlantısı; tedarikçi harcaması sorgulanabilir değil.
- Düşük stok/reorder zinciri (yem ve kimyasal için `minStock` editörü hiçbir UI'da yok → tüm makine
  ölü).
- Yedek parça stok hareket defteri (bellekte üretilip atılıyor).
- Mutation testing, aquamobil↔farm-service root-field parity invariant'ı, farm-module generated
  GraphQL tipleri, `contract-parity.spec.ts`.

**Yalnızca TAMAMLANMAMIŞ (doğru omurga, eksik kenar):**

- Batch stocking, water-quality yazma yolu, harvest status yazımı — mimari doğru, tek bir çağrı
  eksik.
- — okuma tarafı
  bitmiş, yazıcı eksik; hepsi tek handler değişikliği.

  ```text
  batch_locations`, `sgr`, `protocolId`, `varslingReportId`, `farm_incident_media
  ```

- Test kapsamı: kalite iyi (308 spec, 1 assertion'sız test, 400 `toHaveBeenCalledWith`), **erişim**
  kötü (80 handler, 46/51 resolver spec'siz, coverage tabanı %20.39 fonksiyon).
- Feeding v1/v2 çift yol — kontrollü ve dokümante geçiş, ama Phase 8 emekliliği inmemiş.
- Finance site-scoped raporlama — davranış bilinçli ve doğru, yetenek eksik.
- GraphQL contract gate'leri — çalışıyor ve drift baseline sıfır, ama path filtresi ~30 dosyayı
  atlıyor.

**Bir düzeltme:** `tenant-isolation-auditor`'ın PRODUCT-TENANT-HIGH-001 blast radius listesi
MinIO-orphan cron'unu fazladan kapsıyor — `cron-jobs.service.ts:945` bu işi doğru
şekilde `withTenantContext` içinde çalıştırıyor (gerekçesi :908-917'de yazılı). Diğer cron'lar için
bulgu geçerli.

## AquaMobil sentezi

### AquaMobil PWA — Sentez (2026-08-16)

### 1. Uygulamanın genel hâli

Altyapı gerçekten olgun: AES-GCM şifreli, tenant-partitionlı IndexedDB kuyruğu; payload-hash
dedup; `clientCommandId` zarfı ve sunucu tarafında at-most-once makbuz defteri; foreground ile
kapalı-uygulama SW lane'inin paylaştığı Web Lock; `satisfies Record<OperationType,…>` ile derleme
zamanı zorunlu invalidation haritası; bellek-içi token \+ single-flight refresh; iki gerçek Tier-3
build invariant'ı. Yani **mimari iskelet sağlam, kenarlar çürük**: üç günlük saha akışı üretimde
fiilen ölü.

### 2. Saha çalışanının yaşadığı gerçek (doğrulanmış)

- **Su kalitesi hiç kaydedilmiyor.**
  Client `parameters: {}` gönderiyor (`WaterQualityRecordPage.tsx:212`), sunucu DTO'sunda böyle
  bir `@Field` yok — üstelik el yazımı tip `types/index.ts:571` bu alanı **zorunlu** kılıyor. Online
  hata banner'ı, offline **yeşil "Measurement Recorded!"**.
- **Fotoğraflı kanıt üretimde hiç yüklenemiyor (YENİ).** Presign URL'i `minio:9000` iç ağ adına
  üretiliyor
  (); minio
  yalnız `aqua-internal` ağında, yayınlanmış port yok, nginx proxy yok.
  CSP (`connect-src 'self' wss:`) ikinci duvar; birinci duvar çözümlenemeyen host.
  Kaçak/lice/welfare kanıt fotoğrafı ve mesajlaşma eki üretimde imkânsız.

  ```text
  minio-client.service.ts:288`, `app.module.ts:410`, `docker-compose.droplet.yml:885
  ```

- **Vardiya sonu logout = veri imhası.** `useAuth.tsx:195` `clearAllOperations()` tenantId'siz,
  koşulsuz; refresh başarısızlığındaki otomatik logout da aynı yolu izliyor. Uyarı yok, sayaç yok,
  export yok.
- **Kalıcı teslim edilemezlik.** `calculateRetryDelay` (`offline-queue.ts:858`) repo genelinde
  **çağrısız** — gerçek ritim sabit 30 sn × 5; sonrası tek çare silmek. Sınıflandırıcı İngilizce
  substring, farm-service'in Türkçe hata sözlüğüne kör.
- **Kritik alarm yalan söylüyor.** `useAlerts.ts:100-121` yalnız kuyruğa yazıp
  cache'i `acknowledged: true` yapıyor; op id atılıyor, kalıcı snapshot güncellenmiyor.
- **Yetkilendirme sızıntısı.** `mobile-settings.service.ts:23` okuma yolunda all-true satır yazıyor
  ve `token.service.ts:561` her token basımında çağırıyor → `PANEL_ONLY` hesap ilk login'de tam
  mobil hak
  alıyor. `recordMealFeeding` (`meal-execution.resolver.ts:192`) `@RequiresMobileFeature` taşımıyor.

### 3. Öncelikli düzeltme sırası (ve inmesi gereken tier)

1. **Su kalitesi \+ tip aynası** — `parameters`'ı sil;
   codegen `documents` globuna `pwa/**`, `pages/**`, `hooks/**` ekle ve el yazımı input aynalarını
   üretilen tiplerle değiştir. **Tier 1**. Not: mevcut `validate-graphql-operations.mjs` bunu
   **yapısal olarak** göremez; sorgu metni `$input: CreateWaterQualityInput!`, sapma yalnız TS
   aynasında.
2. **Storage public endpoint** — `MINIO_PUBLIC_ENDPOINT` (ya da nginx `/storage` proxy) \+ presign'ı
   ondan üretme, CSP'ye o origin'i ekleme, boot-time doğrulama. **Tier 1/2** (yanlış konfig ayağa
   kalkmasın).
3. **Logout ↔ kuyruk** — bekleyen op varken logout'u onaysız yıkımdan çıkar: sayaç göster,
   "senkronize et" veya bilinçli onay; otomatik logout'ta kuyruğu **koru** (kimlik değil, veri).
   **Tier 2**.
4. **Backoff'u bağla \+ kalıcı hataya kurtarma yolu** — `calculateRetryDelay`'i drain'e tak,
   sınıflandırmayı mesaj metninden GraphQL `extensions.code`'a taşı. **Tier 1** (dize eşleme yerine
   tipli kod).
5. **Entitlement fail-closed** — otomatik provizyonu kaldır (yok = reddet), `accessType`'ı sunucuda
   uygula, `MobileFeatureGuard`'ı global `APP_GUARD` \+ dekoratör↔guard invariant'ı. **Tier 1/3**.
6. **Ack/queued dürüstlüğü** — `QueuedStatusBadge` sözleşmesini ack, su kalitesi, stok ve besleme
   ekranlarına yay; `SyncStatus.unknown` ve 7 eksik etiket için
   exhaustive `Record<OperationType,…>`. **Tier 1**.
7. Timestamp'ler (clock-in/out, ack, lice UTC günü), `harvestPlanId`, leave `totalDays` sunucu
   hesabı. **Tier 1–2**.

### 4. Gerçekten eksik vs sadece yarım

**Eksik (hiç yok):** tarayıcıdan erişilebilir storage endpoint'i; çakışma tespiti (version/etag) ve
uzlaştırma UI'ı; offline foto yakala-sonra-yükle lane'i; aquamobil↔farm-service root-field
invariant'ı; `accessType` sunucu katmanı; l10n (Intl/timezone) katmanı; kuyruk-dolu (180) uyarı
UI'ı; proaktif token yenileme.
**Yarım (iskelet doğru, kapsam dar):** codegen (67/122 doküman); i18n (mekanizma Tier-1 doğru, ~40
sayfanın 1'i); tenant-admin editörü (16 bayrağın 6'sı); sync durum sayfası (24 tipin 17'si); SW blob
replay; entitlement guard kaydı. Yarım olanlar ucuz; eksik olanlar bu turun asıl işi.

**Verdict: BLOCK.** Üç saha akışı (su kalitesi, kanıt fotoğrafı, kritik alarm onayı) üretimde ya
reddediliyor ya da sessizce yalan söylüyor.

## Bu denetim neyi kaçırdı (completeness critic)

Denetim, farm-service'in GraphQL yüzeyini ve aquamobil'in kayıt formlarını derinlemesine taradı;
ancak üç yapısal kör nokta bıraktı.

Birincisi ve en ciddisi: on iki ajan da CRITICAL su kalitesi hatasını semptom olarak raporladı,
hiçbiri sınıfını teşhis etmedi. Kök neden `web/apps/aquamobil/src/types/index.ts:562` içindeki EL
YAZISI girdi tipidir — `parameters` zorunlu, `equipmentId`/`dynamicParameters` opsiyonel, yani
sunucu SSoT'unun tam tersi. contract-parity yalnızca SONUÇ tiplerini denetledi; girdi/değişken
ekseni hiçbir gate ve hiçbir ajan tarafından incelenmedi. Aynı desende 14 girdi tipi daha korumasız.

İkincisi: yetki denetimi GraphQL ile sınırlı kaldı. 7 NATS `@MessagePattern` responder'ı — biri
YAZMA yolu (`request.farm.createTask`) — hiçbir envanterde yok. `PermissionMatrixGuard` graphql dışı
bağlamda
doğrudan
NATS payload'undan gelir.

```text
true` döner, `resolver-scanner` yalnızca `*.resolver.ts` yürür; `tenantId` ve `createdBy
```

Üçüncüsü: kesişen kaygıların çoğu hiç açılmadı — gözlemlenebilirlik, performans, faturalama
bağlantısı, alert-engine tüketici tarafı ve aquamobil'in hr/messaging/notification arka uçları.
Ayrıca farm-expert'in "bu bağlamlarda katman ihlali yok" beyanı yanlıştır: 10 `restore*` mutasyonu
CommandBus'ı atlar ve hiç domain event yayınlamaz.

| ID                 | Sev      | Kör nokta                                                                                                                                                                            |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CTX-CRITICAL-001` | CRITICAL | The GraphQL INPUT/variable axis was audited by nobody — it is exactly where the one CRITICAL defect lives, and 14 more hand-written input types sit on the same ungated path         |
| `CTX-LOW-002`      | LOW      | Seven NATS request-reply responders — including a write path — got zero audit attention from both the access-boundary and tenant-isolation agents                                    |
| `CTX-MEDIUM-003`   | MEDIUM   | farm-expert declared nine setup contexts clean with a blanket unverified claim; ten `restore*` mutations in exactly those contexts bypass the CommandBus and emit no domain event    |
| `CTX-MEDIUM-004`   | MEDIUM   | Observability was examined by no agent — and the metrics/alerting stack structurally cannot see the audit's own CRITICAL defect                                                      |
| `CTX-HIGH-005`     | HIGH     | Legal hold and GDPR erasure enforcement is exercised only by specs in the dead test:integration lane — data-expert reported the mechanism as present without noting it is unexecuted |
| `CTX-MEDIUM-006`   | MEDIUM   | Performance was examined by no agent: 112 @ResolveField against 6 DataLoaders, no query-budget gate, no load test                                                                    |
| `CTX-MEDIUM-007`   | MEDIUM   | Four of the five backends aquamobil actually calls were never read, yet three agents made behavioral claims about them                                                               |
| `CTX-MEDIUM-008`   | MEDIUM   | Nine aquamobil pages (~2,980 lines) were never opened, including the WebAuthn enrollment half of the accessType bypass the access agent reported                                     |
| `CTX-LOW-009`      | LOW      | Every claim about what CI executes, what is green, and what is stale is a static file read — nothing in this audit was run                                                           |
| `CTX-MEDIUM-010`   | MEDIUM   | farm-service infrastructure and cross-cutting directories got no inventory row from any agent                                                                                        |
| `CTX-MEDIUM-011`   | MEDIUM   | Billing coupling was never examined and does not exist: farm-service has no subscription or plan-tier gate on any write path                                                         |
| `CTX-LOW-012`      | LOW      | Three agents each filed the same water-quality defect as a top finding, inflating the apparent finding count and splitting ownership of one root cause                               |

## Ne var / ne eksik — farm-service

| Durum           | Alan                                                                                                       | Not                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MISSING**     | Düşük stok / reorder zinciri                                                                               | LowStockDetected outbox enqueue, warehouse KPI ve forecast coverage band'ları var ama tümü minStock `>` 0'a bağlı; yem ve kimyasal için minStock'un hiçbir UI'da editörü yok. Zincir bu iki item tipi için tamamen ölü.                                                                                                                                                                                                                                     |
| **MISSING**     | NATS tüketici tarafı tenant doğrulaması ve hata dayanıklılığı                                              | TenantValidatingConsumer export ediliyor ama sıfır adopsiyon; IEventHandler.handle() msg.subject almadığı için zarf↔payload çapraz kontrolü uygulanabilir değil. Her iki listener handler hatalarını yutuyor — mortalite alarmı ve hasat izlenebilirlik kaydı geçici hatada kalıcı olarak kayboluyor.                                                                                                                                                      |
| **MISSING**     | Scheduler / cron tenant izolasyonu                                                                         | Per-tenant fan-out ve advisory lock var ama RLS GUC bağlanmadığı için FORCE'lu politika her satırı reddediyor: bakım, düşük stok, FCR, yemleme planı, retention ve haftalık özet cron'ları sessiz no-op. TenantCronConfig haritası da bağlamsız okunduğu için boş. İstisna: minioOrphanCleanup doğru şekilde withTenantContext içinde (SYNTH-LOW-003).                                                                                                      |
| **MISSING**     | Test erişimi ve CI gate'lerinin gerçekten koşması                                                          | Assertion kalitesi iyi (308 spec, 1 assertion'sız test, 0 skip) ama erişim yok: AquaMobil'in 66 spec'i hiçbir CI yolunda koşmuyor (test script'i ve project.json yok — doğrulandı), test:invariant sıfır projeye çözülüyor, farm-service:test:integration hiçbir workflow'dan çağrılmıyor — CLAUDE.md'nin andığı tenant-schema-routing spec'i ve 8 postgres izolasyon spec'i yazılmış ama koşmuyor. Coverage tabanı %20.39 fonksiyon; mutation testing yok. |
| **MISSING**     | `batch_locations` (yerleşim geçmişi)                                                                       | Tablo, entity, index, DataLoader, traceability toplayıcısı ve sevk edilmiş web sekmesi var; hiçbir kod satır yazmıyor. Doğrulandı: yalnızca okuma çağrıları mevcut.                                                                                                                                                                                                                                                                                         |
| **PARTIAL**     | AquaMobil offline kuyruğu ve oturum sınırı                                                                 | Tenant partisyonu, AES-GCM at-rest cache ve kapsamlı logout teardown'u doğru. Ama kuyruk kimlik (userId) boyutu taşımıyor: logout'sız biten bir oturumdan sonra sıradaki kullanıcı öncekinin escape/mortality/harvest kayıtlarını kendi kimliğiyle replay ediyor. Oturum kurulumunda artık temizliği yok.                                                                                                                                                   |
| **PARTIAL**     | Bakım (iş emri, program, yedek parça)                                                                      | GraphQL arkasında tam CRUD \+ onay akışı, ancak 22 mutation CommandBus'ı atlıyor, bounded context sıfır domain event yayıyor ve yedek parça stok hareketi bellekte üretilip atılıyor — audit izi olmayan beşinci stok defteri.                                                                                                                                                                                                                              |
| **PARTIAL**     | Balık sağlığı (lice, welfare, treatment, escape, media)                                                    | Zengin entity/servis/query kapsamı ve çalışan hasat-uygunluk gate'i var, ama commands/ dizini hiç yok — 14 mutation resolver→service. Yalnızca escape event yayıyor. varslingReportId hiç yazılmıyor, `farm_incident_media` salt-yazılır, recordTreatmentApplication/closeEscapeIncident'in frontend çağıranı yok.                                                                                                                                          |
| **PARTIAL**     | Batch stocking / allocate-to-tank                                                                          | SERIALIZABLE izolasyon, kapasite zorlaması ve idempotency makbuzu tam; ancak fail-closed tenant sınırının dışında kalan tek stok mutasyonu. Doğrulandı: dosyada hiç pinTenantTransactionSearchPath/assertTenantTransactionContext yok.                                                                                                                                                                                                                      |
| **PARTIAL**     | Büyüme ölçümü \+ SGR/FCR/biyokütle formül SSoT                                                             | Formüller tek otoriteli ve doğru (doğal-log SGR, TankOperation düzeltmeli kümülatif FCR, derive-on-read biyokütle). Ancak hesaplanan SGR `batches_v2.sgr'ye` hiç yazılmıyor — doğrulandı — ve iki forecast yolu sabit 1.5 %/gün'e düşüyor.                                                                                                                                                                                                                  |
| **PARTIAL**     | Finans (kategori, kayıt, ayar, türetilmiş maliyet)                                                         | Query-time türetme, CI parity spec'i, tek UNION ALL agregasyonu, exact Decimal para ve tam FE parity. Eksik yetenek: her `DERIVED_COST_SOURCE'ta` siteIdExpr null olduğu için site-filtreli defter yalnızca manuel kayıtları gösteriyor (bilinçli, dokümante). Handler test kapsamı servisin en zayıfı (13'te 11 spec'siz).                                                                                                                                 |
| **PARTIAL**     | GraphQL kontrat parity gate'leri                                                                           | Doküman↔şema ekseni sıkı: validate-graphql-operations.mjs drift baseline'ı sıfır, aquamobil codegen çıktısı güncel (67/67). Delikler: her iki CI workflow'u dosya-adı sonekiyle filtrelendiği için ~30 @ObjectType dosyası gate'leri atlıyor; aquamobil için root-field parity invariant'ı yok; farm-module'ün 342 operasyonunun generated tipi yok; contract-parity.spec.ts hiç mevcut değil.                                                             |
| **PARTIAL**     | Hasat (kayıt, plan, istatistik, kapanış zinciri)                                                           | Withdrawal-period gate, plan-zorunlu politikası, kilitli lot sekansı ve otomatik kapanış güçlü. Kusurlar: batch.status doğrudan yazılıyor (lifecycle policy atlanıyor), updateHarvestRecord altı alanı sessizce düşürüyor, on kolonun yazıcısı yok, rapor ekonomisi sabit 50/kg.                                                                                                                                                                            |
| **PARTIAL**     | Satın alma emri (PO) yaşam döngüsü ve tedarikçi/finans bağlantısı                                          | Maker-checker ayrımı, kısmi teslim alma ve outbox emisyonu doğru. Ama `supplier_name` serbest metin (supplierId FK yok) ve `total_amount` `DERIVED_COST_SOURCE` değil — tedarikçi harcaması ve satın alma maliyeti finans sekmesinde hiç görünmüyor.                                                                                                                                                                                                        |
| **PARTIAL**     | Stok fiziksel defteri (`storage_inventory` \+ `stock_movements`), lot izlenebilirliği ve roll-up kolonları | Defterin kendisi partisyonun en güçlü yüzeyi: FEFO, lot-karışım, pessimistic lock, idempotency, değişmez hareket satırı, tek sink. Zayıflatanlar: item-master create defter satırı olmadan quantity yazıyor, ApproveInventoryCount roll-up'ı yeniden hesaplamıyor, lotsuz satırlar unique index'te adreslenemiyor, `received_date` default'u yok.                                                                                                           |
| **PARTIAL**     | Su kalitesi — parametre konfigürasyonu ve ölçüm yazma yolu                                                 | Tenant-yapılandırılabilir parametreler, şablon uygulaması ve okuma tarafı (7 query handler \+ UI) eksiksiz. Yazma tarafı bozuk: beş mutation CommandBus'ı atlıyor ve create/createBatch ham QueryRunner üzerinde tenant sınırının dışında. Üç kolon ölü.                                                                                                                                                                                                    |
| **PARTIAL**     | Transactional outbox \+ event kontratları \+ migration hijyeni                                             | ~119 üretici dosyada benimsenmiş; lease/backoff/dead-letter/idempotency ve doğru BatchHarvested v1→v2 upcaster'ı var; 76 migration manifest'le birebir, session-scoped `search_path` yok. Eksikler: `inbox_messages` ve `event_dlq` sıfır kodla duran tablolar, dokuz event kontratının üreticisi yok, JSON Schema doğrulaması PII taşıyan varsling üçlüsünü kapsamıyor.                                                                                    |
| **PARTIAL**     | Yem oranı SSoT ve legacy yüzeyler (geçiş penceresi)                                                        | v1 ve v2 oran servisleri bilinçli drain penceresinde birlikte yaşıyor; legacy program/protocol mutation'ları cutover sonrası hâlâ çağrılabilir, gate yalnızca cron katmanında. Aynı desende `feed_inventory` okuyucusuz/yazıcısız halde her tenant şemasına klonlanmaya devam ediyor.                                                                                                                                                                       |
| **IMPLEMENTED** | ADR-011 şema yerleşimi ve entity sınıflandırması                                                           | Partisyondaki ~98 entity `MODULE_SCHEMAS['farm']` altında tam sınıflandırılmış; per-tenant tablolar schema: atlıyor, yalnızca outbox / `farm_audit_logs` / `tenant_erasure_audit` schema:'farm' deklare ediyor ve üçü de meşru cross-tenant kümede. public'te hiçbir tablo yok. Tek zafiyet: CLAUDE.md'nin andığı routing invariant'ının allowlist'i iki meşru entity'yi saymıyor (bayat/kırmızı).                                                          |
| **IMPLEMENTED** | Batch yaşam döngüsü (create / status / close / transfer / grading)                                         | Tam CQRS, pessimistic lock, runInTenantTransaction, outbox. Close finalFCR/mortalityRate/daysInProduction'ı transaction içinde donduruyor. Eksik: geçiş tablosu entity'de kopyalanmış ve transfer yolunda audit satırı yok (SYNTH-HIGH-001).                                                                                                                                                                                                                |
| **IMPLEMENTED** | Karışık-batch tank atfı (`tank_batches.batchDetails`)                                                      | applyBatchDelta gerçek tek yazıcı; tüm türetilmiş alanlar her mutasyonda batchDetails'ten yeniden hesaplanıyor. İki kusur: kapasite bayrakları çıkışlarda yenilenmiyor, BatchService'te emekli batchDetails discard'ını taşıyan ölü ikinci yazıcı duruyor.                                                                                                                                                                                                  |
| **IMPLEMENTED** | Mortalite / cull / tank-operation defteri                                                                  | Atomik miktar+biyokütle azaltımı, zorunlu idempotency zarfı, site yetkilendirmesi, dayanıklı audit satırı ve outbox event'i. TankOperation defteri FCR net-çıkış hesabını ve batch geçmişi UI'ını besliyor.                                                                                                                                                                                                                                                 |
| **IMPLEMENTED** | Regülasyon (Mattilsynet / Altinn) \+ compliance \+ tenant erasure                                          | Servisin en derin yüzeyi: sekiz per-report assembler, provenance, Maskinporten token cache, schema-registry doğrulaması, deadline motoru, circuit breaker, erasure/export. 34 spec ile en iyi test edilen alan. Erasure planı outbox/inbox/DLQ satırlarını kapsamıyor.                                                                                                                                                                                      |
| **IMPLEMENTED** | Yemleme defteri \+ protokol v2 (day plan, meal, recalc)                                                    | FeedingLedgerService tek yazma yolu; stok düşümü, batch agregası ve outbox event'i atomik. Day-plan yeniden hesabı mortalite/hasat/transfer/sıcaklık yazmalarından transaction içinde tetikleniyor. Meal entity'lerinde DecimalTransformer eksik.                                                                                                                                                                                                           |
| **IMPLEMENTED** | İstek yolu tenant sınırı (JWT → HMAC → `search_path` → RLS)                                                | VerifiedUserAssertionMiddleware imzalı effectiveTenantId'den req.user'ı yeniden kuruyor, `search_path` her pool checkout'unda pinleniyor, runInTenantTransaction şema+GUC read-back ile fail-closed, TenantScopedRepository where()'i sertleştiriyor. Tek delik: @Cacheable Redis anahtarını ham x-tenant-id header'ından alıyor.                                                                                                                           |

## Ne var / ne eksik — AquaMobil

| Durum           | Alan                                                                               | Not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MISSING**     | Kanıt fotoğrafı / medya yükleme hattı (incident, lice, welfare, mesajlaşma ekleri) | Üretimde tarayıcıdan erişilemez: presign URL'i iç ağa özel `minio:9000` host'una üretiliyor, minio yayınlanmış portu ve nginx proxy'si olmayan iç ağda. CSP (`connect-src 'self' wss:`) ikinci duvar. Ayrıca offline yakalama tamamen devre dışı, dolayısıyla offline kaydedilen kaçak olayı kanıtsız gidiyor.                                                                                                                                                                                                       |
| **MISSING**     | Mobil entitlement modeli (isMobileEnabled, accessType, 16 feature bayrağı)         | Fail-closed provizyon yok: satırı olmayan kullanıcı için OKUMA yolu all-true \+ `isMobileEnabled: true` satır YAZIYOR ve bu, her access-token basımında çağrılıyor — `PANEL_ONLY` hesap ilk login'de tam mobil hak alıyor. `accessType` hiçbir sunucu katmanında zorlanmıyor; biyometrik loginWithToken bu claim'i hiç çekmiyor. `MobileFeatureGuard` opt-in kayıtlı ve dekoratör↔guard'ı bağlayan invariant yok. `checkMobileEnabled` istemcide hâlâ `?? true` ile fail-open.                                      |
| **MISSING**     | Su kalitesi ölçümü kaydı (createWaterQualityMeasurement)                           | Uçtan uca ölü: istemci `parameters: {}` gönderiyor, sunucu DTO'sunda böyle bir alan yok — GraphQL input coercion her gönderimi reddediyor. Offline dalda yeşil 'Measurement Recorded!' gösterilip op kuyrukta retry'larını tüketiyor. Mobilden fiilen su kalitesi kaydı yok.                                                                                                                                                                                                                                         |
| **MISSING**     | Çakışma tespiti ve uzlaştırma (server satırı değiştiğinde)                         | Hiçbir kuyruk payload'ı beklenen sürüm/satır zaman damgası taşımıyor. Makbuz defteri yalnız aynı clientCommandId'nin farklı payloadHash ile tekrarını görebiliyor; üçüncü tarafın satırı değiştirdiğini göremiyor. Replay'deki ConflictException genel 'failed' op'a düzleşiyor, tek operatör eylemi silmek. LWW riski bugün yalnız tüm op'ların append ya da mutlak-idempotent-set olması sayesinde ulaşılamaz durumda — yapısal bir engel yok.                                                                     |
| **PARTIAL**     | Besleme — v2 öğün kaydı (recordMealFeeding)                                        | İstemci tarafı sağlam: tipli feedingDayPlans kaynağı, şifreli 12s offline cache, dürüst 'cache'ten sunuldu' banner'ı, kısmi döküm (finalize), payload RecordMealFeedingInput ile birebir, başarı ekranı 'queued for sync' diyor. Ama sunucuda `@RequiresMobileFeature('feeding')` yok — v2 cutover'ında entitlement zorlaması kayboldu; legacy recordDailyFeeding hâlâ zorluyor.                                                                                                                                     |
| **PARTIAL**     | Depo: stok hareketi / stok transferi                                               | Barkod okumalı sihirbaz akışları, online-first \+ kurtarılabilir ağ hatasında kuyruğa düşme, `isOnline ? 'Movement Recorded!' : 'Queued for Sync'` dürüst etiketi. Kusurlar: idempotencyKey her gönderim DENEMESİNDE yeniden üretiliyor (hem sunucu at-most-once'ını hem kuyruk payload-hash dedup'ını etkisizleştiriyor), DTO'nun `reference`/`movementDate`/`lotNumber`/`reason` alanlarının input yüzeyi yok, online transport hatası sonrası fallback hâlâ online metnini gösteriyor.                            |
| **PARTIAL**     | GraphQL sözleşme kapısı (codegen \+ doküman doğrulama)                             | İki mekanizma var ve ikisi de bu sınıfı kaçırıyor: doküman-metni doğrulaması (validate-graphql-operations.mjs, baseline ZERO) `$input: X!` yazan mutation'larda değişken ŞEKLİNİ göremez; codegen globu yalnız `src/graphql/**` (122 dokümanın 67'si). Sonuç: kuyruğun tüm input tipleri el yazımı ayna. Ayrıca her iki CI workflow'u dosya-adı sonekiyle path-filtreli ve ~30 farm-service @ObjectType dosyasını (meal-execution.results.ts dahil) atlıyor; aquamobil↔farm-service root-field invariant'ı hiç yok. |
| **PARTIAL**     | Görev yaşam döngüsü (start / complete / checklist / not)                           | Zarf zorunlu, online deneme ile offline replay aynı clientCommandId'yi paylaşıyor, checklist MUTLAK hedef gönderdiği için replay yakınsıyor, `wasQueued` UI'ı dürüst tutuyor. Zayıflık: blanket `catch` sunucu REDDİNİ de sahte 'queued' başarıya çeviriyor, op sonra kuyrukta kalıcı ölüyor. Not ekleme bilinçli online-only ve dürüstçe reddediliyor ama zarfsız (kayıp yanıt not'u çoğaltabilir).                                                                                                                 |
| **PARTIAL**     | Hasat kaydı (createHarvestRecord)                                                  | Toplanan alanlar kalıcılaşıyor, ama DTO'nun on alanının hiç yazma yolu yok (`method`/`productForm` sabit literallerle eziliyor) ve politikanın 10 t / 50 k balık üzerinde ZORUNLU kıldığı `harvestPlanId` için hiçbir input yüzeyi yok — büyük hasatlar yapısal olarak kaydedilemez. Rol/entitlement kapısı ise üç katmanda doğru.                                                                                                                                                                                   |
| **PARTIAL**     | Kritik alarm onayı (acknowledgeAlert)                                              | Okuma yolu iyi (30sn poll, şifreli offline fallback, yanlış 'her şey yolunda' göstermiyor, kalıcı kritik banner). Yazma yolu dürüst değil: yalnız yerel kuyruk yazımından koşulsuz 'Acknowledged' gösteriliyor, dönen op id atılıyor (senkron durumu hiçbir tüketici okuyamıyor) ve kalıcı IndexedDB snapshot güncellenmediği için soğuk offline açılışta banner geri geliyor. Not alanı uçtan uca bağlı ama UI yok; acknowledgedAt replay anında damgalanıyor.                                                      |
| **PARTIAL**     | Logout / oturum sonu cihaz temizliği                                               | Gizlilik tarafı güçlü ve doğru await'lenmiş (IndexedDB, AES anahtarı, biyometrik PII, React Query, barrier re-arm; başarısız temizlik reject ediyor). Erişilebilirlik tarafı yıkıcı: `clearAllOperations()` tenantId'siz ve koşulsuz — refresh hatasındaki otomatik logout dahil, senkronize edilmemiş tüm saha kayıtları uyarısız siliniyor. Cache Storage temizliği ise var olmayan bir cache adını hedefliyor.                                                                                                    |
| **PARTIAL**     | Mesajlaşma (kanal, mesaj, gönder/düzenle/sil/okundu, medya)                        | Dört yazma tipi de birinci sınıf kuyruk operasyonu ve tek drain'i paylaşıyor; binary lane blob'ları şifreli saklayıp presign→PUT→send'i kararlı idempotencyKey ile replay ediyor ve blob'u yalnız teyitli gönderimden sonra siliyor; cache'ler user-scoped. Tek ama yıkıcı koşul: medya hattı üretimde erişilemez storage endpoint'ine dayanıyor (bkz. SYNTH-CRITICAL-001).                                                                                                                                          |
| **PARTIAL**     | Puantaj giriş / çıkış (clockIn / clockOut)                                         | Kuyruk-öncelikli, GPS yakalamalı, dürüst durum rozetli ve GeoLocation sunucu tipiyle birebir. Ama olay zaman damgası GÖNDERİLMİYOR: hr-service replay anında `new Date()` damgalıyor, yani offline pencere boyunca bordro saatleri ve puantaj günü kayıyor. `workAreaId` olmadığı için geofence doğrulaması bu uygulamadan erişilemez; ayrıca ne `@Roles` ne 'attendance' entitlement guard'ı var.                                                                                                                   |
| **PARTIAL**     | Regülasyon saha yakalama: lice / welfare / kaçak                                   | Kayıt yolu sağlam: site ve tür tank snapshot'ından çözülüyor (operatöre sorulmuyor), lice upsert doğal idempotent, kaçak olayları reconnect'te İLK drain ediliyor, 'varsling derhal' banner'ı yerinde. Üç boşluk: kanıt fotoğrafları offline'da toplanamıyor ve üretimde hiç yüklenemiyor; `causeDetails`/`recoveryOngoing` kontrolü yok; entitlement yalnız UI'da (sunucuda beş bayrak zorlanmıyor). countDate UTC gününden türetildiği için gece vardiyası yanlış ISO haftasına düşebilir.                         |
| **PARTIAL**     | Retry / backoff ve kalıcı hata kurtarma                                            | `calculateRetryDelay` (base 2s, 5dk cap, jitter) tam yazılmış ama repo genelinde hiçbir çağıranı yok — gerçek ritim sabit 30 sn, `MAX_RETRY_COUNT=5`. Tükenen op kalıcı olarak teslim edilemez ve tek operatör eylemi silmek. Sınıflandırıcı İngilizce substring eşlemesi, farm-service'in Türkçe hata sözlüğüne kör.                                                                                                                                                                                                |
| **PARTIAL**     | Senkron görünürlüğü (Sync Status sayfası, durum rozeti, kuyruk doluluk uyarısı)    | Kalıcı başarısız yazmanın görülebildiği TEK yüzey; op başına durum, retry sayısı, kısaltılmış hata ve manuel sil/senkronize et var. Ama etiket haritası 24 op tipinin 17'sini kapsıyor (yasal olarak kritik kaçak op'u dahil eksik), `SyncStatus.unknown` dalı hiç render edilmiyor (boş ekran), 'with backoff' iddiası yanlış, `QUEUE_WARNING_THRESHOLD = 180` sıfır tüketicili — kullanıcının ilk sinyali 200'de sert bir throw.                                                                                   |
| **PARTIAL**     | Token yaşam döngüsü (bellek-içi, single-flight refresh, SW replay authz)           | Access token yalnız bellekte; refresh httpOnly cookie üzerinde; eşzamanlı 401'ler tek refresh promise'inde birleşiyor; refresh hatası fail-closed logout \+ barrier re-arm; SW replay lane'i taze token basıyor. Eksik: proaktif/görünürlük tetikli yenileme yok (arka plandan dönen sekme ilk isteğinde 401 turu atıyor) ve fail-closed logout kuyruğu imha ediyor.                                                                                                                                                 |
| **PARTIAL**     | İzin talebi (createLeaveRequest → submitLeaveRequest)                              | Kuyruk create→submit zincirini aynı drain geçişinde kuruyor, yani 'talep edildi' vaadi iki lane'de de tutuyor. Üç kusur: `totalDays` istemcide hesaplanıp sunucuda güvenilir sayılıyor ve 'Half Day' toggle'ı tüm tarih aralığını 0.5 güne çöktürüyor; zincirin 2. adımında at-most-once kapsaması yok (kayıp yanıt = kalıcı 'Sync Failed'); createLeaveRequest'te ne rol ne entitlement kapısı var.                                                                                                                 |
| **IMPLEMENTED** | Gerçek zamanlı senkron \+ reconnect uzlaşması \+ PWA kabuğu                        | Socket.IO `/farms` tenant odasına otomatik katılım, olay başına read-model invalidation, RECONNECT'te (ilk bağlantıda değil) tam farm namespace invalidation, kanal düştüğünde 'veri gecikebilir' şeridi. PWA tarafında gerçek injectManifest SW, precache \+ soğuk-offline app-shell fallback, üç katmanlı error boundary, ~40 lazy route, tam tenant-scoped query key benimsemesi ve iki gerçek Tier-3 build invariant'ı (saha ergonomisi ratchet'i \+ emit edilen SW handler doğrulaması).                        |
| **IMPLEMENTED** | Kapalı-uygulama Background Sync drain lane'i                                       | Gerçek bir drain hattı: zero-clients kapısı, foreground ile paylaşılan `aquamobil-queue-drain` Web Lock'ı, httpOnly refresh cookie'den token basma, paylaşılan operation-registry üzerinden /graphql POST. Blob op'ları bilinçli olarak atlanıyor; ayrıca last-sync damgası yazılmıyor ve client'lara bildirim yok.                                                                                                                                                                                                  |
| **IMPLEMENTED** | Mortalite / cull kaydı                                                             | Paylaşılan RecordEntityPage iskeleti, iki adımlı review→confirm, dürüst QueuedStatusBadge iki fazlı durum, dedup edilen çift dokunuşta ayrı 'Already recorded' ekranı. Payload'lar farm şemasıyla birebir. Backend'in opsiyonel `detail`/`avgWeightG`/`biomassKg` (mode-b iri balık) alanları mobilde toplanmıyor.                                                                                                                                                                                                   |
| **IMPLEMENTED** | Offline yazma kuyruğu altyapısı (şifreleme, tenant izolasyonu, dedup, zarf)        | AES-GCM \+ non-extractable kalıcı anahtar, `pending_<tenantId>_<id>` anahtarlama (cross-tenant replay yapısal olarak imkânsız), SHA-256 payload-hash dedup (5sn penceresi), 200 op cap, monotonik tenant-başı sürüm token'ı, her op'ta clientCommandId/payloadHash/deviceId zarfı. Denetimin aradığı 'replay'de mükerrer satır' defekti bulunamadı.                                                                                                                                                                  |
| **IMPLEMENTED** | Parti transferi (transferBatch)                                                    | İki adımlı onay akışı; istemci arayüzü sunucu SSoT'una sabitlenmiş (`avgWeightG`, `biomassKg` yok) ve yeniden eklenmesi derleme hatası. 'transfer' entitlement anahtarı kardeş operasyonlarla (allocateBatchToTank, recordGrading) paylaşıldığı için bypass yok.                                                                                                                                                                                                                                                     |
| **IMPLEMENTED** | Post-sync cache invalidation / okuma yakınsaması                                   | `SYNC_INVALIDATION_SEGMENTS satisfies Record<OperationType, …>` — invalidation eşlemesi olmayan yeni bir kuyruk op tipi derleme hatası. Online ve offline yazma yolları aynı await'lenen yardımcıda buluşuyor. Repo genelinde taklit edilmesi gereken doğru idiom.                                                                                                                                                                                                                                                   |
| **IMPLEMENTED** | Rol kapısı ve feature-access SSoT (istemci ↔ sunucu @Roles aynası)                | farm-service'te global RolesGuard \+ fail-closed PermissionMatrixGuard; istemci `feature-access` SSoT'u sunucu matrisini aynalıyor (harvest ve reports için `MODULE_MANAGER` tabanı birebir uyuşuyor). FeatureRoute, entitlement bayrağını rol tabanıyla katlıyor, böylece `MODULE_USER` backend'in 403 vereceği forma ulaşamıyor. Invariant spec ile korunuyor.                                                                                                                                                     |

## Ne var / ne eksik — denetim kapsamının kendisi

| Durum           | Alan                                                                                                                                 | Not                                                                                                                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MISSING**     | Billing coupling                                                                                                                     | Examined by nobody, and the coupling does not exist: no plan-tier or subscription check gates any farm-service write. A lapsed tenant retains full production-write capability. See GAP-MEDIUM-011.                                                                                                                           |
| **MISSING**     | Observability (metrics, tracing, Prometheus alerts, SLOs)                                                                            | Zero agent attention. The metrics interceptor is resolver-scoped, so the audit's own CRITICAL defect increments no counter and fires no alert; no cron rows-processed metric exists either. See GAP-HIGH-004.                                                                                                                 |
| **MISSING**     | Performance (N+1, DataLoader coverage, query budgets, load testing)                                                                  | 112 @ResolveField against 6 DataLoaders, one of which loads a table proven to have zero writers. No agent owned latency or throughput. See GAP-MEDIUM-006.                                                                                                                                                                    |
| **MISSING**     | alert-engine coupling (consumer side of farm events)                                                                                 | apps/alert-engine has four live services consuming farm signals, in zero inventories. The unmade link: db-audit proved the low-stock chain is dead upstream while low-stock-alert.service.ts waits downstream for an event that cannot fire.                                                                                  |
| **MISSING**     | aquamobil hand-written GraphQL INPUT types (15 interfaces)                                                                           | The single most consequential blind spot. contract-parity audited result types only; no agent examined input/variable conformance, which is exactly where the CRITICAL water-quality defect lives. See GAP-CRITICAL-001.                                                                                                      |
| **MISSING**     | aquamobil pages never opened (HomePage, 4 operations hubs, schedule, notifications, tank detail, account)                            | ~2,980 lines including AccountPage (777 lines, WebAuthn enrollment) and TankDetailPage (the consumer of the 'dead' tankView entitlement). MySchedulePage carries an unreported UTC-day bug at :23. See GAP-MEDIUM-008.                                                                                                        |
| **MISSING**     | farm-service NATS request-reply responders (7 files, 1 write path)                                                                   | Absent from all twelve inventories. tenantId and createdBy come from the NATS payload; PermissionMatrixGuard skips non-graphql and resolver-scanner walks only `*.resolver.ts`. See GAP-HIGH-002.                                                                                                                             |
| **MISSING**     | farm-service common/jsonb patch service and filters/global-exception.filter                                                          | The shared write primitive for every jsonb column, and the service's global error boundary. Only mentioned by test-runner as 'no spec'; never audited for behaviour.                                                                                                                                                          |
| **MISSING**     | farm-service health / tenant-schema-readiness                                                                                        | The cold-start gate deciding whether a tenant schema is serviceable. No inventory row from any agent, despite ADR-012 schema-drift being a named CLAUDE.md concern.                                                                                                                                                           |
| **MISSING**     | farm-service infrastructure/watchdog-cron                                                                                            | Never opened — which matters because tenant-isolation-auditor's headline finding is that per-tenant crons silently no-op. Whether the watchdog detects that is unknown.                                                                                                                                                       |
| **MISSING**     | farm-service setup contexts (site, department, system, equipment, worker, species, consumable, supplier, chemical)                   | 42 mutations across nine contexts dismissed in one blanket IMPLEMENTED sentence with zero file:line evidence, and the sentence is demonstrably false — 10 `restore*` mutations bypass the CommandBus and emit no event. See GAP-HIGH-003.                                                                                     |
| **MISSING**     | hr-service coupling (attendance, leave, schedule)                                                                                    | Three mobile surfaces with payroll consequences resolve in hr-service; no agent read it. form-write-auditor's clock-in claim is correct — I verified it — but was asserted from the client side alone.                                                                                                                        |
| **MISSING**     | messaging-service and notification-service coupling                                                                                  | Both back live aquamobil surfaces. access-boundary-auditor explicitly recorded messaging ACLs as 'out of this audit's read set'; notification-service appears nowhere.                                                                                                                                                        |
| **PARTIAL**     | Audit process integrity (dedup, ownership, roster)                                                                                   | contract-parity-enforcer's report appears twice verbatim, so the cycle ran eleven distinct lanes, not twelve. One defect (water-quality) carries three top-severity IDs and another (logout wipes queue) carries four at three different severities, which distorts triage and makes a single honest Closes: line impossible. |
| **PARTIAL**     | Compliance / legal hold / GDPR erasure                                                                                               | data-expert covered the outbox-vs-erasure gap. Nobody noted that the legal-hold enforcement gate's only test is a `*.postgres.spec.ts` in the dead test:integration lane. See GAP-HIGH-005.                                                                                                                                   |
| **PARTIAL**     | Security — rate limiting, CSP, input sanitization, secret handling                                                                   | frontend-expert covered CSP (FE-HIGH-002). Rate limiting was noted only incidentally: a global ThrottlerGuard exists and exactly 4 operations carry @Throttle, with no agent assessing whether the unthrottled mutation surface matters.                                                                                      |
| **PARTIAL**     | Test execution evidence                                                                                                              | test-runner correctly declared static-only analysis and produced the most useful structural finding in the cycle (two dead lanes). The other eleven agents made execution-shaped claims — 'baseline is ZERO', 'codegen is NOT stale' — with `node_modules` absent. See GAP-MEDIUM-009.                                        |
| **PARTIAL**     | farm-service mobile-dashboard context                                                                                                | Eight files backing three aquamobil hub pages. Touched only via access-boundary-auditor's tenant-wide-read finding; never inventoried as a context, and its two read handlers were never traced to their consumers.                                                                                                           |
| **PARTIAL**     | sensor coupling                                                                                                                      | db-audit-farm-production verified the SensorTemperatureProjectionListener write path and data-expert covered consumer tenant guards. Not examined: sensor-service's own emission contract, and whether the JSON-schema validator gap at the trust boundary applies to sensor events.                                          |
| **IMPLEMENTED** | Security — authz on GraphQL surface                                                                                                  | access-boundary-auditor did serious work on the role/entitlement matrix and found real defects (auto-provisioning, accessType). Genuine coverage within its GraphQL scope.                                                                                                                                                    |
| **IMPLEMENTED** | aquamobil offline queue, encryption, SW replay, idempotency envelope                                                                 | Three agents converged on the same substrate from different angles (isolation, sync semantics, PWA mechanics) and largely agree. Over-covered relative to the rest of the app.                                                                                                                                                |
| **IMPLEMENTED** | aquamobil write/record forms (mortality, cull, harvest, transfer, feeding, lice, welfare, escape, storage, leave, attendance, tasks) | Excellent field-by-field DTO-to-payload tracing by form-write-auditor, independently corroborated by mobile-app-auditor. Real coverage.                                                                                                                                                                                       |
| **IMPLEMENTED** | farm-service production-biology contexts (batch, growth, harvest, feeding, mortality, tank)                                          | Genuinely deep, evidence-cited coverage from farm-expert plus two db agents with independent read paths. This is the audit's strongest region and the cross-checking between agents is real.                                                                                                                                  |
| **IMPLEMENTED** | farm-service regulatory / compliance assemblers                                                                                      | Covered by farm-expert and db-audit-farm-production; the Mattilsynet/Altinn surface and its provenance chain were read in detail.                                                                                                                                                                                             |
| **IMPLEMENTED** | farm-service storage / feed / finance ledger                                                                                         | db-audit-farm-operations traced the `storage_inventory` \+ `stock_movements` convergence end to end with per-table write→read→UI verdicts. Strong.                                                                                                                                                                            |

## Uzmanların MISSING olarak işaretlediği her şey

Yukarıdaki iki tablo sentezcilerin özeti; aşağısı 12 uzmanın ham `MISSING` satırlarının tamamı.
PARTIAL satırları uzman raporlarının kendi envanter tablolarında.

| Ajan                       | Eksik                                                                       | Not                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db-audit-farm-production` | `batch_locations` (BatchLocation) — residency history                       | Table, entity, indexes, DataLoader, traceability aggregation and a shipped web tab all exist; nothing writes a row. The batch traceability report renders zero residencies and the target-FCR-from-feeding-program chain always short-circuits. See DB-FARMPROD-HIGH-001.                                                                                                                                                             |
| `db-audit-farm-operations` | Low-stock / reorder alert chain                                             | All machinery exists (LowStockDetected outbox enqueue, warehouse KPI, forecast coverage bands) but is gated on minStock `>` 0, and minStock has no editor for feeds or chemicals in any UI. Effectively dead for those two item types.                                                                                                                                                                                                |
| `db-audit-farm-operations` | Purchase order `->` supplier master linkage                                 | `purchase_orders` stores `supplier_name` free text only; the `suppliers/supplier_types/supplier_sites` master has no relationship to any spend document. Supplier spend and approved-vendor enforcement are not queryable.                                                                                                                                                                                                            |
| `db-audit-farm-operations` | Purchase order `->` finance ledger                                          | `purchase_orders.total_amount` is persisted and exposed but is not a `DERIVED_COST_SOURCE`, so procurement spend never appears in the finance tab. Feed cost is consumption-basis from `feeding_records`; chemical/consumable purchases have no representation at all.                                                                                                                                                                |
| `db-audit-farm-operations` | Farm CREATE VIEW migrations                                                 | The shared methodology expects three live farm views. Grep for CREATE [OR REPLACE] [MATERIALIZED] VIEW across the 77 tracked migrations plus the baseline returns zero matches, so the methodology note is stale for the current chain — no VIEW-STALE risk exists in this partition.                                                                                                                                                 |
| `data-expert`              | Inbox (durable consumer dedupe ledger)                                      | `farm.inbox_messages` exists as a table with a (consumerName, tenantId, eventId) unique index and is registered in infrastructureTables, but no entity, repository, or query references it anywhere in the repo. Listeners use volatile Redis setNx instead.                                                                                                                                                                          |
| `data-expert`              | Event DLQ                                                                   | `farm.event_dlq` exists as a table with source/tenantId/eventId/error/failedAt columns and two indexes, and is registered in infrastructureTables, but has zero writers and zero readers.                                                                                                                                                                                                                                             |
| `tenant-isolation-auditor` | NATS consumer envelope↔payload tenant cross-check                          | TenantValidatingConsumer exists and is exported but has zero runtime consumers; IEventHandler.handle() never receives the delivered msg.subject, so the check is not implementable at any consumer. All farm-service listeners trust event.tenantId. See PRODUCT-TENANT-HIGH-002.                                                                                                                                                     |
| `tenant-isolation-auditor` | AquaMobil offline queue identity partitioning                               | No userId dimension on the key or the record; the drain is tenant-only. A session that ends without explicit logout lets the next user of the same tenant replay the prior user's queued escape/mortality/harvest writes under their own JWT. See PRODUCT-TENANT-HIGH-003.                                                                                                                                                            |
| `tenant-isolation-auditor` | AquaMobil session-establishment residue wipe                                | login / loginWithToken / a failed silent restore never clear prior-session local state, so the logout teardown is the only barrier and it is skipped whenever the app is killed or the refresh cookie expires.                                                                                                                                                                                                                        |
| `tenant-isolation-auditor` | Cron / scheduler tenant-isolation tests                                     | No isolation spec covers any cron path. The only scheduler test is minio-orphan-cleanup.spec.ts, and nothing asserts that a per-tenant cron observes exactly its own tenant's rows — which is why PRODUCT-TENANT-HIGH-001 can be inert with a green suite.                                                                                                                                                                            |
| `tenant-isolation-auditor` | FeedingSchedulerService public API (execute/mark/skip/calculate)            | executeFeedingSchedule, updateFeedingStatus, markFeedingCompleted, skipFeeding, calculateFeedAmount, getFeedingSchedules, getUpcomingFeedings and triggerFeedingPlanGeneration have no caller anywhere in apps/ — no controller, resolver or command handler reaches them. Dead surface that still carries the unscoped lookup cited in PRODUCT-TENANT-MEDIUM-005.                                                                    |
| `test-runner`              | farm-service / finance                                                      | Weakest context: 11 of 13 handler classes untested, including every finance query handler (summary, ledger, batch-totals, categories, settings) and all mutation handlers except create/archive. Money aggregation runs with no assertion behind it.                                                                                                                                                                                  |
| `test-runner`              | farm-service / GraphQL resolvers                                            | 46 of 51 resolver classes have no spec, and 45 of the 51 carry @UseGuards — the authorization decorator wiring is therefore almost entirely unasserted. Only 3 `__resolveReference` sites exist (all in farm.resolver.ts) and their cross-tenant behaviour is exercised indirectly via get-farm.handler.spec.ts.                                                                                                                      |
| `test-runner`              | farm-service / ai-insights                                                  | Six source files (ai-insights.service.ts, mcp-client.service.ts, mcp-sdk.port.ts, resolver, module, types) with zero spec files. The MCP client is an outbound third-party boundary with no test at all.                                                                                                                                                                                                                              |
| `test-runner`              | farm-service / tenant-isolation architecture specs                          | tenant-schema-routing.architecture.spec.ts, graphql-loader-tenant-source.architecture.spec.ts and 8 `*.postgres.spec.ts` tenant-isolation suites exist and are well written, but the only target that matches them (test:integration) is invoked by no workflow or script. They are authored, not executed.                                                                                                                           |
| `test-runner`              | farm-service / dead or orphan code                                          | cache/farm-cache.service.ts is a 0-byte file imported by nothing. filters/global-exception.filter.ts (5.6 KB) has no spec. mobile-command/ holds only an entity, but it IS read through MobileCommandReceiptService in daily-feeding-execution.service.ts, so it is not orphaned.                                                                                                                                                     |
| `test-runner`              | Mutation testing \+ test lint rules                                         | No Stryker configuration, dependency or workflow anywhere in the repo, and no eslint-plugin-jest/vitest/testing-library/playwright. The spec-file ESLint override disables no-explicit-any and adds no jest ruleset, so assertion-free tests and 168 `as any` uses in farm-service specs lint clean.                                                                                                                                  |
| `mobile-app-auditor`       | Water quality recording                                                     | Navigable and fully built, but dead: the client sends a `parameters` field the server schema removed, so every submission is rejected at GraphQL input coercion. Online it shows an error banner; offline it shows a green "Measurement Recorded!" over an op that will exhaust its retries. See PRODUCT-MOBILE-CRITICAL-001.                                                                                                         |
| `frontend-expert`          | Offline queue near-full warning UI                                          | `QUEUE_WARNING_THRESHOLD` (180) is exported and documented as driving a warning, but has zero consumers; the user's first signal is a hard throw at 200. See FE-LOW-012.                                                                                                                                                                                                                                                              |
| `frontend-expert`          | Session-epoch cache generation (shared-ui parity)                           | shared-ui appends sessionEpochSegment() and exports createTenantInvalidationKey; the aquamobil mirror has neither while its header claims verbatim parity. Low practical risk (no tenant switcher here), but the false claim is the drift hazard.                                                                                                                                                                                     |
| `frontend-expert`          | Proactive / visibility-driven token refresh                                 | Refresh is purely reactive on a 401. No 80%-TTL timer and no visibilitychange/focus re-check, so a backgrounded tab resuming after throttling takes a 401 round-trip on its first request. shared-ui ships installVisibilityTokenRefresh; aquamobil cannot import it.                                                                                                                                                                 |
| `frontend-expert`          | l10n formatting (Intl)                                                      | No locale/timezone-aware formatting layer; ~20 call sites hardcode 'en-US'/'en-GB' or pass no locale at all, and none pass an explicit timeZone. See FE-MEDIUM-010.                                                                                                                                                                                                                                                                   |
| `frontend-expert`          | shared-ui reuse                                                             | By design aquamobil imports nothing from @aquaculture/shared-ui (standalone lockfile \+ Docker context). Consequence: tenant-query-keys, I18nProvider, the API client / token lifecycle, logout-cleanup, url-allowlist, sanitize-html, the Intl format helpers and the a11y primitives (VisuallyHidden/FocusTrap/RouteAnnouncer) are each either re-implemented locally or absent, and only one copy (i18n) carries any parity guard. |
| `form-write-auditor`       | Water Quality measurement (createWaterQualityMeasurement)                   | BROKEN END TO END. The form ships a `parameters: {}` field the GraphQL input no longer declares, so coercion rejects every submission; the offline branch still renders a green success screen and the queued op then exhausts its retries. Effectively no water-quality capture path from mobile exists today.                                                                                                                       |
| `realtime-sync-auditor`    | Conflict detection when the server row changed (version / etag / merge)     | No queued payload carries an expected version or row timestamp. The receipt ledger only detects a reused clientCommandId with a different payloadHash — it cannot detect that a third party changed the target row. LWW-over-a-supervisor-edit is currently unreachable only because every queued op happens to be an append or an absolute idempotent set; nothing structurally prevents adding an update-style op.                  |
| `realtime-sync-auditor`    | Conflict reconciliation UI (server changed the row while queued)            | A ConflictException on replay is flattened into a generic 'failed' op with a truncated error string; the only operator action is delete. See PRODUCT-SYNC-HIGH-003.                                                                                                                                                                                                                                                                   |
| `realtime-sync-auditor`    | Exponential backoff with jitter                                             | `calculateRetryDelay` is fully written (base 2s, 5min cap, 0-25% jitter) but has zero callers repo-wide. The real cadence is a fixed 30s interval. See PRODUCT-SYNC-HIGH-001.                                                                                                                                                                                                                                                         |
| `realtime-sync-auditor`    | SSE / streaming live surface in AquaMobil                                   | No EventSource, text/event-stream or ReadableStream reader exists anywhere in the app — AI chat and all live surfaces are GraphQL request/response plus Socket.IO. The AI-service SSE endpoint has no mobile consumer, so the stale-prior-session-stream risk class does not apply here.                                                                                                                                              |
| `access-boundary-auditor`  | Tank view / tank detail (tankView flag)                                     | The flag is offered as an admin toggle but consulted nowhere: the /tank/:tankId route is unwrapped, no canAccess/canReach callsite exists, and farmStockInventory carries no entitlement guard.                                                                                                                                                                                                                                       |
| `access-boundary-auditor`  | Mobile entitlement provisioning \+ accessType boundary                      | No fail-closed provisioning: an absent settings row is auto-created all-true on the token-mint read path, and accessType is enforced only by a client-side route redirect. The one server-side compensating control (`deactivate-on-PANEL_ONLY`) is best-effort and swallows failure.                                                                                                                                                 |
| `access-boundary-auditor`  | Impersonation on mobile                                                     | Correctly absent — no impersonation surface, session state or act-as header exists anywhere in aquamobil; the flow remains admin-panel-only. No impersonation state leaks into the mobile session.                                                                                                                                                                                                                                    |
| `contract-parity-enforcer` | aquamobil ↔ farm-service root-field parity invariant                       | farm-graphql-fe-be-parity.spec.ts is hardcoded to web/modules/farm-module/src. aquamobil's only coverage is the path-filtered apollo workflow; there is no always-on PR invariant for the mobile client's root fields.                                                                                                                                                                                                                |
| `contract-parity-enforcer` | farm-module generated GraphQL types / TypedDocumentNodes                    | 342 operations across 45 files with zero generated artifacts. The shell/module operations codegen output was removed from codegen.ts because of unrelated hr-module fragment drift, leaving all 8 remotes hand-typed.                                                                                                                                                                                                                 |
| `contract-parity-enforcer` | Task checklist / notes field contract                                       | Both are GraphQLJSON scalars; the SDL carries no field contract for the item shape, so the client hand-writes ChecklistItem/TaskNote and shape-guesses at runtime. Server-side the fields are optional and repaired only on write.                                                                                                                                                                                                    |
| `contract-parity-enforcer` | tests/invariants/contract-parity.spec.ts (this agent's primary deliverable) | No such file exists. The four axes are covered by four unrelated mechanisms with different trigger conditions (two path-filtered workflows, two jest invariants scoped to farm-module), which is why the suffix hole in PARITY-HIGH-001 has no backstop.                                                                                                                                                                              |

## Çürütülen iddialar

Bağımsız doğrulayıcı kanıtın tutmadığını gösterdi. Bir sonraki döngüde aynı iddia tekrar açılmasın
diye kayıt altında; gerekçeler ilgili raporun "Refuted" bölümünde.

| Açılış ID                       | Açılış sev. | İddia                                                                                                                                                                                                                          | Kaynak                     |
| ------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| ~~`GAP-CRITICAL-001`~~          | CRITICAL    | The GraphQL INPUT/variable axis was audited by nobody — it is exactly where the one CRITICAL defect lives, and 14 more hand-written input types sit on the same ungated path                                                   | `completenessCritique`     |
| ~~`DATA-HIGH-001`~~             | HIGH        | The CLAUDE.md-named schema-routing invariant is stale and currently red — its allowlist omits two entities its own regex flags                                                                                                 | `data-expert`              |
| ~~`DATA-HIGH-002`~~             | HIGH        | Raw operator PII (name/email/phone) in three immutable regulatory events, no crypto-shred key, and GDPR erasure never sweeps `farm.outbox_events`                                                                              | `data-expert`              |
| ~~`DATA-HIGH-003`~~             | HIGH        | Both farm NATS listeners swallow handler errors, so the bus ACKs and the mortality alert \+ harvest traceability follow-ups are lost permanently                                                                               | `data-expert`              |
| ~~`DATA-HIGH-004`~~             | HIGH        | Direct eventBus.publish inside a write transaction with a swallow-catch, in the exact file shape the farm outbox invariant does not scan                                                                                       | `data-expert`              |
| ~~`DB-FARMOPS-HIGH-001`~~       | HIGH        | feeds.minStock / chemicals.minStock have no product write path — the entire low-stock \+ reorder alert chain is unreachable                                                                                                    | `db-audit-farm-operations` |
| ~~`GAP-HIGH-005`~~              | HIGH        | Legal hold and GDPR erasure enforcement is exercised only by specs in the dead test:integration lane — data-expert reported the mechanism as present without noting it is unexecuted                                           | `completenessCritique`     |
| ~~`PARITY-HIGH-002`~~           | HIGH        | aquamobil is exempted from no-bare-graphql-query-string on a factually false premise; ~68 call sites pin hand-written result types and 55 of 122 documents sit outside the codegen glob                                        | `contract-parity-enforcer` |
| ~~`PARITY-HIGH-003`~~           | HIGH        | farm realtime WebSocket event vocabulary is a 41-vs-30 hand-mirrored contract typed as bare `string`, with no parity gate and a spec that asserts unknown events are a silent no-op                                            | `contract-parity-enforcer` |
| ~~`PARITY-HIGH-004`~~           | HIGH        | Task.checklistItems / Task.notes ship as untyped JSON scalars; the client's required `id`/`isCompleted` are optional server-side and are normalised only on WRITE, so a legacy item sends setChecklistItem an undefined itemId | `contract-parity-enforcer` |
| ~~`PRODUCT-TENANT-HIGH-002`~~   | HIGH        | NATS consumers derive tenant from the event body; the subject envelope is structurally unavailable to handlers and TenantValidatingConsumer has zero adoption repo-wide                                                        | `tenant-isolation-auditor` |
| ~~`FARM-MEDIUM-005`~~           | MEDIUM      | Scheduler cron jobs set a session-scoped, string-interpolated `search_path` on pooled connections instead of the transaction-local canonical form                                                                              | `farm-expert`              |
| ~~`GAP-MEDIUM-007`~~            | MEDIUM      | Four of the five backends aquamobil actually calls were never read, yet three agents made behavioral claims about them                                                                                                         | `completenessCritique`     |
| ~~`GAP-MEDIUM-008`~~            | MEDIUM      | Nine aquamobil pages (~2,980 lines) were never opened, including the WebAuthn enrollment half of the accessType bypass the access agent reported                                                                               | `completenessCritique`     |
| ~~`GAP-MEDIUM-010`~~            | MEDIUM      | farm-service infrastructure and cross-cutting directories got no inventory row from any agent                                                                                                                                  | `completenessCritique`     |
| ~~`GAP-MEDIUM-011`~~            | MEDIUM      | Billing coupling was never examined and does not exist: farm-service has no subscription or plan-tier gate on any write path                                                                                                   | `completenessCritique`     |
| ~~`PARITY-MEDIUM-008`~~         | MEDIUM      | A codegen output was deleted and a client field-selection reduced, each justified by a tracked finding ID (S1-ORPHAN, S1-ORPHAN-LEAVE-TYPE) that exists nowhere in the repo                                                    | `contract-parity-enforcer` |
| ~~`PRODUCT-MOBILE-MEDIUM-006`~~ | MEDIUM      | Regulatory incident records filed offline permanently lose their evidence photos — capture is hard-disabled without connectivity                                                                                               | `mobile-app-auditor`       |
| ~~`PRODUCT-TENANT-MEDIUM-004`~~ | MEDIUM      | farm-service @Cacheable / @CacheEvict derive the Redis key's tenant segment from the raw x-tenant-id header instead of the JWT/guard-validated tenant                                                                          | `tenant-isolation-auditor` |
| ~~`GAP-LOW-012`~~               | LOW         | Three agents each filed the same water-quality defect as a top finding, inflating the apparent finding count and splitting ownership of one root cause                                                                         | `completenessCritique`     |
| ~~`SYNTH-LOW-003`~~             | LOW         | PRODUCT-TENANT-HIGH-001'in blast radius listesi MinIO-orphan cron'unu hatalı kapsıyor                                                                                                                                          | `farmSynthesis`            |

## Süreç bulgusu — bulgu kayıt defteri prefix draması

### PROC-MEDIUM-016

**Title:** `output-format.md`'nin tanımladığı finding prefix'lerinin çoğu registry şemasınca
reddediliyor; koca ajan lane'leri hiçbir bulgu kaydedemiyor

**Severity:** MEDIUM · **Layer:** 3 · **State:** OPEN · **Kaynak:** bu döngünün kendi kurulumu

**Evidence:**

- `.claude/shared/output-format.md` — `TEST-*` (test-runner), `DB-{AREA}-*` (Lane-D
  db-audit), `GSEC-*` (security-reviewer) ve `PRODUCT-{AGENT-PREFIX}-*` (Lane-B) prefix'lerini
  tanımlar.
- `docs/reviews/_registry/findings.jsonl.schema.json` — `id` pattern
  alternasyonu
  — gibi
  alt-prefix'ler pattern'e uymuyor.

  ```text
  (DATA|SEC|PLAT|FE|EDGE|MT|FARM|SENSOR|HR|MSG|ADMIN|ANTI|ADR|AUDIT|CTX|INFRA|PROC|P0|COMPLIANCE|PERF|OBS|SUPPLY|CONTRACT|CIRCUIT|MEM|CLAUDE|BILLING|ALERT|LEGAL|AUDITTRAIL|TENANTCOST|AISAFETY|PRODUCT|DEPLOY|RUST|ULTRA|ORPHAN|RBAC|MOB)
  ```

  ```text
  TEST` yok, `DB-*` yok, `GSEC` yok; `PRODUCT` yalnız çıplak haliyle var, `PRODUCT-MOBILE-*
  ```

- `docs/reviews/_registry/findings.jsonl` — 1.375 satırın
  hiçbirinde `TEST-*`, `DB-*` veya `PRODUCT-*` girdisi yok. Bu lane'ler bugüne kadar tek bir bulgu
  bile kaydedememiş.
- Bu döngünün somut sonucu: 12 uzmandan 8'inin
  bulguları
  (`db-audit-farm-production`,
  `db-audit-farm-operations`,
  `tenant-isolation-auditor`,
  `test-runner`,
  `mobile-app-auditor`,
  `form-write-auditor`,
  `realtime-sync-auditor`,
  `access-boundary-auditor`, `contract-parity-enforcer`) `npm run findings:add` ile kaydedilemez.

**Rule violated:**

CLAUDE.md → `*Review` Finding Traceability (`MANDATORY)*`: "Every fix commit must reference the
finding it closes, else `docs/reviews/` becomes audit theater." Kaydedilemeyen bir bulgu referans da
edilemez; kural bu lane'ler için yapısal olarak uygulanamaz durumda.

**Proposed fix direction:**

- Tier 1 (make it impossible): prefix listesini tek bir SSoT'ye indir — şema
  regex'i `output-format.md`'deki tablodan üretilsin, iki liste ayrı ayrı elle bakımlanmasın.
- Tier 3 (make it detectable): `tests/invariants/` altına, her ajan dosyasının ilan ettiği
  finding-id prefix'inin registry şemasınca kabul edildiğini doğrulayan bir invariant ekle. Bu spec
  bugün kırmızı açardı ve sorunu ilk ajan eklendiğinde yakalardı.

**Affected surface (ripple set):**

- `.claude/shared/output-format.md`
- `docs/reviews/_registry/findings.jsonl.schema.json`
- `tools/gates/finding-registry.ts`
- `tests/invariants/`

## Kayıt defteri durumu

Bu döngünün bulguları `docs/reviews/_registry/findings.jsonl`'e **yazılmadı**. Defter append-only ve
hash-chained; 131 girdilik bir append geri alınamaz bir işlem ve insan onayı gerektirir. Registry'ye
uygun prefix'li bulgular (`FARM`, `DATA`, `FE`, `MOB`, `CTX`, `PROC`) çakışma olmasın diye mevcut
high-water işaretlerinin üstünden numaralandı: FARM ≥ 300, DATA ≥ 011, FE ≥ 064, MOB ≥ 018, CTX ≥
001, PROC ≥ 016. Kalanlar `PROC-MEDIUM-016` yüzünden zaten kaydedilemez.

## Verdict

**BLOCK.** Doğrulamadan geçen üç CRITICAL üretim akışını kesiyor:

1. Mobil su kalitesi ölçümü sunucu tarafından **her seferinde**
   reddediliyor (`PRODUCT-MOBILE-CRITICAL-001` / `PRODUCT-FORM-CRITICAL-001` — iki ajan bağımsız
   buldu), offline yol ise yeşil onay ekranı gösteriyor.
2. Presigned MinIO URL'leri iç ağ host'una üretiliyor ve MinIO droplet topolojisinde dışarıya hiç
   açılmıyor (`MOB-CRITICAL-018`) — tüm medya hattı üretimde ölü.

Hiçbiri tek satırlık bir yanlışlık değil; ikisi aynı sınıftan: **el yazımı bir aynanın sunucu
sözleşmesinden sessizce ayrışması**. Completeness critic bu sınıfın denetlenmemiş ekseni olduğunu
ayrıca işaretlemişti.

Aynı sınıfın üçüncü örneği doğrulama sırasında ortaya
çıktı: `PARITY-HIGH-010`, `contract-parity-enforcer` tarafından LOW bir tip-hijyeni notu olarak
açılmıştı; doğrulayıcı tiplerin değil değerlerin peşine düşünce depo hub'ının hareket akışının
küçük/büyük harf uyuşmazlığı yüzünden render sırasında çöktüğünü buldu ve HIGH'a yükseltti.
Denetimin tek yukarı yönlü düzeltmesi bu.

## References

- `.claude/shared/output-format.md` — bulgu formatı sözleşmesi
- `.claude/shared/orchestrator-routing-table.md` — lane yönlendirmesi
- `CLAUDE.md` — kural SSoT
- `docs/reviews/_registry/README.md` — bulgu kayıt defteri
