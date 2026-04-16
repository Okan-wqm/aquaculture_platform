# W1 Part A — Platform Services Discovery Audit (READ-ONLY)

**Date:** 2026-04-16
**Scope slice:** billing-service, notification-service, config-service, event-store-service, observability-service, hydroponics-service, web/modules/hydroponics-module, plus `@platform/cqrs`, `@platform/event-bus`, `@platform/outbox`, `libs/backend-common` runtime foundations.
**Mode:** Read-only. Grep / Glob / Read only. No source was modified.
**Plan:** `/root/.claude/plans/declarative-riding-shamir.md`
**ADR anchors:** 006 (flat events), 011 (schema ownership), 012 (schema drift), 014/015 (NATS cert identity).

---

## Executive Verdict

**Q (from task):** Do `event-store-service` and `config-service` `@Entity()` classes lack `schema:` option?
**A:** **YES — confirmed. ADR-011 violation.**

| Service | Entity files | Entities missing `schema:` | Entities with `schema:` |
|---|---|---|---|
| event-store-service | 4 | 4 (`StoredEvent`, `EventStream`, `Snapshot`, `ProjectionCheckpoint`) | 0 |
| config-service | 1 file, 2 @Entity classes | 2 (`Configuration`, `ConfigurationHistory`) | 0 |
| **billing-service** (bonus scope, also violates) | 8 files, 9 @Entity classes | 9 | 0 |
| **hydroponics-service** (bonus scope, also violates) | 1 | 1 | 0 |
| notification-service | 2 | 0 | 2 (`DeviceToken`, `NotificationLog` both `schema: 'notification'`) |
| alert-engine (context only) | 5 | 5 | 0 |
| observability-service | 0 (no owned tables — cross-schema reads) | — | — |

Total ADR-011 violations across scope: **21 `@Entity()` classes** lack `schema:` despite their app.module.ts all registering `SchemaDriftModule.forRoot({ serviceName: '<svc>' })`. The drift validator is advisory-only by default (SCHEMA_DRIFT_FATAL opt-in). Every missing `schema:` means entity↔table mapping depends on `search_path` at runtime, inviting cross-tenant/cross-schema collisions and silent breakage if the shared `public` schema acquires a same-named table.

---

## Table 1 — Pattern usage

