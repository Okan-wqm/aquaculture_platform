# SSOT Architecture Audit — Whole-Repo, Code-Grounded

- **Date:** 2026-06-23
- **Scope:** Entire monorepo (`apps/`, `libs/`, `platform/libs/`, `web/`, `sens-api-gateway/`, `infrastructure/`, `crates/`)
- **Method:** 11 parallel specialist agents, every claim verified against source (`file:line`). Read-only audit — no code changed.
- **Trigger:** Owner asked for an independent, code-verified review of Single-Source-of-Truth integrity after a prior consultant gave generic, un-code-checked advice (JetStream, Saga, GraphQL schema registry, CQRS read-model sync).

---

## 0. Türkçe Özet (Executive Summary)

Genel tablo: **Mimari iskelet (schema-per-tenant, outbox, event-contracts, federation, tenant lifecycle) gerçekten enterprise-seviye ve çoğu CI invariant'ı ile kilitli.** Önceki danışmanın 4 önerisinin 3'ü ya **zaten yapılmış** ya da **bu repoya yanlış** — yani danışman kodu okumadan konuşmuş.

Ama tüm repoyu tarayınca asıl SSOT sorunu danışmanın söylediği yerlerde değil, **iki tekrar eden anti-pattern'de**:

1. **"Built but unwired" (yapılmış ama bağlanmamış) — sahte SSOT / audit theater.** Görkemli, test edilmiş, prod'a deploy edilmiş ama **hiç çağrılmayan** sistemler: OPA policy motoru (kayıtlı değil), `StripeApiService` (sıfır tüketici → platform Stripe'a hiç çağrı yapmıyor), Rust sensor sidecar (prod'da ama gelen veriyi düşürüyor), frontend codegen (üretiliyor ama hiçbir modül import etmiyor), `config-service` (var ama kimse okumuyor), feature-toggle tablosu (sadece admin'de, kimse sorgulamıyor). Bunlar "SSOT var" izlenimi verip aslında **boş** olduğu için en tehlikelileri.

2. **"Hand-copied catalog" (elle kopyalanmış katalog) — çoğa bölünmüş SSOT.** Aynı gerçek birden çok yerde elle tanımlanmış ve **çoktan ıraksamış**: plan limitleri **6 yerde** (starter sensör limiti bir yerde 20, başka yerde 50), rol hiyerarşisi backend + frontend'de 4-5 kopya, env default'ları 13-15 serviste, retry helper 4 kopya, RLS exclude tabloları registry'den türetilmeyip elle yazılmış (farm kopyası çoktan kaymış).

**En kritik tek bulgu — Billing.** Abonelik/iptal/iade işlemleri **Stripe'a hiç gitmiyor**; sadece lokal DB'ye yazılıyor. `stripeSubscriptionId` hiçbir yerde gerçek Stripe nesnesinden doldurulmadığı için gelen webhook eşleşmesi yapısal olarak ölü. Plan-limit zorlaması (enforcement) **tamamen yok** — starter tenant sınırsız kaynak açabiliyor. Metered billing hiç gelir üretmiyor. Bu, mimari değil, **iş/gelir** riski.

Aşağıda alan alan, kanıtla, severity ve finding-ID ile.

---

## 1. Verdict on the prior consultant's 4 recommendations

| # | Consultant said | Reality (code-verified) | Verdict |
|---|---|---|---|
| 1 | "Enable JetStream so events survive crashes" | JetStream is **already fully enabled** (`infrastructure/docker/nats/nats.conf:7-11`, `platform/libs/event-bus/src/nats/nats-event-bus.ts:13-14,367-368,562-564,788-799`). And durability is **not** JetStream's job here — the **transactional outbox** is the durability SSoT (`platform/libs/outbox/src/outbox-publisher.service.ts:69-137`). | **MISGUIDED** — already done; wrong mental model of where durability lives. |
| 2 | "Add a NATS Saga + compensating transactions for tenant provisioning" | A durable, persisted, lease-fenced, retryable **saga already exists** with 12 ledgered steps, command receipts, outbox, and step-aware compensation (`apps/admin-api-service/src/tenant/services/tenant-provisioning-workflow.service.ts`, `apps/auth-service/.../tenant-provisioning-command.service.ts`), CI-locked by `tests/invariants/tenant-provisioning-ssot.spec.ts`. | **REDUNDANT** — already implemented, and better than the naive version proposed. |
| 3 | "Add a GraphQL Schema Registry + breaking-change checks to `npm run build:all`" | Federation is real (Apollo Gateway, 10 subgraphs, `@key` directives). Breaking-change detection **already runs in CI** via supergraph composition (`.github/workflows/apollo-supergraph-validate.yml` → `scripts/apollo-router/build-supergraph.mjs`). A separate Apollo schema-registry **service** is not needed (static supergraph composition is the chosen design). | **PARTLY RIGHT, MOSTLY REDUNDANT** — federation exists, checks exist; registry would be bloat. Real gap is elsewhere (FE codegen orphan, §8). |
| 4 | "Sync write-model SSoT with Redis read-model / invalidate on writes" | Read models read from write-model tables; the one materialized projection (farm-stock) is refreshed **in-transaction** (zero stale window). Redis is a derived cache, not a hidden SSoT. **But** there is one genuine stale-cache hazard (§7). | **PARTLY RIGHT** — the concrete bug exists but is narrow; the broad framing overstates it. |

