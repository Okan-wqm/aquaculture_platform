# Farm Module — Enterprise "Steel-Grade" Hardening Plan

> **Status:** APPROVED — implementation in progress
> **Date:** 2026-06-13
> **Scope:** `apps/farm-service/**` + `web/modules/farm-module/**` (+ the `web/apps/aquamobil` water-quality twin, `libs/backend-common` tenant/crypto primitives, `@platform/storage` cleanup primitive)
> **Owner:** Okan (platform owner)
> **Method:** 8 specialist read-only audit agents → dynamic multi-agent workflow that adversarially re-verified every CRITICAL against live code → dependency-ordered roadmap. All fixes are **root-cause architectural only** (CLAUDE.md tier hierarchy: T1 make-impossible > T2 make-automatic > T3 make-detectable > T4 document). **No patches, no `?.` shims, no `as any`, no deferrals.**

---

## Context — why this work exists

The farm module is the flagship tenant-facing domain (batch lifecycle, feeding, harvest, water quality, equipment, storage, regulatory, satellite). The goal is to make it **enterprise-grade for multi-tenant SaaS**: correct end-to-end (UI → API → tenant DB → read-back), tenant-isolated, RS256-anchored, SSoT-disciplined, performant, secure, and self-defending against regression via CI invariants.

A two-stage audit was run:
1. **8 specialist agents** (farm-expert, multi-tenant-saas-expert, auth-security-expert, data-expert, database-reviewer, performance-expert, frontend-expert, tenant-isolation-auditor) produced independent end-to-end reports.
2. A **dynamic workflow** then dispatched 11 adversarial verifiers (one per CRITICAL) that re-read the cited code to **falsify** each claim, plus a synthesizer that deduplicated cross-domain findings into root-cause clusters and a dependency-ordered roadmap.

Adversarial verification changed two severities (proving the value of self-verification):
- **CACHE-TENANT: CRITICAL → MEDIUM.** The "cross-tenant cache bleed" claim is a **false positive on the live path**: the gateway sets the outbound `x-tenant-id` from the same `req.user.tenantId` JWT claim that `@Tenant` scopes by, and `StripInternalHeadersMiddleware` (registered first) deletes any forged header lacking a valid v2 service-identity HMAC. The real defect is a **duplicated tenant source-of-truth** + silent cache bypass when the header is absent (correctness/maintainability, not data exposure).
- **MV-LOST: CRITICAL → MEDIUM; DEAD-LISTENERS: CRITICAL → HIGH.** The dead `@OnEvent` listeners' work-order-generation path is redundantly covered by a direct cron call; the genuinely lost behaviors are mortality alerts + harvest follow-ups.

The result: **3 true CRITICAL (active data-loss / cross-tenant exposure)** lead the plan; everything else is sequenced behind them by dependency.

---

## Verified finding registry

Finding IDs are used in commit `Closes:` lines (`Closes: docs/plans/2026-06-13-farm-module-enterprise-hardening.md#<id>`).