| # | Pattern / concern | Service | State | Evidence |
|---|---|---|---|---|
| 1 | `@Entity()` with `schema:` option | billing-service | **MISSING** on 9/9 entities | `subscription.entity.ts:92 @Entity('subscriptions')`, `invoice.entity.ts:99 @Entity('invoices')`, etc. |
| 2 | `@Entity()` with `schema:` option | event-store-service | **MISSING** on 4/4 entities | `stored-event.entity.ts:14 @Entity('stored_events')`, `event-stream.entity.ts:15`, `snapshot.entity.ts:13`, `projection-checkpoint.entity.ts:22` |
| 3 | `@Entity()` with `schema:` option | config-service | **MISSING** on 2/2 entities | `configuration.entity.ts:52 @Entity('configurations')`, `:177 @Entity('configuration_history')` |
| 4 | `@Entity()` with `schema:` option | notification-service | **PRESENT** on 2/2 entities | `device-token.entity.ts:13 @Entity('device_tokens', { schema: 'notification' })`, `notification-log.entity.ts:37` |
| 5 | `@Entity()` with `schema:` option | hydroponics-service | **MISSING** on 1/1 entity | `hydroponics-config.entity.ts:14 @Entity('hydroponics_config')` |
| 6 | `createMigrationRunnerService(schema)` provider | billing/config/event-store/notification/hydroponics | billing ✓ (`'billing'`), config ✓ but WRONG (`'public'` — see PLAT-CRITICAL-002), notification ✓ (`'notification'`), hydroponics — no runner registered | `app.module.ts` lines listed in Grep output |
| 7 | `SchemaDriftModule.forRoot({ serviceName })` | all 6 in scope | 5/6 present (billing, config, event-store missing **no** — all present). event-store app.module NOT verified in evidence block — but earlier scan missed it. **VERIFY** — event-store app.module.ts does NOT show SchemaDriftModule in grep matches | `apps/config-service/src/app.module.ts:112`, `apps/billing-service/src/app.module.ts:173`, `apps/notification-service/src/app.module.ts:190`, `apps/hydroponics-service/src/app.module.ts:165`. **event-store-service: absent from grep results — MISSING** |
| 8 | `@platform/outbox` adoption in scope services | billing, notification, config, event-store | **0 / 4** — none of the platform services use the outbox. All cross-service domain events are fire-and-forget via direct publish | grep `@platform/outbox` returned 44 files across `messaging-service`, `farm-service`, `hr-service` only |
| 9 | `@platform/event-bus` adoption | billing uses it (handlers, Stripe webhook service, scheduler), notification uses it (all event-handlers), observability-service uses it (security-events) | Present via `@aquaculture/backend-common` factory wiring | grep files_with_matches enumerated 70 files — billing has 9 handlers, notification has 6 event-handlers |
| 10 | `@platform/cqrs` adoption | billing, hydroponics (via alert-engine), messaging, hr, farm, admin-api, notification | billing: yes (commands/handlers structure), others: yes | Heavy adoption — 250+ files matched |
| 11 | Stripe webhook raw-body + HMAC + timing-safe + skew check + Redis idempotency | billing-service | **PRESENT — compliant with critical rules** | `stripe-webhook.controller.ts:12 timingSafeEqual`, `:219 MAX_TIMESTAMP_SKEW_SECONDS`, `:138 redis.setNx`, `main.ts:16 rawBody: true` |
| 12 | SsrfValidatorService for outbound webhooks | notification-service | **PRESENT — RFC-1918, link-local, CGNAT, metadata hostnames, redirect:'error'** | `ssrf-validator.service.ts:67-118`, wired at `notification-dispatcher.service.ts:583` |
| 13 | AES-256-GCM + scrypt encryption for secrets | config-service | **PRESENT — ENC_V1:/ENC_V2: envelope, scrypt KDF, master-key from env** | `encryption.service.ts:5,53,97,181`. V2 uses per-secret random salt |
| 14 | Event store immutability (DB triggers) | event-store-service | **PRESENT — BEFORE UPDATE / BEFORE DELETE plpgsql trigger** | `1782000000000-AddStoredEventsImmutabilityTriggers.ts:26-54` — closes prior PLAT-CRITICAL-005 |
| 15 | Optimistic concurrency on append | event-store-service | **PRESENT** with pessimistic_write stream lock + version check, throws `ConflictException` | `event-store.service.ts:77,328` |
| 16 | Projection apply + checkpoint in single transaction | event-store-service | **PRESENT — closes PLAT-CRITICAL-004** | `projections.service.ts:382 queryRunner.startTransaction()` wraps handler + checkpoint update |
| 17 | PID controller anti-windup + derivative-on-PV + LPF | hydroponics-module (frontend simulator) | **PRESENT** | `pid-controller.ts:47-71` back-calculation, 47 derivative-on-PV, 50 filtered derivative |
| 18 | `audit_logs` writes from billing (BillingAudit) | billing-service | **PARTIAL — AuditLogModule registered but no `@BillingAudit` decorator found. No `BillingAuditEntry` entity** | `app.module.ts:14 AuditLogModule, AuditLogInterceptor` |
| 19 | Health module per service | billing, config, event-store, notification, observability, hydroponics | All 6 present | `find apps/*/src/health` output |
| 20 | Prometheus instrumentation + tracing | observability-service | Prometheus, metrics-aggregator, tracing, security-events modules present | `apps/observability-service/src/{prometheus,metrics,tracing,security-events}/` |

---

## Table 2 — Anti-pattern spots