**Bottom line on the consultant:** generic textbook advice applied without reading the code. 3 of 4 points were already solved or inapplicable. The real SSOT debt is in areas the consultant never mentioned (billing, authz, config, sensor migration, frontend types).

---

## 2. The two systemic anti-patterns (read this first)

Everything below clusters into two repeating shapes. Fixing the *pattern* matters more than any single finding.

### Pattern A — "Built but unwired" (Potemkin SSoT / audit theater)
Fully implemented, often tested and even deployed, but with **zero live consumers** — so it looks like an authoritative system while doing nothing. These are dangerous because they create false confidence and rot silently.

- OPA policy engine + 3 `.rego` policies — guard never registered, `@OpaPolicy()` on zero handlers (§5).
- `StripeApiService` (canonical Stripe client w/ breaker+audit) — **zero consumers**; platform makes no Stripe API calls (§6).
- Rust `sensor-ingestion` sidecar — **deployed to prod** but `drain_mqtt_stream` parses/persists/publishes nothing (§9).
- Frontend `graphql-types.ts` codegen — generated, imported by **zero** `web/` files except aquamobil (§8).
- `config-service` — exists, schema + resolvers, **no service reads it** (§9-config).
- `FeatureToggle` admin table — sophisticated flag model, **never queried** by any service (§9-config).
- `NatsIngestionConsumerService` — subscribes to a subject with **zero producers** (forward-dead) (§9-sensor).
- `EventHandlerRegistryModule` / `@EventHandler` — **unimported**; live pattern is `eventBus.subscribeWildcard` (§10).
- `createEvent()` in event-bus, v1 service-identity verifier, `LegacyTokenMetrics`, dead event contracts — exported, never called (§3, §5, §10).

### Pattern B — "Hand-copied catalog" (split SSoT, already drifting)
The same fact declared independently in N places, with no derivation and no parity invariant — so copies drift.

- **Plan limits → 6 copies, already divergent** (starter `maxSensors` = 20 vs 50) (§6).
- **Role hierarchy / `UserRole`** → backend canonical + 4-5 frontend hand-copies + a dead hr enum (§5).
- **`RlsModule.excludeTables`** → per-service hand-copies of `infrastructureTables`; farm's already diverged (§3).
- **Env defaults** (`5432`, `nats://localhost:4222`, `AQUACULTURE_EVENTS`, schema names) → duplicated across 13-15 services + compose files; `platform/configs/*.ts` are **0 bytes** (§9-config).
- **Retry helper** → 4 independent copies (§10).
- **Shared-table canonical list** → 4 lists, parity invariant only checks 3 (§3).

---

## 3. Schema placement & event contracts

### 3.1 Schema-placement SSoT — PARTIAL (registry is real, two drift holes)
**SSoT:** `MODULE_SCHEMAS` in `libs/backend-common/src/database/schema-manager.service.ts:205-702` (per-service `tables` / `referenceDataTables` / `infrastructureTables`). Derived constants computed from it correctly. Entity→registry parity enforced by `tests/invariants/tenant-fanout-entity-parity.spec.ts:155-200`.