| ID | Sev | Confirmed | Tier | Root cause (one line) |
|---|---|---|---|---|
| `orphan-cleanup` | **CRITICAL** | ✅ | T1 | Nightly MinIO cleanup runs with no tenant context → DB live-set reads empty source schema while the delete scans the whole shared bucket → deletes every tenant's objects >24h old. |
| `fe-sensor-fake` | **CRITICAL** | ✅ | T1 | Federation-exposed `/sites/sensors` renders `Math.random()` mock telemetry as live water quality; real sensor pipeline already exists in sensor-module. |
| `fe-reports-mock` | **CRITICAL** | ✅ | T1 | Entire regulatory compliance dashboard (summary, overdue/penalty banner, deadlines, 7/8 tab histories) is mock-backed and ships unconditionally in prod. |
| `fe-immediate-reports` | HIGH→**CRITICAL** truth | ✅ | T3 | Welfare/Escape/Disease (legally-immediate Mattilsynet reports) `console.log` the payload + fake-success; **no submission path at any layer**. |
| `sentinel-cbc` | HIGH | ✅ | T1 | Bespoke unauthenticated AES-256-CBC for Sentinel + regulatory secrets instead of canonical GCM column transformer (malleability/padding-oracle class). |
| `pii-at-rest` | HIGH | ✅ | T1 | `farm_workers` email/firstName/lastName/dob plaintext at rest; secrets encrypted imperatively per-callsite, not via declarative transformer. NB: `email` is unique-indexed → needs deterministic/HMAC-lookup design, not naive GCM. |
| `fe-mru-leak` | HIGH | ✅ | T2 | `wq-mru-equipment` localStorage key not tenant-scoped → equipment UUIDs leak across tenants on shared browser; survives logout. AquaMobil twin `aquamobil-wq-mru`. |
| `fe-draft-pii-persist` | HIGH | ✅ | T2 | `regulatory_report_draft_*` (with contact PII) not tenant-scoped, survives logout/tenant-switch. |
| `dead-listeners` | HIGH | ✅ | T1 | `events/listeners/**` subscribe via in-process `@OnEvent`; handlers emit only via outbox→NATS → mortality alerts + harvest follow-ups never fire. |
| `close-batch-enum` | HIGH | ✅ | T2 | FE offers 7 `BatchCloseReason` values; backend enum exposes 5 → 4 selections fail GraphQL validation; FE/BE enum drift, no codegen binding. |
| `po-approval` | HIGH | ✅ | T1 | PurchaseOrder has no SUBMITTED/APPROVED state or maker-checker; `approvedBy` column vestigial; one MODULE_MANAGER does create→order→receive. InventoryCount (same module) is the correct SOC2 reference. |
| `biomass-ssot` | HIGH | ✅ | T1 | `weight.actual.totalBiomass` never decremented on mortality/cull/harvest → diverges from `TankBatch.totalBiomassKg`; corrupts density/FCR/finalBiomass. |
| `growth-nolock` | HIGH | ✅ | T1 | `record-growth-sample` reads batch outside the lock → concurrent samples re-inflate biomass. |
| `feed-empty` | HIGH | ✅ | T1 | Feeding gates only on `isActive`, not operational state → feeding an empty batch corrupts FCR. |
| `feed-dual-ssot` | HIGH | ✅ | T1/T2 | `FeedInventory` and `StorageInventory`/`StockMovement` both own feed stock; storage-deduction failure swallowed. |
| `wq-legacy-bypass` | HIGH | ✅ | T1 | Legacy fixed-column WQ params bypass tenant-config validation + equipment-mapping check (dual parameter SSoT). |
| `gql-codegen` | HIGH | ✅ | T2 | FE GraphQL ops are inline template strings; no codegen binding → enum/required-arg/field drift invisible. Root of close-batch-enum, harvest-harvestedby, harvest-planid. |
| `harvest-harvestedby` | HIGH | ✅ | T2 | `createHarvestRecord` requires non-null `harvestedBy` the FE never sends → harvest mutation fails; server should derive from `user.sub`. |
| `harvest-planid` | HIGH | ✅ | T2 | Handler reads `input.harvestPlanId` but DTO+FE omit it → harvest-plan gate can never receive a plan. |
| `arch-spec-conflict` | HIGH | ✅ | T3 | `tenant-schema-routing.architecture.spec` allowlist omits `farm_audit_logs` + `tenant_erasure_audit` (both correctly schema-pinned) → spec silently red/skipped. |
| `ondelete-drift` | HIGH | ✅ | T3 | Entities declare `onDelete: CASCADE` while DB enforces RESTRICT on every batch-child FK (lost in baseline reset). |
| `no-check-constraints` | HIGH | ✅ | T3 | Only 1 CHECK across 67 tables; non-negative quantity/biomass + bounded-month invariants are app-only. |
| `timestamp-notz` | HIGH | ✅ | T2 | `farm_workers`/`farms`/`ponds` audit columns are `TIMESTAMP` (no tz) — lost in baseline reset. |
| `wq-unique-lost` | HIGH | ✅ | T2 | Partial-unique on `water_quality_measurements.relatedSensorReadingId` lost → duplicate WQ rows on event replay. |
| `decimal-transformer` | MED | ✅ | T2 | Legacy `farms.totalArea` + `ponds.capacity/depth/surfaceArea` lack `DecimalTransformer` → NUMERIC returned as string to GraphQL Float. |
| `mv-lost` | MED | ✅ | T3 | Daily-rollup MVs archived in baseline reset; refresh cron still names them (error swallowed); stats compute runtime AVG over raw rows. |
| `cache-tenant` | MED | ⚠️ FP downgraded | T2 | Cache interceptors re-derive tenant from raw `x-tenant-id` instead of the trusted extractor; silent bypass when absent (no live bleed). |
| `jsonb-source-schema` | HIGH | (audit) | T1 | `JsonbPatchService` schema-qualifies per-tenant `batches_v2` to source `farm` schema → writes silently target empty source table. |
| `feed-reminder-tenant` | HIGH | (audit) | T1 | `FeedingReminderEventPayload` omits `tenantId` → `notification.send` fan-out with `tenantId: undefined`. |
| `wq-not-hypertable` | HIGH | (audit) | T1 | `water_quality_measurements` is plain OLTP, not a TimescaleDB hypertable; no continuous aggregate / `drop_chunks` retention. |
| `workorder-jsonb-idx` | HIGH | (audit) | T1 | `work_orders.relatedAsset->>'batchId'` JSONB filter unindexed → seq scan on hot `batchPerformance` path. |
| `equip-list-js` | HIGH | (audit) | T1 | `ListEquipmentHandler` loads `page*limit` rows from two tables, merges/sorts/dedups in JS, wrong total. |
| `no-stampede` | HIGH | (audit) | T2 | No Redis single-flight; AI-insight/cost recompute thunders on TTL expiry (`setNx` exists, unused). |
| `global-auth-guard` | MED | (audit) | T2 | No global JWT auth guard at subgraph; protection depends on production-only middleware ordering. |
| `no-plan-quota` | HIGH | (audit) | T1 | Zero plan-tier/quota enforcement in farm; gateway `maxFarms/maxPonds` advertised but dead + reference deprecated hierarchy. |
| `gdpr-subject-erasure` | HIGH | (audit) | T2 | No per-data-subject Art.17 erasure for worker PII (only tenant-wide). |
| `pii-plaintext-log` | HIGH | (audit) | T1/T2 | Worker PII logged via string interpolation in `create-worker.handler`. |
| `fe-role-gating` | MED | (audit) | T3 | `useCanMutate` applied inconsistently; many destructive mutation surfaces ungated client-side. |
| `fe-eager-imports` | MED | (audit) | T1 | farm-module 100% eager imports; recharts/lucide bundled per-remote; no bundle budget. |
| `fe-upload-bypass` | HIGH | (audit) | T2 | `useFileUpload` raw `fetch` bypasses central client (no CSRF, no refresh-on-401, stale-token capture). |
| `cron-fairness` | MED | (audit) | T2 | All farm crons iterate tenants strictly serially; no concurrency cap / per-tenant timeout / rotation. |