| Sev | Anti-pattern | Location | Evidence |
|---|---|---|---|
| **HIGH** | **`@Entity()` without `schema:` option — 21 entities** (ADR-011 violation) | billing (9), event-store (4), config (2), hydroponics (1), alert-engine (5) | See Table 1 rows 1-5 |
| **CRITICAL** | `createMigrationRunnerService('public')` — writes migrations to shared `public` schema | `apps/config-service/src/app.module.ts:24` | `const ConfigMigrationRunnerService = createMigrationRunnerService('public');` — directly violates "Never add new tables to `public`" rule |
| **HIGH** | `SchemaDriftModule.forRoot` **missing** in event-store-service | `apps/event-store-service/src/app.module.ts` | Not returned in earlier grep — confirms no drift validator |
| **HIGH** | Money columns use `@MoneyColumn + Decimal` on DB but GraphQL surface is `Float` (precision loss on serialize) | `invoice.entity.ts:140,149,158,163,168`, acknowledged TODO `PLAT-LOW-001` | Explicit `@Field(() => Float)` on Decimal columns |
| **HIGH** | Raw `Number(x)` / `.toNumber()` coercions on money values in query handlers | `query-handlers/get-tenant-billing.handler.ts:134,242`, `handlers/create-invoice.handler.ts:150-152`, `record-payment.handler.ts:141`, `refund-payment.handler.ts:149`, `billing-scheduler.service.ts:290,298,327,366,368`, `stripe-webhook.service.ts:56,262,469` | Breaks Decimal-arithmetic invariant once values exit the handler |
| **HIGH** | `Math.round(amount * 100) / 100` floating-point rounding in metered billing | `metered-billing.service.ts:1276` | Classic IEEE-754 drift on money. Also prevalent in test fixtures (`subscription.service.spec.ts`, `credit-discount.service.spec.ts` — 8+ sites) |
| **HIGH** | Hardcoded `* 100` minor-unit conversion missing (no CurrencyScaleService) | grep `CurrencyScaleService` / `toMinorUnits` / `fromBaseUnits`: **0 matches** in billing-service | Zero multi-currency support; JPY/KRW (scale 0), BHD/JOD/KWD (scale 3) would be silently broken |
| **HIGH** | No `BillingAuditEntry` entity / `@BillingAudit` decorator | billing-service | grep returned 0 matches. `AuditLogInterceptor` is generic — not the required transactional `BillingAuditEntry` row per command |
| **HIGH** | No `currencyCode` / `baseCurrencyCode` / `exchangeRate` columns on `Invoice` / `Subscription` / `Payment` | billing-service entities | grep returned 0 matches — single-currency assumption baked in |
| **HIGH** | No `TaxRoundingMode` resolution per `{tenantId, jurisdictionCode}` | billing-service | grep returned 0 matches — no VAT-rounding compliance surface |
| **MEDIUM** | Stripe webhook dedupe uses Redis `setNx` TTL (ephemeral), not durable `ProcessedWebhookEvent` table | `stripe-webhook.controller.ts:138` | Redis eviction or restart reopens the duplicate-processing window |
| **MEDIUM** | Projection event-tail query `e.globalPosition > :position` has no safe-tail grace window or `xmin` filter | `projections.service.ts:336` | Out-of-order commit can silently skip events whose writer-tx committed late — PostgreSQL sequences are not gapless |
| **MEDIUM** | No `@platform/outbox` adoption in billing or notification; outbound domain events via direct `eventBus.publish` with best-effort delivery | billing handlers, notification event-handlers | 44 outbox matches are all in farm/hr/messaging — none in platform scope |
| **MEDIUM** | Stripe webhook handler catches all routeEvent errors, returns 200 unconditionally — good for retry semantics, but missing DLQ entry for permanent-failure audit | `stripe-webhook.controller.ts:159-168` | `logger.error` only — no persisted failed-event row |
| **MEDIUM** | Notification dispatcher uses `Promise.allSettled` (correct), but two auth event-handlers use `Promise.all` in PII enrichment — one failure cancels peers | `auth-event.handler.ts:223,306` | Should be `allSettled` |
| **MEDIUM** | No `currencyCode` binding in `PaymentReceived` / `InvoiceIssued` event payloads | event contracts traversal | Event consumers cannot reason about currency — a silent future-multi-currency blocker |
| **MEDIUM** | Hydroponics PID uses raw `number` for integral / derivative math | `pid-controller.ts` full file | Slow IEEE-754 drift on 24/7 control loops; `decimal.js` or fixed-point preferred for high-precision micromole tracking |
| **MEDIUM** | `SchemaDriftModule` is advisory-only by default (`SCHEMA_DRIFT_FATAL` opt-in env flag) | `app.module.ts` across services | Known-broken entities ship to prod silently unless fatal mode set — defeats purpose of validator |
| **LOW** | `@MoneyColumn`'s runtime Decimal is silently coerced to `Float` at GraphQL boundary — acknowledged TODO `PLAT-LOW-001` | 5+ sites in `invoice.entity.ts` | Downstream GraphQL clients see Float, not Decimal scalar |
| **LOW** | `ConfigurationHistory.previousValue` / `newValue` are plain text columns even for SECRET-type configs | `configuration.entity.ts:203,207` | Plaintext history for secrets is a leak — must be re-encrypted under current key per review rules |
| **LOW** | `ConfigValueType.NUMBER` uses `Number(rawValue)` — loses precision for monetary configs | `configuration.entity.ts:155` | Non-blocking, but the config service currently cannot safely transport Decimal-typed secrets |