- **[SSOT-H-01] `RlsModule.excludeTables` are unguarded hand-copies of `infrastructureTables`, farm's already diverged.** `apps/farm-service/src/app.module.ts:467-474` lists `audit_logs`/`audit_log` (not in registry) and omits `tenant_erasure_audit`/`farm_audit_logs` (which ARE registry infra tables) — compare `schema-manager.service.ts:312-320`. No invariant ties `excludeTables`→`infrastructureTables`. **Real tenant-isolation correctness risk** (a new cross-tenant table can silently get an RLS tenant policy, or a per-tenant table get wrongly excluded). Other copies: ai/messaging/auth/sensor/billing/alert/hydroponics/notification app.modules. **Fix (Tier-2):** `RlsModule.forPoolService` reads `MODULE_SCHEMAS[svc].infrastructureTables` directly.
- **[SSOT-M-02] Shared-table canonical list exists in 4 places; parity invariant checks only 3.** `e2e/tests/integration/schema-invariants.spec.ts:208-219` has its own independent `SHARED_SCHEMA_TABLES` set not covered by `tests/invariants/shared-schema-canonical.spec.ts`. Currently consistent (5 tables incl. `access_logs`) but drift-prone. (Note: docstrings still say "4 canonical" — stale; it's 5 since 2026-05-18.)

### 3.2 Event-contract SSoT — GOOD core, one competing lineage
**SSoT:** `createBaseEvent()` + branded `EventId` (`libs/event-contracts/src/base-event.ts:16,194-209`). Brand makes inline construction a compile error; no production file builds a `BaseEvent` by hand. `AnyPlatformEvent` union + `PLATFORM_EVENT_REGISTRY` are real.

- **[SSOT-M-03] Competing un-branded `IEvent`/`createEvent` lineage in `@platform/event-bus`.** `createEvent()` (`platform/libs/event-bus/src/nats/nats-event-bus.ts:1058-1070`) returns plain-string `eventId` + nested `metadata` (ADR-006 violation) and is **dead** (zero callers). `IEvent` (`event-bus.interface.ts:10-27`) is extended by consumers that **locally re-declare canonical event shapes** for the same `eventType`: `apps/alert-engine/.../sensor-reading.handler.ts:14` (dup of `sensor-events.ts:63`), `apps/notification-service/.../alert-triggered.handler.ts:66`, `task-assigned.handler.ts:45,64`. A canonical field add won't reach these copies. Owner overlap with platform-kernel-expert (kernel owns the bus).
- **[SSOT-L-04] Dead event contracts:** `DeliveryReceivedEvent`, `StockTransferCompletedEvent` (`libs/event-contracts/src/storage-events.ts:78,182`) — exported, never produced/consumed.
- **[SSOT-H-05] Direct `eventBus.publish` bypasses the outbox in farm storage** (`apps/farm-service/src/storage/handlers/record-stock-movement.handler.ts:129,164`) while HR uses the outbox. (Re-confirms prior DATA-HIGH-004.) Outbox-only-publish convergence is incomplete.

### 3.3 TimescaleDB — CONFIRMED REAL (consultant was right on this one)
`docker-compose.yml:13` ships `timescale/timescaledb-ha:pg16`; `database/migrations/modules/sensor/V002__create_hypertables.sql:8,16` creates the extension + `create_hypertable('sensor.sensor_metrics',...)`; runtime services in `apps/sensor-service/src/timescale/*`; CI invariant `tests/invariants/timescale-rls-columnstore-contract.spec.ts`.

---

## 4. NATS messaging & durability — HEALTHY (consultant wrong)
- **JetStream:** fully enabled and in use (evidence in §1.1). Stream `AQUACULTURE_EVENTS`, file storage, 7-day retention, 2-min dedup window.
- **Durability SSoT = transactional outbox**, NATS is transport. Domain write + outbox INSERT commit atomically (`outbox-publisher.service.ts:129-137` fails closed if not in a transaction); `OutboxWorkerService` drains via LISTEN/NOTIFY (~5ms) + 5s cron, publishes with `msgID` = dedup key. They compose, not conflict.
- **NATS config SSoT in sync:** `infrastructure/nats/services.yaml` → `scripts/nats/generate-nats-conf.py` → generated block in `nats.conf` (BEGIN/END sentinels). 15 services match; cert-CN-only identity; CI `e2e/tests/integration/nats-invariants.spec.ts`. (One drift caveat in §10.)
- **Replica hazard FIXED:** `nats-event-bus.ts:157-167` defaults R=3 in prod and throws if `<3`; dev gets R=1. (Cross-ref the standalone-droplet note in memory — separate runtime-clamp concern, not this audit.)

---

## 5. Authorization / RBAC — FRAGMENTED (FIVE vocabularies)
**The one good SSoT:** canonical 4-role enum + hierarchy (`libs/backend-common/src/decorators/roles.decorator.ts:16-70`), RS256-pinned JWT (`platform-jwt.module.ts:93`), HMAC v2 tenant binding (`service-identity.util.ts:219-396`), correct tenant-id precedence (JWT > header > subdomain, `tenant-context.middleware.ts:102-173`). This core is solid.

But **five disconnected authorization vocabularies** coexist with no shared catalog:

- **[SSOT-H-06] hr-service ships its own `RolesGuard` that breaks the hierarchy contract.** `apps/hr-service/src/common/guards/roles.guard.ts:30` does strict membership — **no hierarchy, no SUPER_ADMIN bypass** — while pairing with the canonical `@Roles()` decorator. Consequence: a `@Roles(TENANT_ADMIN, MODULE_MANAGER)` resolver **denies a SUPER_ADMIN** (canonical guard at `roles.guard.ts:155-171` would allow). Live correctness+security bug. **Fix:** delete it, register the canonical `RolesGuard`.
- **[SSOT-H-07] Fine-grained permission strings have NO catalog SSoT.** `@RequireTenantPermission('edge:manage-io-config')` (`apps/sensor-service/.../edge-device.resolver.ts:342`) is free-form; `resourcePermissions` is an opaque `string[]` (`token.service.ts:540-545`). Grant side and enforce side are unjoined → a typo silently fails closed. No central `Permission` catalog exists.
- **[SSOT-H-08] OPA is a fully-built DEAD stack.** `OpaPolicyGuard` + `OpaClientService` + `PolicyEnforcerService` + 3 `.rego` policies (`apps/gateway-api/src/opa/**`) exist with fail-closed-in-prod logic and tests, but the guard is **never registered** and `@OpaPolicy()` decorates **zero** handlers. A 4th parallel authz vocabulary that ships and rots. **Force the decision: adopt platform-wide or delete.**
- **[SSOT-M-09] Frontend RBAC catalog is a divergent hand-copy.** `web/shared-ui/src/contexts/AuthContext.tsx:149-159` re-declares `ROLE_HIERARCHY`+`roleHasPermission()` byte-for-byte ("matching backend"); `UserRole` union re-declared in **4** places (`AuthContext.tsx:24`, `shared-ui/src/types/index.ts:16`, `tenant-admin/src/lib/types.ts:20`, +shell literals). Bare-string role checks in `web/shell/src/App.tsx:129,245,259`. Fix: derive from a shared source (the generated GraphQL enum already exists).
- **[SSOT-L-10] Dead duplicate `Role` enum** in hr-service (`apps/hr-service/src/common/enums/role.enum.ts:1` — `ADMIN`/`HR_MANAGER`/…) shadows the canonical name; resolvers import the canonical one. Delete. Plus parallel models: admin `PanelPermissions` jsonb + custom numeric-level `tenant_roles` (`tenant-role.service.ts:8`) — neither joined to the role enum or to `resourcePermissions`.
- **[SSOT-L-11] Dead v1 service-identity** generator/verifier still present (`service-identity.util.ts:421,444`) though unreachable. Delete the footgun.

**Genuinely fine:** RS256 pinning, access-token-type enforcement, no header-spoofing in authenticated paths, HMAC v2 tenantId binding, v1 acceptance closed, fail-closed verifier allowlist, strip-internal-headers ordering at gateway.

---

## 6. Billing / subscriptions — THE HEADLINE (financial, not architectural)
**Verdict:** Billing was **not** built as a Stripe-anchored SSoT. It is a hand-maintained local state machine with a webhook listener bolted on and a canonical Stripe client that nothing calls. This is the highest-impact area in the whole audit.

- **[SSOT-C-12] No outbound Stripe integration — local state can drift from Stripe arbitrarily.**
  - `create-subscription.handler.ts:103-137`, `change-subscription-plan.handler.ts:141-204`, `cancel-subscription.handler.ts:64-71`, `refund-payment.handler.ts:76-181` all mutate **local DB only** — no `stripe.subscriptions.*` / `stripe.refunds.*` call. Customers are never actually charged/refunded via Stripe on these paths.
  - `stripeSubscriptionId`/`stripeCustomerId` (`subscription.entity.ts:178-183`) are only ever written from caller DTO input — never from a real Stripe object. So inbound webhook lookups `where {stripeSubscriptionId,tenantId}` (`stripe-webhook.service.ts:332,396`) **can never match** a system-created subscription → inbound subscription sync is structurally dead.
  - **`StripeApiService`** (canonical client w/ breaker+audit+idempotency, `libs/backend-common/src/billing/stripe-api.service.ts`) has **zero consumers** (grep across `apps/**` = no matches). The invariant `tests/invariants/stripe-calls-via-canonical-client.spec.ts` passes **vacuously** (checks files exist + nobody imports raw SDK, never that any handler calls the service).
  - **No reconciliation** job re-reads Stripe. Local state is authoritative-by-accident.
- **[SSOT-C-13] Plan-tier → limits mapping defined in SIX divergent places (already drifting).** `billing.plans` seed (`plan-seed.service.ts:38-146`, starter `maxSensors:20`); inline `DEFAULT_LIMITS` (`tenant-subscription-requested.handler.ts:82-126`); gateway `PLAN_LIMITS` (`tenant-context.middleware.ts:186-232`, starter `maxSensors:50`); **byte-identical duplicate** in `tenant-lookup.service.ts:110-156`; admin `getDefaultLimitsForTier` with a 3rd schema (`plan-definition.service.ts:364-464`); auth maxUsers-by-tier (`tenant.service.ts:144-148`). Plus a **competing plan entity** `admin.plan_definitions` vs `billing.plans`, and a 4th pricing source in `MeteredBillingService.pricingModels`. Tier enum forked 3 ways (`PlanTier` vs `TenantPlan` vs admin `PlanTier`). **Concrete divergence:** same starter tenant = 20 sensors (billing) vs 50 (gateway).
- **[SSOT-H-14] Plan-tier enforcement is entirely ABSENT.** `PLAN_LIMITS` is consumed only as request metadata (`tenant-context.middleware.ts:497`, `tenant-lookup.service.ts:269`); **no** `CreateFarm`/`CreatePond`/`RegisterSensor` handler reads a limit before persist (grep for `maxFarms`/`maxSensors`/`PLAN_LIMIT_EXCEEDED` enforcement in farm-service = none). A STARTER tenant can create unlimited resources. Downgrade has no usage pre-check (`change-subscription-plan.handler.ts:154-192`).
- **[SSOT-H-15] Metered billing produces no revenue.** `MeteredBillingService.calculateBilling` emits an in-process event, never a Stripe invoice/MeterEvent; `UsageMeteringService` increments are in-memory `+=` (`usage-metering.service.ts:563`), not atomic Redis — concurrent increments lost. Plus an in-house tax engine + hardcoded FX (`metered-billing.service.ts:473-642`) duplicating what Stripe Tax should own.
- **[SSOT-H-16] Webhook uses hand-rolled HMAC** (`createHmac` `stripe-webhook.controller.ts:494`) instead of `stripe.webhooks.constructEvent` (ADR-016 CRITICAL-class). Raw-body order + freshness + timing-safe compare are correct, and idempotency dedup is solid (DB-first, no Redis-only bypass), but it processes synchronously inline (5s deadline risk) and `SubscriptionPastDue` is emitted with fields not matching its contract (`billing-scheduler.service.ts:78-83` vs `billing-events.ts:197-208`).
- **[SSOT-M-17] Near-zero cross-service consumption of billing events.** Only auth-service consumes `TenantSubscriptionChanged` (the one clean projection, `tenant-subscription-projection.handler.ts:65`). No service consumes `SubscriptionUpdated`/`Created` to update gating — moot today (no enforcement) but a gap the moment §14 is fixed.

**Healthy in billing:** `billing.subscriptions` as entity SSoT + `auth.tenants` one-way projection; Money/Decimal precision on payment/invoice path; webhook dedup; soft-delete + partial-unique-active index.

---

## 7. CQRS write/read model & cache — HEALTHY, one real stale-cache bug
- Commands write to primary tables atomically; queries read the same write-model tables. The one materialized projection (farm-stock snapshots) is refreshed **in the same transaction** as the write (`apps/farm-service/src/tank/handlers/create-tank.handler.ts:132` inside `runInTenantTransaction`) → no stale window.
- Redis is a derived read-through cache (`@Cacheable`/`CacheableInterceptor`); no domain truth lives only in Redis (sessions/rate-limits/locks are legitimate).
- Outbox makes domain-write + projection + event enqueue one ACID transaction — **no dual-write hazards** found.
- **[SSOT-H-18] `batchPerformance` 1-hour stale-cache bug.** `@Cacheable({prefix:'batch:performance', ttlSeconds:3600})` (`apps/farm-service/src/batch/resolvers/batch.resolver.ts:169-176`) is **not invalidated** by `recordMortality`/`recordCull` (`:300-360`, no `@CacheEvict`), which change the very stats it serves (FCR, survival). Frontend can show stale performance up to 1h. Also `@CacheEvict` is fire-and-forget (`cache-evict.interceptor.ts:62-75`) — eviction failure leaves stale cache silently. **Fix:** add `@CacheEvict` to mutating resolvers; add a lint/test that flags `@Cacheable` entities whose mutations lack matching evict.

---

## 8. Frontend data contract — TWO solid SSoTs, TWO broken
**Solid (the template to copy):**
- Federation shared-deps: ONE source `web/shared-ui/src/federation/federationSharedConfig.ts` (`SHARED_VERSIONS`), every `vite.config.ts` imports it, all `singleton:true strictVersion:true`, two CI invariants. Version drift across remotes is structurally impossible.
- Design tokens: ONE source `web/shared-ui/src/styles/theme.css`, all 7 modules + shell import it; no token duplication.

**Broken:**
- **[SSOT-H-19] Generated GraphQL types are orphaned for the whole shell + 7 remotes.** `web/shared-ui/src/generated/graphql-types.ts` (24k+ lines) is imported by **zero** `web/` files; `shared-ui/src/index.ts` never re-exports it. Only aquamobil consumes its own generated file. Codegen runs and overwrites a file nobody reads → cannot drift-detect anything.
- **[SSOT-H-20] Every remote hand-writes entity types that duplicate and diverge from the schema.** `Tank` declared 3× in farm-module with incompatible shapes (`hooks/useTanks.ts:69`, `services/tank.service.ts:64`, `pages/cleaner-fish/types.ts:22`); `Batch`/`Species`/`Feed` likewise. Typing flows through caller-supplied generics so a backend field rename compiles clean and surfaces as runtime `undefined`. The lint guard `tools/eslint-rules/rules/no-bare-graphql-query-string.ts:99` only catches `gql` tagged templates and is blind to the dominant plain-string-constant query pattern (and is `warn`-only).
- **[SSOT-H-21] Canonical biomass formula re-derived client-side in ~10 places.** `(quantity*avgWeight)/1000` inlined across farm-module modals (`production/components/BatchFormModal.tsx:276` + ~9 others) with no shared helper, while the backend already exposes computed `biomass`. Unit/divisor convention living in 10 spots = silent divergence risk. **Fix:** one `computeBiomass` util; server value stays the display SSoT.
- **[SSOT-M-22]** tenant-admin/admin-panel bypass shared-ui `Button` with 138 raw `<button>` (component-SSoT gap); mock biomass datasets shipped in farm-module report source (`pages/reports/mock/*`) — verify unreachable in prod.

---

## 9. Config / env / secrets & sensor ingestion

### 9-config. Configuration — BROKEN SSoT
- **[SSOT-H-23] `config-service` is dead as a runtime SSoT.** It has entities + resolvers (`effectiveConfiguration`) but **no service queries it** (grep for callers = only an admin health check + a `// TODO: source from config-service` in farm). All runtime config is read ad-hoc via `process.env`/`ConfigService.get()` with inline defaults.
- **[SSOT-H-24] Env defaults duplicated across 13-15 services + compose files; central registry is empty.** `DATABASE_*` defaults copied in every `data-source.ts` (`5432`, `localhost`, `aquaculture`); `NATS_URL`/`NATS_STREAM_NAME` defaults in 12 app.modules; schema names are inline string literals in `@Entity` decorators. **`platform/configs/*.ts` are 0 bytes** — the intended central home is empty. **Fix:** `platform/configs/{database,messaging,schemas}.constants.ts` imported everywhere.
- **[SSOT-M-25] Three competing feature-flag mechanisms with no SSoT:** env booleans (`ENABLE_FEDERATION`, `ENABLE_DEBUG_TOOLS`…), a sophisticated `FeatureToggle` admin table (`feature-toggle.entity.ts:38-116`) that **no service queries**, and direct `ConfigService` reads. Pick one.
- Secrets: file-mount bootstrap exists (`create-service-app.ts:538-605`) but is opt-in per service, and secrets are re-declared per service across compose files (drift-prone). MEDIUM.

### 9-sensor. Sensor ingestion — half-migrated, deployed no-op
**SSoT today = 100% the TypeScript `sensor-service`** (`MqttListenerService` + `BatchProcessorService`); both compose files default `SENSOR_SERVICE_PROFILE=legacy`.
- **[SSOT-H-26] Rust `sensor-ingestion` sidecar is deployed to prod but drops all data.** `apps/sensor-ingestion/src/main.rs:201-240` `drain_mqtt_stream` only `trace!`s messages; `topic::parse`/`payload::validate`/`PostgresSink`/`NatsOutboxPublisher` are never called from `main`. Yet `docker-compose.prod.yml:363-390` deploys it advertising "co-equal producer." Data integrity is intact **only because TS is the live path** — but it's a misleading deployed no-op holding a broker subscription/QoS-1 acks. **Fix:** finish wiring it or remove it from prod compose until it does real work. (Specialist rated CRITICAL assuming co-equal; gated-off reality → HIGH.)
- **[SSOT-H-27] Modbus decode triplicated with no parity gate.** TS adapters (`modbus-tcp.adapter.ts:194-218`), Rust `crates/protocol-codec/src/modbus/*` (intended SSoT), and edge `sens-api-gateway/src/modbus.rs:1198,1240` (which does **not** depend on `protocol-codec`). The cross-language drift gate is half-built: `tools/scripts/check-codec-drift.ts:11` references a TS spec that **doesn't exist** → it validates Rust-against-itself only.
- **[SSOT-M-28] Two calibration SSoTs:** edge Rust `calibration_engine.rs` (slope/offset/r², SQLite) vs cloud TS `apps/sensor-service/src/calibration/`, separate defaults, no reconciliation of which is authoritative per reading. Plus a second cloud writer to `sensor_metrics` bypassing BatchProcessor (`mqtt-listener.service.ts:1147-1158`), and `NatsIngestionConsumerService` subscribed to a producer-less subject (forward-dead).

---

## 10. Observability & repo-wide dead/duplicate inventory
**Observability SSoT — strong:** metric definitions centralized with cardinality budgets (`libs/backend-common/src/metrics/orchestrator-metrics.ts`, `tenant_id` banned as a label); alert rules a single catalog with enforced `runbook_url` (`infrastructure/monitoring/droplet/rules/*`, CI `monitoring-alert-runbook-url.spec.ts`).

- **[SSOT-M-29] Service-registry drift between NATS and monitoring.** `infrastructure/nats/services.yaml` lacks `config-service` + `event-store-service`, but Prometheus `file_sd/aqua-services.json` includes them → if either uses NATS it hits the mTLS "Authorization Violation" restart loop (the 2026-04-21 incident class). `event-store-service` is in monitoring, absent from docker-compose + NATS → likely orphaned/superseded.
- **[SSOT-M-30] Retry helper duplicated 4×:** `sensor-service/sensor/utils/retry.util.ts` (canonical), `sensor-service/common/errors.ts:147-189`, `farm-service/feeding/services/feeding-cron.service.ts:151-180`, `gateway-api/services/http-pool.service.ts`. Backoff/jitter constants can diverge. Consolidate to one.
- **[SSOT-L-31] Confirmed dead code:** `EventHandlerRegistryModule`/`@EventHandler` (unimported; live pattern = `subscribeWildcard` in `onModuleInit`); `LegacyTokenMetrics` (`libs/backend-common/src/monitoring/legacy-token-metrics.ts:23-60`, exported never called). Remove.

---

## 11. Prioritized remediation roadmap

### CRITICAL (financial/correctness — do first)
- **SSOT-C-12** Wire real outbound Stripe via `StripeApiService` on create/change/cancel/refund; populate `stripeSubscriptionId` from real Stripe objects; add reconciliation; make the canonical-client invariant assert actual usage (not vacuous).
- **SSOT-C-13** Collapse the 6 plan-limit copies + 2 plan entities into ONE catalog (`billing.plans` per D14) projected to gateway/auth/admin; unify the tier enum; add a parity invariant.

### HIGH
- **SSOT-H-14** Add plan-tier/quota enforcement at resource-creation handlers (reads the §13 catalog).
- **SSOT-H-06** Delete hr-service's divergent `RolesGuard`; register the canonical one.
- **SSOT-H-07** Introduce a `Permission` catalog SSoT consumed by both `@RequireTenantPermission` and role seeding.
- **SSOT-H-08** Decide OPA: adopt platform-wide or delete the dead stack.
- **SSOT-H-19/20/21** Re-wire frontend to consume generated types (or `Pick<>`-project them); extend the GraphQL-string lint to plain-string queries + promote to error; extract `computeBiomass`.
- **SSOT-H-01** Derive `RlsModule.excludeTables` from `infrastructureTables` + add invariant.
- **SSOT-H-05** Finish outbox-only-publish convergence (kill direct `eventBus.publish` in farm storage).
- **SSOT-H-15/16** Wire metered billing to Stripe Meter API with atomic increments; switch webhook to `constructEvent`.
- **SSOT-H-18** Add `@CacheEvict` to batch-stat mutations + a guard test.
- **SSOT-H-23/24** Make `config-service` authoritative or formally retire it; fill `platform/configs/*` and replace duplicated env defaults.
- **SSOT-H-26/27** Finish or de-deploy the Rust sidecar; land the TS↔Rust codec-drift spec before any tenant flips to Rust; make edge depend on `protocol-codec`.

### MEDIUM / LOW
- SSOT-M-02 (4th shared-table list), M-03 (`IEvent` lineage), M-09 (FE role copies), M-17 (billing event consumption), M-22 (raw buttons/mocks), M-25 (feature-flag unification), M-28 (calibration ownership), M-29 (service-registry drift), M-30 (retry dup); L-04/10/11/31 (dead-code cleanups).

---

## 12. Finding index

| ID | Sev | Area | One-liner |
|---|---|---|---|
| SSOT-C-12 | CRIT | Billing | No outbound Stripe; local subscription state drifts; `StripeApiService` dead |
| SSOT-C-13 | CRIT | Billing | Plan-limits defined 6× (already divergent) + 2 competing plan entities |
| SSOT-H-01 | HIGH | Schema | `RlsModule.excludeTables` hand-copies of `infrastructureTables`; farm diverged |
| SSOT-H-05 | HIGH | Events | Direct `eventBus.publish` bypasses outbox in farm storage |
| SSOT-H-06 | HIGH | Authz | hr `RolesGuard` ignores hierarchy/SUPER_ADMIN |
| SSOT-H-07 | HIGH | Authz | Permission strings have no catalog SSoT |
| SSOT-H-08 | HIGH | Authz | OPA fully built but dead (unregistered) |
| SSOT-H-14 | HIGH | Billing | Plan-tier enforcement entirely absent |
| SSOT-H-15 | HIGH | Billing | Metered billing never reaches Stripe; non-atomic counters |
| SSOT-H-16 | HIGH | Billing | Hand-rolled webhook HMAC instead of `constructEvent` |
| SSOT-H-18 | HIGH | Cache | `batchPerformance` 1h stale (no evict on mortality/cull) |
| SSOT-H-19 | HIGH | Frontend | Generated GraphQL types orphaned (zero importers) |
| SSOT-H-20 | HIGH | Frontend | Remotes hand-write divergent entity types |
| SSOT-H-21 | HIGH | Frontend | Biomass formula re-derived in ~10 places |
| SSOT-H-23 | HIGH | Config | `config-service` dead as runtime SSoT |
| SSOT-H-24 | HIGH | Config | Env defaults duplicated 13-15×; `platform/configs` empty |
| SSOT-H-26 | HIGH | Sensor | Rust sidecar deployed to prod but drops all data |
| SSOT-H-27 | HIGH | Sensor | Modbus decode triplicated; drift gate half-built |
| SSOT-M-02 | MED | Schema | 4th shared-table list unguarded by parity invariant |
| SSOT-M-03 | MED | Events | Competing un-branded `IEvent`/`createEvent` lineage |
| SSOT-M-09 | MED | Authz | Frontend RBAC catalog is a divergent hand-copy (×4) |
| SSOT-M-17 | MED | Billing | Near-zero cross-service consumption of billing events |
| SSOT-M-22 | MED | Frontend | Raw `<button>` ×138 + shipped mock biomass data |
| SSOT-M-25 | MED | Config | 3 competing feature-flag mechanisms |
| SSOT-M-28 | MED | Sensor | Dual calibration SSoT (edge vs cloud) + 2nd metric writer |
| SSOT-M-29 | MED | Observability | NATS vs monitoring service-registry drift |
| SSOT-M-30 | MED | Dead/dup | Retry helper duplicated 4× |
| SSOT-L-04 | LOW | Events | Dead event contracts (Delivery/StockTransfer) |
| SSOT-L-10 | LOW | Authz | Dead duplicate hr `Role` enum + parallel models |
| SSOT-L-11 | LOW | Authz | Dead v1 service-identity verifier |
| SSOT-L-31 | LOW | Dead/dup | `EventHandlerRegistryModule`, `LegacyTokenMetrics` dead |

---

## 13. What is genuinely solid (do NOT touch)
Tenant lifecycle (durable saga + symmetric event-driven erasure, CI-locked) · transactional outbox durability · NATS cert-CN identity + config generation · JetStream R=3 · event `createBaseEvent` branding · schema-per-tenant routing · GraphQL federation + CI breaking-change composition · CQRS in-transaction projections · federation shared-deps SSoT · design-token SSoT · observability metric/alert catalogs · RS256/HMAC-v2 auth core · TimescaleDB hypertables. These are the patterns to copy when fixing the rest.

---

*Audit produced by 11 code-grounded specialist agents on 2026-06-23. All `file:line` references were valid at audit time; re-verify before acting on any finding (code moves). No source was modified.*