---

## Root-cause clusters

The 40 findings collapse into **16 root-cause clusters**. Fixing the cluster root, not the symptom, is the architectural mandate:

1. **Cron scope/context discipline** — crons run outside tenant context; DB scope ≠ side-effect scope (`orphan-cleanup`, `cron-fairness`, `feed-reminder-tenant`).
2. **Two unbridged event buses** — in-process `@OnEvent` vs NATS/outbox SSoT (`dead-listeners`).
3. **FE/BE GraphQL contract drift** — inline ops, no codegen (`gql-codegen` → `close-batch-enum`, `harvest-harvestedby`, `harvest-planid`).
4. **Bespoke crypto vs canonical transformer** (`sentinel-cbc`, `pii-at-rest`).
5. **Tenant-context source-of-truth discipline** (`cache-tenant`, `jsonb-source-schema`, `feed-reminder-tenant`).
6. **Per-tenant browser storage not tenant-scoped** (`fe-mru-leak`, `fe-draft-pii-persist`).
7. **Mock data rendered as live** (`fe-sensor-fake`, `fe-reports-mock`).
8. **Silent-discard submit placeholders** (`fe-immediate-reports`).
9. **Biomass / feed stock SSoT integrity** (`biomass-ssot`, `growth-nolock`, `feed-empty`, `feed-dual-ssot`).
10. **WQ parameter model integrity** (`wq-legacy-bypass`).
11. **PII protection: erasure / at-rest / log masking** (`pii-plaintext-log`, `pii-at-rest`, `gdpr-subject-erasure`).
12. **Data-layer forward-migration wave** (`arch-spec-conflict`, `ondelete-drift`, `no-check-constraints`, `timestamp-notz`, `wq-unique-lost`, `decimal-transformer`, `mv-lost`).
13. **Read-side performance / time-series modeling** (`wq-not-hypertable`, `workorder-jsonb-idx`, `equip-list-js`, `no-stampede`).
14. **Purchase-order financial-commitment control** (`po-approval`).
15. **Auth enforcement consistency** (`global-auth-guard`, `fe-role-gating`).
16. **Frontend delivery hygiene** (`fe-eager-imports`, `fe-upload-bypass`); **plan-tier quota** (`no-plan-quota`).