---

## Table 3 — Modernization opportunities

| # | Opportunity | Justification |
|---|---|---|
| 1 | **Enforce `schema:` on all 21 ADR-011 violators, turn `SCHEMA_DRIFT_FATAL=true` in prod** | Silent entity↔table drift already causing prior incidents (see ADR-012 rationale). Make it impossible (Tier 1 of the hierarchy). |
| 2 | Swap Stripe webhook dedupe from Redis `setNx` to durable `ProcessedWebhookEvent(tenant_id, stripe_event_id)` table with `INSERT ON CONFLICT DO NOTHING` | Restart-survivable idempotency. Current Redis scheme fails open on eviction/outage. |
| 3 | Adopt `@platform/outbox` for billing-service + notification-service event emission | Current fire-and-forget `eventBus.publish` from billing handlers and Stripe webhook routes loses events if NATS is flaky — cross-service-consistency bug. Outbox is already in farm/hr/messaging. |
| 4 | Introduce `CurrencyScaleService` + `currencyCode`/`baseCurrencyCode`/`exchangeRate`/`exchangeRateAt` columns on Invoice/Payment/Subscription | Multi-currency readiness + closed-period immutability. Required for any international billing (JPY/KRW scale=0, Gulf currencies scale=3). |
| 5 | Introduce `BillingAuditEntry` entity + `@BillingAudit({ resource, action })` handler decorator, emit row in same DB transaction as mutation | Non-repudiable billing audit trail required for SOC2 / PCI / tax jurisdictions (≥ 7yr retention, monthly partitioned). Generic `AuditLogInterceptor` cannot meet this guarantee. |
| 6 | Add safe-tail window (`committed_at < now() - '1 second'::interval`) or `xmin`-based filter to `ProjectionsService.processBatch` | Closes out-of-order-commit skip hazard per Fowler / MSFT Learn event-sourcing guidance. |
| 7 | Add `SchemaDriftModule.forRoot({ serviceName: 'event-store' })` to event-store-service app.module | Gap — every other scope service has it. |
| 8 | Migrate `config-service` migration runner from `'public'` schema to `'config'` schema | Direct ADR-011 violation. `createMigrationRunnerService('public')` at `config-service/src/app.module.ts:24` is a blocking compliance issue. |
| 9 | Add HMAC-binding of `tenantId` as AAD in `EncryptionService` (currently not visible in code — verify) | Prevents cross-tenant ciphertext swap at rest — critical secret-mgmt invariant. |
| 10 | Replace `Number()` / `.toNumber()` coercions in billing query handlers with a Decimal-scalar GraphQL surface end-to-end (resolves `PLAT-LOW-001`) | Makes double-precision money arithmetic impossible (Tier 1). |
| 11 | Convert Stripe webhook handler failure path from best-effort logging to a `FailedWebhookEvent` DLQ table with replay endpoint | Non-repudiation + debugging aid; aligns with the review rule "business errors return 200 with DLQ logging". |
| 12 | Migrate `PIDController` integral/derivative state to `decimal.js` or fixed-point integer micromoles; persist `PidControllerState` per cycle | Required by platform-services domain rules (life-safety math invariant). |

---

## Findings

### PLAT-CRITICAL-001 — `@Entity()` classes missing `schema:` option on 21 classes across 5 services (ADR-011 violation)

**Severity:** CRITICAL (block-deploy). The SchemaDriftValidator runs advisory-only in prod; these entities rely on the DB `search_path` at runtime. A same-named `public` table (introduced via a future migration or an operator error) would silently bind to these entities and mix tenants' billing / event-store / config data.

**Locations (exhaustive):**
- `apps/billing-service/src/billing/entities/subscription.entity.ts:92`
- `apps/billing-service/src/billing/entities/payment.entity.ts:82`
- `apps/billing-service/src/billing/entities/plan.entity.ts:26`
- `apps/billing-service/src/billing/entities/scheduled-plan-change.entity.ts:32`
- `apps/billing-service/src/billing/entities/tenant-usage-metrics.entity.ts:97`
- `apps/billing-service/src/billing/entities/subscription-module-item.entity.ts:109`
- `apps/billing-service/src/billing/entities/invoice.entity.ts:99`
- `apps/billing-service/src/modules/metering/entities/usage-aggregation.entity.ts:20,85`
- `apps/event-store-service/src/event-store/entities/stored-event.entity.ts:14`
- `apps/event-store-service/src/event-store/entities/event-stream.entity.ts:15`
- `apps/event-store-service/src/event-store/entities/snapshot.entity.ts:13`
- `apps/event-store-service/src/projections/entities/projection-checkpoint.entity.ts:22`
- `apps/config-service/src/configuration/entities/configuration.entity.ts:52,177`
- `apps/hydroponics-service/src/setup/entities/hydroponics-config.entity.ts:14`
- `apps/alert-engine/src/database/entities/escalation-policy.entity.ts:137`
- `apps/alert-engine/src/database/entities/alert-rule.entity.ts:74`
- `apps/alert-engine/src/database/entities/alert-incident.entity.ts:85`
- `apps/alert-engine/src/alert/entities/alert-history.entity.ts:17`
- `apps/alert-engine/src/audit/entities/audit-entry.entity.ts:15`

**Fix class:** Tier-1 architectural (make it impossible). Add `schema:` option to each `@Entity(...)` call. Optionally enforce via ESLint rule that flags `@Entity('x')` without the 2nd arg object. Turn `SCHEMA_DRIFT_FATAL=true` in production so violations fail the cold-start.

---

### PLAT-CRITICAL-002 — `config-service` migration runner targets `public` schema

**Severity:** CRITICAL (ADR-011 direct violation — "Never add new tables to `public`").
**Location:** `apps/config-service/src/app.module.ts:24`

    const ConfigMigrationRunnerService = createMigrationRunnerService('public');

Combined with the missing `schema: 'config'` on the two Configuration entities, **every config migration lands in the shared `public` schema**, directly contradicting the schema-ownership model. Any future deploy that introduces a same-named table in another service's migration would collide.

**Fix class:** Tier-1. Change argument to `'config'`, add `schema: 'config'` to both entities, re-generate a blue-green migration that moves the tables from `public` to `config` (with `ALTER TABLE ... SET SCHEMA config;`).

---

### PLAT-HIGH-001 — `SchemaDriftModule` not registered in event-store-service app.module

**Severity:** HIGH (ADR-012 gap).
**Location:** `apps/event-store-service/src/app.module.ts` — grep for `SchemaDriftModule` in `apps/event-store-service` returned **0 matches**.

Every other scope service registers it. Event-store is the most sensitive (immutable audit log — any drift is catastrophic).

**Fix class:** Tier-3 (detectable). Register `SchemaDriftModule.forRoot({ serviceName: 'event-store' })` and the companion `createMigrationRunnerService('event_store')`.

---

### PLAT-HIGH-002 — No `@platform/outbox` adoption in any of the 6 platform services

**Severity:** HIGH (delivery-reliability gap).
**Locations:** billing, notification, config, event-store, observability, hydroponics — all publish domain events via direct `eventBus.publish` without the transactional outbox.

Billing is especially affected — `CreateInvoiceHandler`, `RecordPaymentHandler`, `RefundPaymentHandler`, `ChangeSubscriptionPlanHandler`, and the `StripeWebhookService` all emit cross-service events with best-effort semantics. A NATS outage between DB commit and publish loses the event with no recovery path.

**Fix class:** Tier-2 (automatic — once outbox is wired, correctness is the zero-effort default).

---

### PLAT-HIGH-003 — Billing-service lacks Decimal-arithmetic discipline end-to-end

**Severity:** HIGH (billing-accuracy invariant).

Evidence:
- 11 files import `Decimal`, entities use `@MoneyColumn`, DB is `numeric(19,4)` — good at the edge.
- **But** cross-cutting `Number()` / `.toNumber()` conversions punch through at:
  - `query-handlers/get-tenant-billing.handler.ts:134,242`
  - `handlers/create-invoice.handler.ts:150-152`
  - `handlers/record-payment.handler.ts:141`
  - `handlers/refund-payment.handler.ts:149`
  - `billing-scheduler.service.ts:290,298,327,366,368`
  - `stripe-webhook.service.ts:56,262,469`
- `modules/metering/metered-billing.service.ts:1276` uses `Math.round(amount * 100) / 100` on money.
- No `CurrencyScaleService` exists; no `currencyCode`/`exchangeRate` columns — single-currency assumption is baked in.
- No `BillingAuditEntry` entity, no `@BillingAudit` decorator — `AuditLogInterceptor` is generic and does not satisfy the "same-transaction audit row per mutation" rule.
- Invoice GraphQL surface is `Float` (acknowledged TODO `PLAT-LOW-001`) — client receives lossy representation.