---

## Dependency-ordered roadmap

Each phase ships its regression tests in the same PR (CLAUDE.md). `nx affected --target=test && nx affected --target=lint` green before every commit.

### Phase 0 — Stop active data-loss & cross-tenant exposure `[risk: high]`
**Findings:** `orphan-cleanup`, `sentinel-cbc`, `pii-at-rest`, `fe-mru-leak`, `fe-draft-pii-persist`
**Goal:** Neutralize the nightly cross-tenant MinIO destruction and the live secret/PII-exposure CRITICALs before any refactor touches surrounding code.
**Key changes:**
- `cron-jobs.service.ts#minioOrphanCleanup`: enumerate tenant schemas (`listTenantSchemas`) and run `FarmOrphanCleanupService.run()` **inside each tenant context** (`withTenantContext`) with `prefix=\`${tenantId}/\`` so DB live-set scope and bucket delete scope are **structurally identical** (T1). [**DONE**]
- `@platform/storage` `StorageOrphanCleanupService.cleanup()`: structural guard — refuse to delete when `livePaths.size===0` over a non-empty scan unless `allowEmptyLiveSet` (T1, prefix-agnostic). [**DONE**]
- Delete bespoke CBC from `sentinel-hub.service.ts` + `regulatory-settings.service.ts`; attach `createEncryptedColumnTransformer` to the `@Column`s. Attach it to `farm_workers` name/dob/JSONB columns. `email` needs deterministic/HMAC-lookup design (unique-indexed). Ship CBC→GCM re-encryption migration **in the same PR** (`iv:ct` ciphertext has no `enc:` prefix → unreadable by GCM).
- Tenant-scope `wq-mru-equipment` and `regulatory_report_draft_*` via a shared `useTenantScopedStorage(baseKey)` (the one sanctioned accessor); apply to AquaMobil `aquamobil-wq-mru`.
**Exit:** orphan-cleanup with no request context deletes nothing; per-tenant runs confine to that prefix. No `aes-256-cbc`/raw `createCipheriv` in farm-service outside the security lib. No farm-module/aquamobil per-tenant key lacks a tenant suffix.

### Phase 1 — Restore broken follow-ups & silent-discard submissions `[risk: medium]`
**Findings:** `dead-listeners`, `fe-immediate-reports`
Migrate `mortality-recorded`/`harvest-completed` listeners off `@OnEvent` onto `eventBus.subscribeWildcard(...)` in `onModuleInit`; remap payloads to `@platform/event-contracts`. Build the missing welfare/escape/disease full-stack submission pipeline; remove `console.log` placeholders; close modal only on `ReportSubmissionResult.success`.

### Phase 2 — Domain SSoT & workflow integrity `[risk: high]`
**Findings:** `biomass-ssot`, `growth-nolock`, `feed-empty`, `feed-dual-ssot`, `wq-legacy-bypass`, `po-approval`
Derive batch biomass on read; lock growth-sample reads; gate feeding on operational state; collapse feed stock to one SSoT; route legacy WQ params through the configurable validation+mapping; PO maker-checker (SUBMITTED/APPROVED, approver≠creator, gate receive on APPROVED).