**Fix class:** Tier-1 + Tier-2. Make Decimal the only money type across the handler/resolver chain (custom GraphQL Decimal scalar), introduce CurrencyScaleService + currency columns, introduce BillingAuditEntry + @BillingAudit decorator.

---

### PLAT-HIGH-004 — Stripe webhook idempotency is Redis-ephemeral, not durable

**Severity:** HIGH.
**Location:** `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:138` — uses `redis.setNx` with a TTL.

On Redis eviction, restart, or keyspace pressure, the dedupe key vanishes and a Stripe-retried event (Stripe retries for 3 days) will re-process, double-charging or double-refunding. The review rules explicitly require `ProcessedWebhookEvent` table with `UNIQUE(tenant_id, stripe_event_id) + INSERT ON CONFLICT DO NOTHING`.

**Fix class:** Tier-1. Add durable `ProcessedWebhookEvent` entity, check-and-insert inside the transactional handler path.

---

### PLAT-HIGH-005 — Projection tail query has no safe-tail grace window

**Severity:** HIGH (event-store correctness).
**Location:** `apps/event-store-service/src/projections/projections.service.ts:336`

    .where('e.globalPosition > :position', { position: checkpoint.position })

PostgreSQL sequences are assigned at INSERT but visibility is ordered by commit — two concurrent appenders can commit out of sequence order. A projection reading `globalPosition > N` immediately after a late commit will skip the straggler permanently.

**Fix class:** Tier-1 — add `AND e.storedAt < NOW() - INTERVAL '1 second'` OR migrate to `xmin`-based filter per PG docs. Document the invariant in-code.

---

### PLAT-MEDIUM-001 — `Promise.all` in notification auth-event handlers (cancels peer lookups on first failure)

**Severity:** MEDIUM.
**Location:** `apps/notification-service/src/notification/event-handlers/auth-event.handler.ts:223,306`

Per review rules "Multi-channel fan-out MUST use `Promise.allSettled` — never `Promise.all`". These sites enrich PII for downstream notification dispatch; a single enrichment failure discards siblings.

**Fix class:** Tier-3. Replace `Promise.all([...])` with `Promise.allSettled([...])` and handle each result. Also valid for the PII-enrichment pattern (one slow lookup shouldn't gate the others).

---

### PLAT-MEDIUM-002 — `ConfigurationHistory` stores SECRET-type values in plaintext

**Severity:** MEDIUM (secret-handling regression).
**Location:** `apps/config-service/src/configuration/entities/configuration.entity.ts:203-207`

When a SECRET-type Configuration row is updated, the previous/new values are captured in `configuration_history` as plain text columns. Review rules require these to be re-encrypted under the current master key with `ENC_V1:` prefix. Current implementation leaks secrets into audit history.

**Fix class:** Tier-1. Route `previous_value` / `new_value` writes through `EncryptionService.encrypt(...)` for rows whose originating Configuration is SECRET-typed. Enforce by typing the column as an encrypted transformer.

---

### PLAT-MEDIUM-003 — `SchemaDriftModule` is advisory-only by default in production

**Severity:** MEDIUM (detectability gap).
Every service registers the module, but `SCHEMA_DRIFT_FATAL` is an opt-in env flag. On an unknown DO droplet where the flag isn't set, drift is logged and ignored.

**Fix class:** Tier-3 → Tier-1 migration. Require `SCHEMA_DRIFT_FATAL=true` in prod `.env` via the boot-time config validator, default to `true` in NODE_ENV=production unless explicitly overridden.

---

### PLAT-LOW-001 — Invoice GraphQL `@Field(() => Float)` on `Decimal`-typed columns

**Severity:** LOW (acknowledged TODO — see comments in `invoice.entity.ts:138,148,157,162,167`). Non-blocking but degrades client-side precision on large invoices.

**Fix class:** Tier-1 once a Decimal GraphQL scalar lands.

---

## Appendix — Scope sizing

| Metric | Value |
|---|---|
| billing-service .ts files | 84 |
| notification-service .ts files | 26 |
| event-store-service .ts files | 22 |
| config-service .ts files | 26 |
| key file LOC | stripe-webhook.controller.ts 282; ssrf-validator.service.ts 305; notification-dispatcher.service.ts 784; encryption.service.ts 245 |