### Phase 3 — Data-layer forward-migration wave `[risk: high]`
**Findings:** `arch-spec-conflict` (**first**), `ondelete-drift`, `no-check-constraints`, `timestamp-notz`, `wq-unique-lost`, `decimal-transformer`, `mv-lost`
Fix the architecture allowlist spec first; reconcile entity `onDelete` ↔ DB FK; add CHECK constraints; `DecimalTransformer` on legacy decimals; restore WQ partial-unique; TIMESTAMP→TIMESTAMPTZ; regenerate the two MVs as new forward-only `FARM_MIGRATIONS` with CONCURRENT-refresh unique indexes. **Never un-archive/hand-edit migrations.**

### Phase 4 — Tenant-context discipline + cache + read-side performance `[risk: medium]`
**Findings:** `cache-tenant`, `jsonb-source-schema`, `feed-reminder-tenant`, `no-stampede`, `wq-not-hypertable`, `workorder-jsonb-idx`, `equip-list-js`
Export `extractTenantIdSafe`; both cache interceptors use it. `JsonbPatchService` stops source-schema qualifying. Add `tenantId` to `FeedingReminderEventPayload`. Redis single-flight via `setNx`. WQ → hypertable + continuous aggregate + retention. GIN/expression index on `work_orders` batchId; rewrite equipment list as one SQL UNION+LIMIT. **Read-side stats acceleration (revised by `mv-lost`/FARM-MEDIUM-058):** the daily-rollup MVs the original plan assumed never existed — their creators were archived in the baseline reset and the source-schema MV shape was architecturally wrong for the per-tenant model (`TenantSchemaSyncService` clones only base tables, never MVs), so Phase 3 already removed the lying refresh cron and the stats read paths correctly raw-aggregate today. Phase 4 therefore **builds** a tenant-correct acceleration (TimescaleDB continuous aggregate under `wq-not-hypertable`, propagated by the per-tenant sync) rather than repointing at non-existent MVs — and adds no new MV-refresh cron without a tenant-correct MV behind it.

### Phase 5 — Frontend truth, GraphQL codegen, broken-workflow contracts `[risk: medium]`
**Findings:** `fe-sensor-fake`, `fe-reports-mock`, `gql-codegen`, `close-batch-enum`, `harvest-harvestedby`, `harvest-planid`, `fe-role-gating`, `fe-eager-imports`, `fe-upload-bypass`
Bind SensorDashboard to real source (or retire → sensor-module). Remove `pages/reports/mock` from prod graph; add real read resolvers + hooks. Adopt GraphQL codegen → `TypedDocumentNode`; derive `BatchCloseReason` from SDL + exhaustive `Record`. Expand backend close-reason vocabulary + handler/migration mapping. Server-derive `harvestedBy`; add `harvestPlanId` to DTO+FE. `useCanMutate` on all destructive surfaces. `React.lazy` routes + MF singletons + bundle budget. Uploads → central client.

### Phase 6 — Authorization defaults, plan/quota, compliance, invariant hardening `[risk: medium]`
**Findings:** `global-auth-guard`, `no-plan-quota`, `gdpr-subject-erasure`, `pii-plaintext-log`, `cron-fairness`
Global subgraph JWT guard. Enforce plan quotas against billing SSoT. Per-subject Art.17 erasure (crypto-shred + tombstone + `tenant_erasure_audit`). Remove plaintext PII logging → `maskPii`. Per-tenant cron concurrency cap + timeout + rotation. Land + ratify all CI invariants below.

---

## CI invariants to add (make-it-detectable — prevent whole classes from recurring)

Extend existing scaffolding (`cache-key-tenant-scope`, `farm-graphql-fe-be-parity`, `event-contract-emit-has-interface`, `entity-diff-implies-migration`, `dead-contract-fe-operations`, `no-query-param-tenant`, `tenant-schema-routing.architecture`):

1. `@OnEvent`-without-emitter ban.
2. no-mock-data-in-render (literal reading arrays / `Math.random()` on Dashboard/telemetry surfaces).
3. no-mock-helper-import-in-prod (ban `pages/reports/mock` outside `__tests__`).
4. tenant-prefixed-localStorage (only `useTenantScopedStorage`).
5. no-raw-fetch-in-farm-module.
6. x-tenant-id-header-read-ban outside sanctioned middleware/extractor.
7. FE-GraphQL enum/required-arg parity (codegen-derived).
8. no-mv-refresh-cron-without-mv-migration: a `REFRESH MATERIALIZED VIEW` (or a cron named for one) must have a live migration that CREATEs that view AND, for per-tenant services, a `TenantSchemaSyncService` propagation path — closes the `mv-lost`/FARM-MEDIUM-058 class (a cron silently refreshing a non-existent, never-cloned MV).
9. entity-onDelete ↔ DB FK parity.
10. no-bespoke-crypto-in-services (ban `aes-256-cbc`/raw `createCipheriv` outside the security lib).
11. architecture-spec-allowlist-completeness.
12. no-orphan-bucket-delete (empty live-set + whole-bucket scan ⇒ never delete). [**DONE** — `StorageOrphanCleanupService` guard + specs]
13. FE mutation surfaces role-gated.

---

## Hard sequencing constraints

1. `arch-spec-conflict` (Phase 3, first) precedes every entity `schema:`/`onDelete` change.
2. Hypertable/index migrations (Phase 3) land before Phase 4 builds the continuous-aggregate read model. (The Phase-3 *MV* assumption was retired by `mv-lost`/FARM-MEDIUM-058 — the orphaned MVs never existed; Phase 4 builds a tenant-correct aggregate, it does not repoint at MVs.)
3. `cache-tenant` precedes `no-stampede`.
4. `gql-codegen` precedes/accompanies the enum/required-arg fixes.
5. `biomass-ssot` (Phase 2) settles before Phase 4's MV read-model computes from it.
6. CBC→GCM + worker-PII re-encryption (Phase 0) ships before Phase 3 DDL touches those tables.
7. Phase 0's per-tenant cron rework is the foundation `cron-fairness` (Phase 6) builds on.

---

## Verification (end-to-end)

- **Per phase:** `nx affected --target=test --target=lint` + the phase's new regression tests, all green before commit.
- **Phase 0 integration:** seed two tenants' MinIO objects, run cleanup with no context → assert cross-tenant survival; run per-tenant → assert only that prefix deleted. CBC→GCM migration verified reversible on a DB copy.
- **Full type-check:** `npm run type-check`. **Build gate:** `nx affected --target=build`.
- Each fix commit references its finding ID via `Closes:`.

## Known environment caveats (this repo)

- **Concurrent sessions share this working directory** (see memory `project_parallel_sessions.md`). A parallel session may move `HEAD` and can destroy *uncommitted* work. Commit early; re-attach the feature branch after a hijack; never rely on staged-but-uncommitted files surviving.
- **Pre-existing red:** `apps/farm-service/src/batch/__tests__/handlers/record-mortality.handler.spec.ts` fails 8/8 on the base commit (verified by stash test 2026-06-13), unrelated to this work. Tracked separately; do not attribute to Phase-0 changes.

## Working agreements (operator-confirmed)

- Root-cause architectural only — **no patches, no interim, no deferral**. Highest applicable tier always.
- Every change ships with tests proving the fix + no regression.
- No duplication — reuse existing primitives (`createEncryptedColumnTransformer`, `withTenantContext`, `extractTenantIdSafe`, `subscribeWildcard`, `useTenantScopedStorage`, codegen).
- Affected callers updated in the same batch (no breakage left behind).
- Feature-branch → PR → CODEOWNERS merge. Commit freely; **ask before `git push`**.

---

## Finding registry cross-reference (three-store anchor)

Each plan cluster is tracked as a registry finding (`docs/reviews/_registry/findings.jsonl`) whose `review_file` is THIS document. The verbatim ids below satisfy the three-store invariant (every finding's review_file cites its id) and let readers cross-reference a commit's `Closes:` trailer to the cluster it closed.

| Finding id | Phase | Plan cluster / key |
|---|---|---|
| `FARM-CRITICAL-001` | 0 | `orphan-cleanup` — nightly MinIO cron, no tenant context (cross-tenant deletion) |
| `FARM-HIGH-008` | 0 | `fe-mru-leak` — WQ MRU localStorage not tenant-scoped |
| `FARM-HIGH-009` | 0 | `fe-draft-pii-persist` — regulatory report drafts (PII) not tenant-scoped |
| `FARM-HIGH-010` | 0 | `sentinel-cbc` — Sentinel Hub + Maskinporten secrets bespoke CBC → GCM transformer |
| `FARM-HIGH-011` | 0 | `pii-at-rest` — `farm_workers` PII encryption at rest + email blind index |
| `FARM-HIGH-012` | 1 | `dead-listeners` — mortality/harvest `@OnEvent` never fired → subscribeWildcard (cross-service) |
| `FARM-HIGH-013` | 1 | `fe-immediate-reports` — welfare/escape/disease varsling pipeline (no more console.log + fake success) |
| `FARM-HIGH-014` | 2 | `biomass-ssot` — derive-on-read biomass (closes FARM-HIGH-007 + FARM-MEDIUM-003) |
| `FARM-HIGH-015` | 2 | `growth-nolock` — growth-sample reads/writes the locked in-tx batch |
| `FARM-HIGH-016` | 2 | `wq-legacy-bypass` — single validated WQ parameter ingress + aquamobil offline forward-compat |
| `FARM-HIGH-017` | 2 | `po-approval` — PurchaseOrder SUBMITTED/APPROVED maker-checker (SOC2 CC3.4) |
| `FARM-HIGH-058` | 2 | `feed-dual-ssot` (Phase A) — in-tx fail-aware storage deduction; kill swallowed divergence |
| `FARM-HIGH-059` | 2 | `feed-empty` — `assertFeedable` gate on the locked batch in both feeding paths |
| `FARM-HIGH-060` | 3 | `arch-spec-conflict` — `tenant-schema-routing.architecture.spec.ts` allowlist SSoT-derived from `MODULE_SCHEMAS.infrastructureTables` (was a stale hardcoded list) |
| `FARM-HIGH-061` | 3 | `timestamp-notz` — `farm_workers`/`farms`/`ponds` created/updated → `TIMESTAMPTZ` (entity pins + migration `1801300000000`) |
| `FARM-HIGH-062` | 3 | `wq-unique-lost` — restore partial-unique `water_quality_measurements(tenantId, relatedSensorReadingId) WHERE NOT NULL` (migration `1801400000000`) |
| `FARM-HIGH-063` | 3 | `no-check-constraints` — 39 operational CHECK constraints + entity `@Check` parity (migration `1801500000000`) |
| `FARM-HIGH-064` | 3 | `ondelete-drift` — 6 batch-child FKs entity `onDelete: 'RESTRICT'` ↔ DB parity (regen-stable, data-safe) |
| `FARM-MEDIUM-057` | 3 | `decimal-transformer` — Farm/Pond NUMERIC columns attach `DecimalTransformer` (entity-only, no migration) |
| `FARM-MEDIUM-058` | 3 | `mv-lost` — remove the orphaned-MV refresh cron (silent nightly no-op refreshing non-existent MVs); read paths already raw-aggregate correct numbers; perf acceleration folded into Phase 4 `wq-not-hypertable` |
| `FARM-HIGH-065` | 4 | `jsonb-source-schema` — `JsonbPatchService` stops schema-qualifying the per-tenant `batches_v2` (dropped the `schema` field so search_path routes the UPDATE into `tenant_<uuid>`; was a latent silent no-op against the empty source table) |
| `FARM-HIGH-066` | 4 | `feed-reminder-tenant` — `tenantId` added to `FeedingReminderEventPayload` + consumed in the `notification.send` fan-out (was hardcoded `undefined`). Sibling dead-bus tracked as `ORPHAN-HIGH-122` |
| `FARM-MEDIUM-059` | 4 | `cache-tenant` — both cache interceptors key off the exported trusted `extractTenantIdSafe` SSoT, never the raw `x-tenant-id` header; arch invariant extended to `common/cache/**` |

Deferred / superseded references: `FARM-HIGH-007` + `FARM-MEDIUM-003` are closed by `FARM-HIGH-014`; `FARM-MEDIUM-002` is superseded (see `ORPHAN-MEDIUM-112`); feed-dual Phase B convergence is tracked as `ORPHAN-HIGH-114`.
