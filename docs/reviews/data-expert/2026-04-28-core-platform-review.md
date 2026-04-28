# data-expert — review — 2026-04-28-core-platform-review

## Scope

Delta review of the core/cross-cutting data surface — `libs/event-contracts/**`, `libs/backend-common/src/database/**`, `database/migrations/**`, `platform/libs/outbox/**`, plus per-service migration directories that gate the auth / tenant-provisioning / billing stack — at branch `main` @ `a958dc66`. User scoped this cycle to **core/cross-cutting platform concerns** (auth, tenant provisioning, isolation, billing); domain modules (farm, sensor, hr) are out of scope for new findings here, but their event contracts and outbox state ride on these shared surfaces and so are inspected for cross-handoff impact. Sibling reviews from auth-security-expert (SEC-CRITICAL-001/-004), billing-expert (BILLING-CRITICAL-002/-003 + HIGH-001/-002/-005), platform-kernel-expert (PLAT-CRITICAL-002 NatsEventBus type-lie), and database-reviewer (DBR-CRITICAL-003 dual migration trees) were read for context — confirmations are flagged inline; no duplicates are raised.

## Executive summary

W1 BLOCKER-8 (`@Entity('x')` without `schema:`) is **substantively closed** — every backend `@Entity()` decorator now declares its schema; only 9 grep hits remain and they are all comments / code-doc references. Schema-drift validator + migration-runner discipline is sound; per-checkout `search_path` reset (`TenantConnectionBootstrap`) and per-migration session-level `SET search_path` re-assertion in `MigrationRunnerService` correctly defend the 2026-04-07 split-brain class. Upcaster-chain invariant test (`tests/invariants/upcaster-chain.spec.ts`) is in place. **However**, the cross-cutting surface ships four unresolved CRITICAL issues that BLOCK merge: (1) `SchemaManagerService.createTenantSchema` / `deleteTenantSchema` use **session-scoped `pg_advisory_lock`** through `dataSource.query` (each call grabs a different pool connection — lock taken on conn A, attempted unlock on conn C — locks LEAK and concurrent provisioning eventually deadlocks); (2) `TenantSchemaSyncService` runs `CREATE TABLE … LIKE` and `ALTER TABLE ADD COLUMN` on every service boot **outside the migration ledger** — `synchronize()` under a different name, in direct violation of ADR-011 + ADR-012 + INFRA-CRITICAL-009 precedent; (3) **event contracts type cross-process timestamp fields as `Date`** (37+ occurrences across billing/tenant/farm/HR) — directly contradicts `BaseEvent.timestamp: string`, the JSONB wire format, AND the explicit comment in `OutboxEntityBase.payload` (this is the kernel-level type-lie platform-kernel-expert flagged in PLAT-CRITICAL-002, **extended** to the contracts themselves not just `NatsEventBus.deserializeEvent`); (4) outbox adoption is **3 of 15 services** — auth, billing, admin-api, notification, sensor, alert, ai, hydroponics, gateway-api, config publish events directly via `eventBus.publish`, breaking the atomic "persist + publish" guarantee. Stripe webhook ingest has no persistent dedupe table; `RefreshTokenReuseDetected` event requested by auth-security-expert is **not in the contract catalog** at all. Verdict: **BLOCK**.

## Findings (by severity)

### CRITICAL

#### DATA-CRITICAL-001 — Session-scoped `pg_advisory_lock` leaks across pool checkouts in `SchemaManagerService`

**Severity:** CRITICAL
**Layer:** 2 (advisory-lock pattern) + 3 (data-expert agent invariant)
**State:** OPEN

**Evidence**
- `libs/backend-common/src/database/schema-manager.service.ts:681` — `await this.dataSource.query(\`SELECT pg_advisory_lock($1)\`, [lockKey]);` (createTenantSchema)
- `libs/backend-common/src/database/schema-manager.service.ts:876` — `await this.dataSource.query(\`SELECT pg_advisory_unlock($1)\`, [lockKey]);` in `finally`
- `libs/backend-common/src/database/schema-manager.service.ts:1032,1051` — same pattern in `deleteTenantSchema`
- The `try` body (lines 700–873) issues 8+ separate `dataSource.query(...)` calls (`CREATE SCHEMA`, `CREATE TABLE … LIKE`, `GRANT USAGE`, `GRANT ALL PRIVILEGES …`, `DROP SCHEMA … CASCADE` on rollback). Every `dataSource.query()` checks out a fresh pool connection.

**Rule violated**
- Data-expert agent invariant (`.claude/agents/data-expert.md`): *"`SchemaManagerService.createTenantSchema` advisory-lock sequence: … **release advisory lock in `finally`**. Session-scoped lock leaked across pool checkout = CRITICAL (contaminates next caller). Use `pg_advisory_xact_lock()` where the work fits in one transaction (auto-releases on COMMIT/ROLLBACK)."*
- Layer-1 TypeORM rule: every `dataSource.query(...)` is a fresh pool checkout. `pg_advisory_lock()` is session-scoped — only releasable from the same backend session.

**Why it bites**
`pg_advisory_lock` taken on connection A → connection released to pool → next `query()` checks out connection B → CREATE SCHEMA runs → … → eventually `pg_advisory_unlock` runs on connection C. PostgreSQL silently no-ops the unlock on C (lock not held there). The lock on A persists until A's session ends (pool eviction / process death). With pool size 10 and 10 concurrent provisions, every advisory lock leaks; the 11th provisioning request blocks on `pg_advisory_lock` indefinitely. The lock-leak is **invisible** under low concurrency — it surfaces as "tenant provisioning hangs forever" only when the pool is saturated, which is exactly when it's hardest to debug.

**Proposed fix direction**
- Tier-1 architectural fix: switch to `dataSource.transaction(async manager => { await manager.query('SELECT pg_advisory_xact_lock($1)', [lockKey]); … })` so the lock binds to the transaction (auto-releases on COMMIT/ROLLBACK). All DDL inside the transaction reuses the same connection by construction. Cleanup-on-failure (`DROP SCHEMA … CASCADE`) belongs inside the transaction or in a separate post-rollback retry path.
- If wrapping all of `createTenantSchema` in a single transaction is structurally infeasible (long-running, multi-second TimescaleDB hypertable conversion), pin a `QueryRunner`: `const qr = dataSource.createQueryRunner(); await qr.connect(); await qr.query('pg_advisory_lock'); … finally { await qr.query('pg_advisory_unlock'); await qr.release(); }`. `qr` keeps the same physical connection from acquire to release.

**Affected surface (ripple set)**
- `libs/backend-common/src/database/schema-manager.service.ts` — both `createTenantSchema` and `deleteTenantSchema`
- `libs/backend-common/src/database/__tests__/schema-manager.service.spec.ts` — concurrent-provision regression test that asserts lock count returns to 0
- `tests/invariants/` — structural lint that flags `dataSource.query.*pg_advisory_lock\b` (allow only `pg_advisory_xact_lock` or `queryRunner.query`)

**Expected closer**
data-expert WRITER mode (kernel-internal fix). Pair-review by `multi-tenant-saas-expert` (tenant provisioning is the load-bearing path).

---

#### DATA-CRITICAL-002 — `TenantSchemaSyncService` runs runtime DDL on every boot, parallel to the migration runner

**Severity:** CRITICAL
**Layer:** 3 (ADR-011, ADR-012, INFRA-CRITICAL-009 precedent) + 2 (synchronize-anti-pattern)
**State:** OPEN

**Evidence**
- `libs/backend-common/src/database/tenant-schema-sync.service.ts:96-102` — `CREATE TABLE IF NOT EXISTS "${tenantSchema}"."${tableName}" (LIKE "${mod.sourceSchema}"."${tableName}" INCLUDING ALL)` issued from `OnApplicationBootstrap`
- `libs/backend-common/src/database/tenant-schema-sync.service.ts:138-141` — `ALTER TABLE "${tenantSchema}"."${tableName}" ADD COLUMN IF NOT EXISTS "${col.column_name}" ${dataType} ${effectiveNull} ${defaultClause}`
- `libs/backend-common/src/database/tenant-schema-sync.service.ts:121-145` — column metadata sourced from `pg_attribute`/`information_schema`; `col.column_name` and `col.full_data_type` are interpolated raw into the `ALTER TABLE` string with **no `validateSqlIdentifier()` call**. `defaultClause` is interpolated raw from `pg_get_expr(d.adbin, …)`.

**Rule violated**
- ADR-011 (Schema Ownership): structural changes belong in migrations, not in runtime `OnApplicationBootstrap` hooks.
- ADR-012 (Schema Drift Prevention): the drift detector exists precisely to FAIL CLOSED on entity↔DB skew; auto-applying drift at boot is the inverse contract — drift is *generated* at boot rather than detected.
- INFRA-CRITICAL-009 precedent (`source-schema-bootstrap.service.ts:166-174`): legacy `dataSource.synchronize()` was removed and replaced with a **hard-fail** when source-schema tables are missing. `TenantSchemaSyncService` re-introduces the same anti-pattern in a different guise.
- Layer-1 TypeORM rule: identifier interpolation MUST validate against `SAFE_SQL_IDENTIFIER`.

**Why it bites**
The migration ledger (`typeorm_migrations` per tenant schema) is bypassed: tables and columns appear without a corresponding migration row, so a future `MigrationRunnerService` run sees the per-tenant schema as drift-free even though the change was applied silently at boot. If a developer later writes the proper migration that adds the same column, the migration's own `IF NOT EXISTS` may swallow the conflict — but the migration timestamp is now LATER than the actual change, breaking the audit trail. Worst case: the boot-time `ALTER` partially fails (NOT NULL without default on populated table → exception), the service swallows it as "non-fatal", leaving an inconsistent schema across tenants that the drift validator then surfaces as a permanent drift incident.

**Proposed fix direction**
- Tier-1 architectural fix: **delete `TenantSchemaSyncService`**. Replace with the migration-runner's tenant fan-out (`MigrationRunnerService.executeForTenants` already exists). Per-tenant schema changes ride the same migration files as source-schema changes; the runner walks `tenant_*` schemas and applies pending migrations using the migration ledger.
- Tier-3 fallback (only if delete is too disruptive in the same PR): convert the service to **detect-only** — log a CRITICAL drift incident for every missing table/column, never `CREATE`/`ALTER`. The DDL path becomes a hand-authored migration.
- Either path closes the silent-drift channel and the unvalidated identifier interpolation in one move.

**Affected surface (ripple set)**
- `libs/backend-common/src/database/tenant-schema-sync.service.ts` — delete or convert
- Every `app.module.ts` that registers `TenantSchemaSyncService` as a provider
- `tests/invariants/` — adoption-invariant assertion: no service boot path may issue raw `CREATE TABLE` / `ALTER TABLE` outside `MigrationRunnerService`
- A new migration that captures any drift currently being silently fixed at boot

**Expected closer**
data-expert WRITER mode + `multi-tenant-saas-expert` review. Skill: `add-entity-field` (W5) is the correct future authoring path for the diffs this service was papering over.

---

#### DATA-CRITICAL-003 — Event contracts type cross-process timestamps as `Date`, contradicting `BaseEvent.timestamp: string` and the JSONB wire format (extends PLAT-CRITICAL-002)

**Severity:** CRITICAL
**Layer:** 3 (ADR-006 flat pattern + wire-format invariant) + 1 (compile-time contract integrity)
**State:** OPEN — extends `platform-kernel-expert` PLAT-CRITICAL-002

**Evidence**
- `libs/event-contracts/src/billing-events.ts:43,57,72,73,104,119,120,121,135,166,178` — 11 `Date` typed fields (`startDate`, `cancellationDate`, `effectiveEndDate`, `effectiveDate`, `dueDate`, `billingPeriodStart`, `billingPeriodEnd`, `paidAt`, `refundedAt`, etc.) on `SubscriptionCreatedEvent`, `SubscriptionUpdatedEvent`, `SubscriptionCancelledEvent`, `SubscriptionPlanChangedEvent`, `InvoiceGeneratedEvent`, `PaymentReceivedEvent`, `PaymentRefundedEvent`, `InvoiceOverdueEvent`
- `libs/event-contracts/src/tenant-events.ts:146` — `TenantSubscriptionChangedEvent.effectiveDate: Date`
- `libs/event-contracts/src/farm-events.ts` — 26 `Date` typed fields across batch / mortality / harvest / transfer / feeding / measurement / closure / cancellation / migration / soft-delete events
- `libs/event-contracts/src/base-event.ts:38-46` — `BaseEvent.timestamp: string` with the docblock *"WHY string not Date: JSONB serialization converts Date to ISO 8601 string on the wire. Declaring Date here makes the TypeScript interface lie about the runtime type."*
- `platform/libs/outbox/src/outbox-entity.base.ts:62-68` — `payload: IEvent` stored as `jsonb`; explicit comment *"Date fields (timestamp, mortalityDate, etc.) are stored as ISO 8601 strings after JSON serialization."* — the contracts know the wire form is string but still declare Date
- `libs/event-contracts/src/upcasters/index.ts:28-33` — `TIMESTAMP_BUMP_EVENTS = ['BatchStatusChanged', 'SensorCalibrated', 'AlertEscalated', 'ModuleRemovedFromTenant']` — only **4** of the 37+ Date-typed events have a timestamp upcaster

**Rule violated**
- ADR-006 + `BaseEvent` docblock + agent invariant: events are wire-format objects; field types must reflect what crosses the bus. `Date` does not survive `JSON.stringify` — it serializes to string. Declaring `Date` in the interface means any consumer that does `event.startDate.toISOString()` after a NATS deserialize crashes with `event.startDate.toISOString is not a function`. The contract lies; the kernel patches the lie at deserialization (PLAT-CRITICAL-002 — `NatsEventBus.deserializeEvent` re-coerces string to Date for Date-typed fields).
- Kernel-level coercion is the symptom, not the fix. The fix is at the contract layer.

**Why it bites**
- Producers running `createBaseEvent('PaymentReceived', tenantId)` and assigning `paidAt: new Date()` work locally because the producer-side Date is real before serialization. The moment the event is replayed from JetStream or read from `outbox.payload` JSONB, `paidAt` is a string. Every consumer that touches `.toISOString()` / `.getTime()` / `.getDate()` on a Date-typed contract field is either crashing in production (silent — try/catch swallows) or the kernel is silently patching every consumer's expectation in `NatsEventBus.deserializeEvent`. The latter is happening; that itself is the sign the contract is wrong.
- Outbox path: `OutboxEntityBase.payload: jsonb` is `JSON.stringify`-d on insert and `JSON.parse`-d on read. After the round-trip, every Date-typed field is a string. `OutboxPublisher` then publishes the parsed (string-fielded) event to NATS. If consumers were relying on Date semantics, they broke at outbox-write time.
- Upcaster coverage: only 4 events get the `Date → string` normalization upcaster. The remaining 37+ either were never broken (because they always rode the JSONB wire and consumers never `.toISOString()`'d them) or are silently corrupted on every replay.

**Proposed fix direction**
- Tier-1 architectural fix: **flip every `: Date` field in `libs/event-contracts/src/*.ts` to `: string` (ISO 8601)**. Mechanical (search-replace `: Date` → `: string` and `?: Date` → `?: string` across `*-events.ts`, with a per-file review for non-event Date references). Producers that hold a Date object call `.toISOString()` at the construction site (one-line change per producer). Consumers stop relying on Date methods and either parse on demand or work with strings throughout.
- Add timestamp-Date→string upcasters for every event currently typed as Date (or, since the wire form has always been string, declare a single repo-wide upcaster wave that bumps `version` from N→N+1 for every affected eventType — cheaper than per-event upcasters because the transformation is identity on the wire data).
- W6 invariant test extension: a structural test that asserts `grep -E ': Date(\\?|\\b)' libs/event-contracts/src/*-events.ts` returns zero matches.
- Once this lands, `NatsEventBus.deserializeEvent`'s string-to-Date re-coercion (PLAT-CRITICAL-002) is unnecessary and SHOULD be removed in the same PR — the type-lie evaporates structurally.

**Affected surface (ripple set)**
- `libs/event-contracts/src/billing-events.ts`, `tenant-events.ts`, `farm-events.ts`, `hr-events.ts` (timestamps), every other `*-events.ts` with a Date field
- `libs/event-contracts/src/upcasters/` — add identity timestamp upcasters per event type, OR a single repo-wide upcaster
- `libs/event-contracts/src/upcasters/index.ts` — register
- `tests/invariants/upcaster-chain.spec.ts` — coverage extension
- Every producer that writes `paidAt: new Date()` etc. — convert to `.toISOString()`. Search expression: `\b(paidAt|startDate|effectiveDate|dueDate|billingPeriodStart|billingPeriodEnd|refundedAt|cancellationDate|cancelledAt|harvestedAt|stockedAt|mortalityDate|culledAt|deletedAt|measurementDate|feedingDate|consumedAt|closedAt|deployedAt|removedAt|transferredAt|allocationDate|adjustedAt|migrationStartedAt|migrationCompletedAt|convertedAt|observedAt|expiryDate|manufacturingDate|receivedDate|transferDate|updatedAt|newExpectedHarvestDate)\\s*:\\s*new Date\\(`
- `libs/backend-common/src/nats/nats-connection.factory.ts` and `platform/libs/event-bus/src/nats-event-bus.ts` — confirm/update `deserializeEvent` once contract is fixed (joint with PLAT-CRITICAL-002)

**Expected closer**
data-expert WRITER mode (contract layer) + platform-kernel-expert WRITER mode (kernel side) — coordinated via `implementation-planner`. Cross-domain CATCHER pair: every domain expert whose service produces affected events.

---

#### DATA-CRITICAL-004 — Outbox adoption is 3 of 15 services; auth, billing, admin-api, notification, sensor, alert all bypass outbox

**Severity:** CRITICAL
**Layer:** 3 (ADR-006 + W7 ESLint `no-direct-event-publish`) + 2 (transactional outbox pattern)
**State:** OPEN — extends W1 DATA-HIGH-004 with billing-expert BILLING-CRITICAL-002 confirmation

**Evidence**
- `OutboxEntityBase` subclasses present: `apps/farm-service/src/outbox/farm-outbox.entity.ts`, `apps/hr-service/src/hr/entities/hr-outbox.entity.ts`, `apps/messaging-service/src/outbox/messaging-outbox.entity.ts`. **3 services**.
- Direct `eventBus.publish` outside `@platform/outbox`:
  - `apps/auth-service/src/modules/authentication/services/authentication.service.ts:177,375,583,1024,1128` — 5 publishes including login + token-related events
  - `apps/auth-service/src/modules/tenant/services/tenant.service.ts:217`, `user-lifecycle.service.ts:969`
  - `apps/billing-service/src/billing/billing-scheduler.service.ts:78,151` — `SubscriptionPastDue` and `SubscriptionExpired` published outside any DB transaction
  - `apps/billing-service/src/billing/controllers/stripe-webhook.service.ts:270` — `PaymentFailed` published from inside `dataSource.transaction(...)` callback BUT after `manager.save(Payment, ...)` — at-most-once if NATS is down post-commit
  - `apps/admin-api-service/src/tenant/handlers/{create,suspend,update}-tenant.handler.ts` — 9 publishes covering `TenantCreated`, `TenantSuspended`, `TenantArchived`, `TenantStatusChanged`, `TenantActivated`
  - `apps/notification-service/src/notification/event-handlers/{task-event,alert-triggered,messaging-event}.handler.ts` — 3 publishes
- Total bypass surface: 14+ services × multiple publish sites each. The W7 ESLint rule `no-direct-event-publish` is not yet active.

**Rule violated**
- Layer-2 outbox pattern + agent invariant: *"`eventBus.publish` / `natsClient.publish` outside `@platform/outbox` implementation = CRITICAL (W7 `no-direct-event-publish` ESLint rule — DATA-HIGH-004 + BLOCKER-20 family)."*
- ADR-006: events must be persisted alongside the business state change atomically.

**Why it bites**
The `dataSource.transaction(async manager => { … manager.save(Payment); await eventBus.publish(...); })` pattern in `stripe-webhook.service.ts` is the textbook outbox-required case: the event-bus `publish()` typically returns immediately (NATS publish is fire-and-forget unless using JetStream `publishAck`). DB commits, NATS publish lands in a buffer, NATS connection drops, buffered message lost, **consumer never sees the payment event**. Reconciliation between billing's Payment table and notification-service / admin-api dashboards drifts silently. This is exactly billing-expert's BILLING-CRITICAL-002.

**Proposed fix direction**
- Tier-2 (make automatic): each of the 12 missing services declares its own `<svc>Outbox extends OutboxEntityBase` entity, registers `OutboxModule.forFeature(<svc>Outbox)`, and replaces every `eventBus.publish(event)` with `outboxPublisher.publish(event, { manager })` (so the row is inserted in the same transaction as the business change).
- Tier-3 (immediate gate): land the W7 ESLint rule `no-direct-event-publish` ASAP — even if it's a per-service convergence, the rule prevents NEW direct-publish sites from being added while the rolling fix progresses. Allowlist the outbox-internal files only.
- Same migration wave: each new outbox table needs its own migration with the standard envelope (`SET LOCAL lock_timeout`, `SET LOCAL search_path`).

**Affected surface (ripple set)**
- 12 service `app.module.ts` files
- 12 new `<svc>-outbox.entity.ts` + `<svc>-outbox.module.ts` files
- 12 new migrations creating `<svc>_outbox` table
- All ~50 direct `eventBus.publish` callsites identified above
- `eslint.config.mjs` — register `no-direct-event-publish` rule
- `tests/invariants/` — adoption invariant: `OutboxModule.forFeature` registered in every service that publishes domain events

**Expected closer**
This is W7 BLOCKER-20 family. `implementation-planner` composes the 12-service convergence DAG; per-service WRITER pair = the respective domain expert + data-expert CATCHER on each migration.

### HIGH

#### DATA-HIGH-001 — `database/migrations/core/V*.sql` + `database/migrations/modules/*/V*.sql` is a parallel ghost migration tree contradicting ADR-011

**Severity:** HIGH
**Layer:** 3 (ADR-011) + 4 (documented landmine)
**State:** OPEN — confirms `database-reviewer` DBR-CRITICAL-003

**Evidence**
- `database/migrations/core/V004__add_subscription_table.sql:5` — `CREATE TABLE IF NOT EXISTS public.subscriptions (...)` — places `subscriptions` in `public` schema
- `apps/billing-service/src/billing/entities/subscription.entity.ts:92` — `@Entity('subscriptions', { schema: 'billing' })` — entity declares `billing` schema
- `database/migrations/core/V005__add_audit_table.sql`, `V006__add_tenant_tracking_columns.sql`, `V007__seed_provisioning_config.sql` — all SQL files have content; the workflow comment at `.github/workflows/db-migration-check.yml:21-27` claiming *"9 of the 13 SQL files in that tree are empty (0 bytes)"* is **factually wrong** (every file is 281–2491 bytes; module files 762–5598 bytes)
- No runtime path executes these SQL files. The CI workflow that *would* validate them was deleted.

**Rule violated**
- ADR-011: every entity table has ONE owning schema. Parallel migration trees that disagree create deterministic-ground-truth ambiguity — the entity says `billing.subscriptions`, the SQL says `public.subscriptions`. If anyone ever ran Flyway against the SQL tree, they'd create a `public.subscriptions` table that the live runner would never see and never update.
- Workflow comment on the wrongly-marked-as-empty files is a Tier-4 documentation rot vector.

**Proposed fix direction**
- Tier-1 architectural fix: **delete `database/migrations/` entirely**. Git history preserves the old design for archaeologists. Add a top-level `database/README.md` (one-liner) pointing at `apps/<svc>/src/database/migrations/` per ADR-011.
- Update the CI workflow comment to reflect deletion, OR delete the workflow comment along with the files.
- Add `tests/invariants/migration-tree-uniqueness.spec.ts` that fails if `database/migrations/**/*.sql` returns any matches.

**Affected surface (ripple set)**
- `database/migrations/` (delete tree)
- `.github/workflows/db-migration-check.yml` (update or remove the `# 2.` block referencing the deleted Flyway tree)
- `tests/invariants/migration-tree-uniqueness.spec.ts` (new)
- Cross-handoff confirmation only with database-reviewer DBR-CRITICAL-003 (no separate ID)

**Expected closer**
data-expert WRITER mode + database-reviewer CATCHER. Delete-only PR; trivial.

---

#### DATA-HIGH-002 — `RefreshTokenReuseDetected` event is missing from the contract catalog

**Severity:** HIGH
**Layer:** 3 (ADR-006 + auth-security cross-handoff request)
**State:** OPEN — direct cross-handoff from auth-security-expert

**Evidence**
- `libs/event-contracts/src/security/security-events.ts` — 10 security event interfaces declared (`AuthLoginFailed`, `AuthLoginSuccess`, `AuthTokenRejected`, `AuthTokenBlacklisted`, `AuthPasswordReset`, `RateLimitExceeded`, `CspViolation`, `TenantAccessDenied`, `ServiceIdentityRejected`, `SuspiciousActivity`); **no `RefreshTokenReuseDetected`**
- `libs/event-contracts/src/security/security-events.ts:9-20` — `SecurityEventType` enum has no entry for refresh-token reuse
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts:646-697` (`refreshToken`) and `:709-…` (`refreshTokenWithHash`) — refresh-token rotation present (`SELECT FOR UPDATE` on the token row, mark `isRevoked = true`), **no reuse detection**: a request that presents an already-revoked token is rejected with the generic `UnauthorizedException` and produces no event. There is no token-family / chain-of-custody concept. A successfully replayed (reused) token is therefore indistinguishable from a stale or expired one in the audit trail.

**Rule violated**
- ADR-006 flat-pattern: every domain event must have a typed contract before any producer emits it.
- Auth-security-expert SEC-CRITICAL-001 cross-handoff: refresh-token reuse is a token-theft signal; suppression in the audit trail violates the security-event taxonomy.

**Proposed fix direction**
- Tier-1 architectural fix: add `RefreshTokenReuseDetectedEvent` interface to `libs/event-contracts/src/security/security-events.ts`. Shape (extends `SecurityEventCommon`):
  - `eventType: 'RefreshTokenReuseDetected'`
  - `securityEventType: SecurityEventType.AUTH_REFRESH_TOKEN_REUSE` (new enum entry)
  - `userId: string` (reused token's owner)
  - `tokenJti?: string` (the reused token's JTI; opaque hash if hashed-tokens are enabled)
  - `revokedAt?: string` (when the token had been previously revoked; ISO 8601 string per DATA-CRITICAL-003)
  - `tokenFamilyId?: string` (the token-family identifier that should accompany rotation; introduces the family concept)
  - `cryptoShredKeyId: string` (mandatory — any user-identifying field present)
- Same PR adds the auth-service producer call and the corresponding refresh-token-family table migration in `apps/auth-service/src/database/migrations/`. Authoring this without the auth-side implementation produces an unused contract — both halves must ship together.

**Affected surface (ripple set)**
- `libs/event-contracts/src/security/security-events.ts`
- `libs/event-contracts/src/security/index.ts`
- `libs/event-contracts/src/__tests__/` (new spec)
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts` (producer)
- `apps/auth-service/src/database/migrations/<ts>-AddRefreshTokenFamilyTracking.ts`
- Cross-handoff: closes auth-security-expert SEC-CRITICAL-001 contract surface

**Expected closer**
auth-security-expert WRITER mode (auth-side implementation) + data-expert WRITER mode (contract). Pair-review by the other.

---

#### DATA-HIGH-003 — Stripe webhook ingest has no persistent dedupe table (Redis-only); confirms BILLING-CRITICAL-003

**Severity:** HIGH
**Layer:** 3 (webhook-ingest trust-boundary contract)
**State:** OPEN — confirms billing-expert BILLING-CRITICAL-003

**Evidence**
- `apps/billing-service/src/billing/controllers/stripe-webhook.service.ts:36` — `@Optional() private readonly redisService?: RedisService` — Redis is optional and may be absent in production
- `apps/billing-service/src/billing/controllers/stripe-webhook.service.ts:217-229` — fallback dedupe on payment-failed path is `findOne(Payment, { where: { stripePaymentIntentId, status: PaymentStatus.FAILED } })` — natural-key dedupe on the Payment side-effect, NOT on the Stripe event ID. Webhooks that produce multiple side-effects per event (e.g. `invoice.payment_succeeded` updates Invoice + creates Payment + emits NATS) cannot rely on per-side-effect natural keys; only a `(stripeEventId UNIQUE)` constraint catches the idempotency boundary correctly.
- No `apps/billing-service/src/database/migrations/*StripeWebhookEvent*` migration; no `StripeWebhookEvent` entity.

**Rule violated**
- Webhook ingest is a trust boundary; idempotency MUST be persistent. Redis is an optimization layer, not a correctness layer.
- Layer-2 outbox/dedupe pattern: a `processed_webhook_events` table with `stripeEventId UNIQUE` + `INSERT … ON CONFLICT (stripe_event_id) DO NOTHING RETURNING id` is the canonical shape; `RETURNING` empty means already processed.

**Proposed fix direction**
- Add `billing.processed_webhook_events` table (columns: `stripe_event_id varchar(255) PRIMARY KEY`, `event_type varchar(100) NOT NULL`, `received_at timestamptz NOT NULL DEFAULT NOW()`, `processed_at timestamptz`, `payload_hash varchar(64)`, optional `error_count int`).
- New migration in `apps/billing-service/src/database/migrations/`. Standard envelope with `SET LOCAL lock_timeout`, `SET LOCAL search_path = 'billing'`.
- `StripeWebhookService.handleEvent` opens the transaction with `INSERT INTO billing.processed_webhook_events (...) ON CONFLICT DO NOTHING RETURNING stripe_event_id`. If no row returned, idempotent skip. If returned, proceed in the same transaction; `processed_at = NOW()` updated on success.

**Affected surface (ripple set)**
- `apps/billing-service/src/billing/entities/stripe-webhook-event.entity.ts` (new)
- `apps/billing-service/src/database/migrations/<ts>-CreateStripeWebhookEventsTable.ts` (new)
- `apps/billing-service/src/billing/controllers/stripe-webhook.service.ts` — inject the repo, dedupe-then-process path
- `tests/invariants/webhook-dedupe.spec.ts` — assert any `Stripe.Webhook.constructEvent`-fed handler runs through the dedupe table

**Expected closer**
billing-expert WRITER (closes BILLING-CRITICAL-003) + data-expert CATCHER on the migration.

---

#### DATA-HIGH-004 — `SubscriptionPastDue` and `SubscriptionExpired` events emitted with no contract interface

**Severity:** HIGH
**Layer:** 1 (branded EventId is constructable on any string eventType — type-safety regression)
**State:** OPEN — new finding this cycle

**Evidence**
- `apps/billing-service/src/billing/billing-scheduler.service.ts:79` — `...createBaseEvent('SubscriptionPastDue', sub.tenantId)` — string literal eventType, no interface declared
- `apps/billing-service/src/billing/billing-scheduler.service.ts:152` — `...createBaseEvent('SubscriptionExpired', sub.tenantId)` — same
- `libs/event-contracts/src/billing-events.ts` — `SubscriptionPastDueEvent` and `SubscriptionExpiredEvent` interfaces are absent from the file AND from the `BillingEvent` union AND from `AnyPlatformEvent`
- No consumer found anywhere in `apps/` or `libs/` — these events have no subscriber

**Rule violated**
- ADR-006 + agent invariant: every event must have a typed interface. `createBaseEvent<T>(...)` accepts any string for `eventType` because `T` defaults to `BaseEvent`, so the type system silently allows the construction.
- The branded EventId catches "you forgot the factory"; the typing of `T` was supposed to also catch "you used an undeclared eventType" — but the default-to-BaseEvent loophole defeats it.

**Proposed fix direction**
- Tier-1 architectural fix: tighten `createBaseEvent` so `T` cannot fall back to `BaseEvent`. Two options:
  (a) Require a non-defaulted type parameter — `createBaseEvent<T extends BaseEvent>(eventType: T['eventType'], …)` with no default. Compile breaks at every undeclared usage.
  (b) Declare a global `type AllEventTypes = AnyPlatformEvent['eventType']` and constrain the first parameter to `eventType: AllEventTypes`. Adding a new event without registering it in `AnyPlatformEvent` becomes a compile error.
- Add `SubscriptionPastDueEvent` + `SubscriptionExpiredEvent` interfaces (extends `BaseEvent`, with `eventType` literal + the `subscriptionId`, `previousStatus`, `newStatus` fields the producer is currently passing).
- Wire the new types into `BillingEvent` union and `AnyPlatformEvent`.

**Affected surface (ripple set)**
- `libs/event-contracts/src/billing-events.ts` (add interfaces + union members)
- `libs/event-contracts/src/base-event.ts` (tighten `createBaseEvent` signature — Tier-1 lock)
- `libs/event-contracts/src/index.ts` (re-export)
- 278+ event-construction sites recompile (most pass; any that don't reveal more invisible undeclared events)
- `tests/invariants/event-type-coverage.spec.ts` (new) — structurally asserts every `eventType` literal in `apps/**/*.ts` matches a declared interface

**Expected closer**
data-expert WRITER mode. Pair: billing-expert (validates the new event shapes match producer intent).

---

#### DATA-HIGH-005 — JSON-Schema runtime validation covers 3 of 18 event domains; auth/billing/security/tenant/notification all unvalidated at trust boundary

**Severity:** HIGH
**Layer:** 3 (event-contracts validation invariant, AUDIT-PACT-001 V1 gating mechanism)
**State:** OPEN — escalates W1 DATA-MEDIUM-004 (8/9 → 15/18 unvalidated)

**Evidence**
- `libs/event-contracts/src/schemas/index.ts` — exports validators only for `farm`, `sensor`, and `ingest-backend-policy`
- Event domains in `libs/event-contracts/src/`: `auth`, `tenant`, `farm`, `sensor`, `alert`, `notification`, `hr`, `billing`, `ai`, `task`, `edge-device`, `water-quality`, `messaging`, `storage`, `security`, `schema-migration`, `ingest-backend-policy`. **15 of 18 domains have no AJV validator.**
- Auth events (login success/fail, token rejection), billing events (payment received/failed, refund), tenant events (provisioning failed), security events (refresh-token reuse — pending DATA-HIGH-002, login failed) are unvalidated when consumed off NATS.

**Rule violated**
- AUDIT-PACT-001 + agent invariant: pre-V1, JSON-Schema validation at NATS trust-boundary is the **gating mechanism** in lieu of consumer-driven contract testing. Missing schema = silent contract drift.
- Cross-trust-boundary events (auth/security in particular) are the highest-stakes class — a malformed `AuthLoginFailedEvent` from a misconfigured producer either crashes the consumer's structured logger or silently drops alerts.

**Proposed fix direction**
- Mechanical: per domain add `<domain>-events.schema.ts` (AJV `JSONSchemaType<T>` with `additionalProperties: false`), wire into `validator.ts` and `schemas/index.ts`. Pattern matches existing `farm-events.schema.ts` / `sensor-events.schema.ts`.
- Each NATS subscriber on a trust-boundary path validates inbound payload before deserializing; reject (NACK + log security event) on invalid.
- W6 deliverable: structural invariant — every member of `AnyPlatformEvent` has a corresponding entry in some `<domain>-events.schema.ts` file.

**Affected surface (ripple set)**
- 15 new `<domain>-events.schema.ts` files
- `libs/event-contracts/src/schemas/validator.ts` (register validators)
- Every NATS bridge currently going from raw payload to typed event without schema validation
- `tests/invariants/event-schema-coverage.spec.ts` (new — 1:1 union ↔ schema)

**Expected closer**
data-expert WRITER mode (mechanical authoring). Skill candidate: `add-event-schema` skill (W5 follow-up).

---

#### DATA-HIGH-006 — Session-scoped `SET search_path` (no `LOCAL`) in messaging migrations 1782300000000 and 1782400000000 (W1 DATA-HIGH-003 still open)

**Severity:** HIGH
**Layer:** 3 (migration envelope rule + 2026-04-07 incident class)
**State:** OPEN — W1 DATA-HIGH-003 unchanged

**Evidence**
- `apps/messaging-service/src/migrations/1782300000000-AddTenantIdToMessageChildren.ts:76,197` — `await queryRunner.query(\`SET search_path TO "messaging", public\`)` (no `LOCAL`)
- `apps/messaging-service/src/migrations/1782400000000-EnableRowLevelSecurity.ts:79,99` — same pattern

**Rule violated**
- Layer-1 TypeORM migration discipline: inside a migration transaction, `SET LOCAL search_path = 'messaging', public` is the only acceptable form. Session-scoped `SET` persists across the BEGIN/COMMIT and contaminates the connection on its way back to the pool — the exact 2026-04-07 farm-service split-brain root cause.

**Why still HIGH not CRITICAL**
The pool-checkout reset in `TenantConnectionBootstrap.patchConnectionPool` re-asserts `SET search_path TO "<source>", public` on every checkout, so the session contamination is truncated at the next checkout. This is the **defense-in-depth** the agent invariant calls "non-negotiable." The contamination still leaks within the migration runner's pinned `queryRunner` lifetime, but the migration runner pins one queryRunner per schema and re-asserts `SET search_path` before every migration's `up()` (`migration-runner.service.ts:311-313, 351-353`), so the immediate bite is closed by the runner. **The migrations remain HIGH because removing the per-migration runner re-assertion in the future would re-open the bite.** Fix the migrations themselves; don't rely on the runner's compensation.

**Proposed fix direction**
- Mechanical edit: prefix every `SET search_path` inside a migration body with `LOCAL`. The lint rule `migration-sql-lint.ts` (W5 — DATA-HIGH-003 fix) flags this on commit; ship the migrations through a follow-up `chore(messaging): SET LOCAL search_path` PR.

**Affected surface (ripple set)**
- `apps/messaging-service/src/migrations/1782300000000-AddTenantIdToMessageChildren.ts`
- `apps/messaging-service/src/migrations/1782400000000-EnableRowLevelSecurity.ts`
- `tools/gates/migration-sql-lint.ts` (W5) — verify rule covers the pattern (`SET search_path` not preceded by `LOCAL` inside a migration function body)

**Expected closer**
data-expert WRITER mode + messaging-expert CATCHER.

---

#### DATA-HIGH-007 — Money / decimal type discipline gap in `Invoice.lineItems` (`amount: number`, GraphQL Float)

**Severity:** HIGH
**Layer:** 3 (CLAUDE.md money-precision rule + DecimalTransformer requirement)
**State:** OPEN — confirms billing-expert BILLING-HIGH-005

**Evidence**
- `apps/billing-service/src/billing/entities/invoice.entity.ts:39-50` — `InvoiceLineItem.amount: number` typed as `@Field(() => Float)`. Inline TODO at `:39-42` acknowledges the gap as `PLAT-LOW-001` — should be HIGH per the agent invariant: *"NUMERIC/DECIMAL MUST use DecimalTransformer (or be explicitly typed string) — Postgres driver returns these as strings to preserve arbitrary precision; `amount + 1` silently becomes `'42.501'`. Missing transformer = HIGH (silent financial corruption)."*
- The aggregate `Invoice.lineItems` is stored as `@Column('jsonb', { name: 'line_items' })` — JSONB strings ARE preserved, but the GraphQL boundary serializes through `Float` (IEEE 754 double, 15–17 decimal digits). Tax computations in `Invoice.amount * Invoice.taxRate` execute in JS Number arithmetic, accumulating IEEE 754 error.
- Top-level Invoice money fields (`amountPaid`, `amountDue`) DO use `@MoneyColumn` (`Decimal` type) — partial discipline, only the JSONB-line-items leak.

**Rule violated**
- Layer-1 TypeORM rule + agent invariant: every NUMERIC/DECIMAL field crossing a process boundary must use `DecimalTransformer` or be `string`-typed.
- CLAUDE.md highest-quality-always: currency arithmetic in IEEE 754 is the case where "Float is fine for typical aquaculture amounts" is the banned-phrase reasoning ("good enough" / "sufficient for now").

**Proposed fix direction**
- Convert `InvoiceLineItem.amount` (and `quantity`/`unitPrice` if they're ever multiplied by money) to `Decimal` (`decimal.js`) with a custom GraphQL scalar (`DecimalScalar`). Migration: jsonb-stored, no DB migration needed; producers/consumers serialize through the scalar's `parseValue`/`serialize`.
- Audit the rest of the entity tree for similar `: number` fields on monetary aggregates.

**Affected surface (ripple set)**
- `apps/billing-service/src/billing/entities/invoice.entity.ts`
- `apps/billing-service/src/billing/scalars/decimal.scalar.ts` (new)
- Every consumer of `InvoiceLineItem.amount`
- `tests/invariants/money-discipline.spec.ts` (new)

**Expected closer**
billing-expert WRITER (closes BILLING-HIGH-005) + data-expert CATCHER.

---

#### DATA-HIGH-008 — Direct `dataSource.getRepository` calls outside transactions (auth-service, billing-service, sensor-service)

**Severity:** HIGH
**Layer:** 3 (CLAUDE.md "getRepository banned → use getScopedRepository") + 1 (no-restricted-syntax ESLint)
**State:** OPEN — escalates W1 DATA-HIGH-002

**Evidence**
- `apps/billing-service/src/billing/billing-scheduler.service.ts:504` — `this.dataSource.getRepository(ScheduledPlanChange)` (cron job; not transactional)
- `apps/billing-service/src/billing/query-handlers/get-plan-by-id.handler.ts:17` and `get-plans.handler.ts:17` — query handlers; ad-hoc repo
- `apps/billing-service/src/billing/event-handlers/tenant-subscription-requested.handler.ts:244,403` — event handler; outside the transaction the handler should be running in
- `apps/billing-service/src/modules/metering/usage-aggregator.service.ts:174,176`, `apps/billing-service/src/billing/seed/plan-seed.service.ts:29`
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts:500,510,532,539,679,764` — 6 calls; some inside `dataSource.transaction(async manager => { … manager.getRepository(...) … })` (correct), others on `this.dataSource.getRepository` directly (wrong)
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1198,1604,1617`, `apps/sensor-service/src/automation/automation.service.ts:1683` — 4 calls

**Rule violated**
- CLAUDE.md "Code Quality Standards": *"`getRepository()` is FORBIDDEN → use `getScopedRepository()` (tenant isolation)"*
- Layer-1 TypeORM rule: scoped-repo enforces tenant context; raw `dataSource.getRepository` skips tenant isolation. For non-tenant-scoped tables (e.g. `Plan`, `ScheduledPlanChange`) the scoped repo is still preferred for consistency; when a transaction is in flight, `manager.getRepository(...)` is the correct call.

**Proposed fix direction**
- Tier-3 (immediate): expand the existing `no-restricted-syntax` ESLint rule to flag `*.dataSource.getRepository(`. Document the legitimate exceptions inline (e.g. seed services running pre-tenant-context can use a marked override).
- Tier-1 (architectural): convert ad-hoc repos into scoped-repo calls. For cron / scheduler / event handlers where tenant context isn't yet established, use a `manager.getRepository(...)` inside an explicit `dataSource.transaction(...)` so RLS / tenant scoping is at least transactional.

**Affected surface (ripple set)**
- Every `*.dataSource.getRepository(` site listed above (~14 confirmed)
- `eslint.config.mjs` — extend rule
- Per-service convergence — billing has the densest cluster

**Expected closer**
Per-service domain expert WRITER + data-expert CATCHER on each PR.

### MEDIUM

#### DATA-MEDIUM-001 — `SchemaManagerService` is a 1933-LoC monolith; decomposition pending

**Severity:** MEDIUM
**Layer:** 4 (architectural debt)
**State:** OPEN — W1 DATA-MEDIUM-001 unchanged

**Evidence**
- `wc -l libs/backend-common/src/database/schema-manager.service.ts` → 1933 lines
- Responsibilities: tenant schema CRUD, advisory-lock orchestration, hypertable creation, reference-data copy, application-role discovery, schema cache, SQL-identifier validation, migration-history seeding, module-schema registry SSoT

**Proposed fix direction**
Extract `TenantSchemaCrud`, `AdvisoryLockManager`, `HypertableInstaller`, `ReferenceDataReplicator`, `MigrationHistorySeeder`. Each gets its own spec file; the tier-1 `validateSqlIdentifier` lives in `schema-primitives/`.

**Expected closer**
data-expert WRITER + multi-tenant-saas-expert review.

---

#### DATA-MEDIUM-002 — `messaging-service` has two migration directories (`src/migrations/` + `src/database/migrations/`)

**Severity:** MEDIUM
**Layer:** 4 (consistency)
**State:** OPEN

**Evidence**
- `apps/messaging-service/src/database/data-source.ts:36-39` — `migrations: ['src/migrations/*.ts', 'src/database/migrations/*.ts']`
- 10 migrations live under `src/migrations/`, none under `src/database/migrations/`
- Inline comment at `data-source.ts:20-26` acknowledges the historical drift

**Proposed fix direction**
Move every messaging migration to `apps/messaging-service/src/database/migrations/` (the consistent platform-wide path). Update the data-source.ts to drop the dual glob.

**Expected closer**
messaging-expert WRITER + data-expert CATCHER.

---

#### DATA-MEDIUM-003 — Session-scoped `SET search_path` in `apps/hr-service/src/{leave/leave-accrual,training/certification-expiry}.service.ts`

**Severity:** MEDIUM
**Layer:** 3 (defense-in-depth)
**State:** OPEN — new

**Evidence**
- `apps/hr-service/src/training/certification-expiry.service.ts:62,96,144,158` — session-scope `SET search_path` followed by `RESET search_path` in finally
- `apps/hr-service/src/leave/leave-accrual.service.ts:92,225,287,390` — same pattern

**Why MEDIUM not HIGH**
The pool-checkout reset (`TenantConnectionBootstrap`) re-asserts `SET search_path TO "<source>", public` on every checkout. Service-side `RESET` in finally is also present. The bite requires (a) the query to throw before reaching the `RESET`, (b) the `.catch(() => {})` in the finally to swallow the reset's own error, AND (c) the connection to return to the pool before the next checkout-reset fires. Defense-in-depth posture, not active bite.

**Proposed fix direction**
Convert to `dataSource.transaction(async manager => { await manager.query('SET LOCAL search_path TO ...'); … })` — `LOCAL` auto-resets on COMMIT/ROLLBACK; no `finally RESET` plumbing needed.

**Expected closer**
hr-expert WRITER + data-expert CATCHER.

---

#### DATA-MEDIUM-004 — JSONB column count is 453 (W1 estimate ~50)

**Severity:** MEDIUM
**Layer:** 4 (boundary discipline)
**State:** OPEN — escalates W1 DATA-MEDIUM-006 (numerical recount)

**Evidence**
- `grep -rE '@Column.*jsonb' apps --include='*.ts' | wc -l` → 453

**Why MEDIUM not HIGH**
Most of the 453 are typed JSONB (`@Column({ type: 'jsonb' }) settings: SettingsShape`) where the TypeScript shape narrows the runtime type. The bite is in the subset typed as `any` / `Record<string, unknown>` / no type. Exact subset count requires per-column inspection.

**Proposed fix direction**
Audit pass: for each `@Column.*jsonb`, check the declared TS type. Promote to HIGH if `: any` or `: Record<string, unknown>`. Where the JSONB is a documented event-payload boundary or config blob, add it to `.claude/allowlists/boundary-files.yaml`.

**Expected closer**
Per-service domain expert + data-expert CATCHER on the per-service slice.

---

#### DATA-MEDIUM-005 — 8 of 15 services lack `apps/<svc>/src/database/data-source.ts` (W1 DATA-MEDIUM-005)

**Severity:** MEDIUM
**Layer:** 4 (consistency / TypeORM CLI affordance)
**State:** OPEN — W1 unchanged

**Evidence**
With `data-source.ts`: `ai-service`, `alert-engine`, `billing-service`, `config-service`, `hr-service`, `messaging-service`, `notification-service` (7).
Missing: `admin-api-service`, `auth-service`, `event-store-service`, `farm-service`, `gateway-api`, `hydroponics-service`, `observability-service`, `sensor-service` (8). Plus `db-migrate` and `sensor-ingestion` (n/a).

**Rule violated**
ADR-011 / Layer-1 TypeORM: every schema-owning service exports `apps/<svc>/src/database/data-source.ts` for CLI generate/run.

**Proposed fix direction**
Add the 8 missing files. Pattern is the existing `billing-service/src/database/data-source.ts`.

**Expected closer**
Per-service domain expert + data-expert CATCHER.

### LOW

#### DATA-LOW-001 — `as any` in `tenant-connection-bootstrap.service.ts:81` and `rls-connection-bootstrap.service.ts:136`

**Severity:** LOW
**Layer:** 3 (boundary file allowlist)
**State:** OPEN

**Evidence**
- `libs/backend-common/src/database/tenant-connection-bootstrap.service.ts:81` — `const driver = this.dataSource.driver as any;`
- `libs/backend-common/src/database/rls/rls-connection-bootstrap.service.ts:136` — same

**Rule violated**
CLAUDE.md `as any` ban; agent invariant on boundary files. Both are legitimate boundary patterns (TypeORM driver type doesn't expose `master.connect`), but they need an `// auditor-override:` comment and an entry in `.claude/allowlists/boundary-files.yaml`.

**Proposed fix direction**
Add inline override + allowlist entry per `tier-claim-syntax.md` `auditor-override:` grammar. OR write a thin typed adapter (`PgPoolFromDataSource(ds): pg.Pool`) once, hide the `as any` inside it.

**Expected closer**
data-expert WRITER (small).

---

#### DATA-LOW-002 — Workflow comment at `.github/workflows/db-migration-check.yml:21-27` is factually wrong about the orphan migration tree

**Severity:** LOW
**Layer:** 4 (documentation rot)
**State:** OPEN — new

**Evidence**
The workflow comment claims *"9 of the 13 SQL files in that tree are empty (0 bytes)"*. Direct file-size check shows every `database/migrations/core/V*.sql` has 281–2491 bytes; every `database/migrations/modules/<svc>/V*.sql` has 762–5598 bytes. None empty.

**Proposed fix direction**
Delete the workflow comment together with the orphan tree per DATA-HIGH-001 fix. If the tree is kept (against recommendation), correct the comment.

**Expected closer**
infra-expert WRITER + data-expert CATCHER.

---

#### DATA-LOW-003 — `cryptoShredKeyId` is mandatory only on `PasswordResetRequestedEvent`; other PII-bearing events don't enforce

**Severity:** LOW
**Layer:** 3 (PII-in-events policy)
**State:** OPEN — observation

**Evidence**
- `libs/event-contracts/src/auth-events.ts:71` — `cryptoShredKeyId: string` (mandatory) on `PasswordResetRequestedEvent`
- `libs/event-contracts/src/base-event.ts:112` — `cryptoShredKeyId?: string` (optional) on `BaseEvent`
- Other PII-class events (employee personal data, billing-email-bearing webhooks) don't structurally force `cryptoShredKeyId`

**Why LOW not HIGH**
Most billing/tenant events carry opaque IDs already. The systematic policy-by-shape (every PII-class event has mandatory `cryptoShredKeyId`) is missing — the policy is per-event, by hand. New events that introduce PII without opting in are a slow leak.

**Proposed fix direction**
Document per-event PII gates list in `libs/event-contracts/src/base-event.ts` docblock. W6 invariant test: enumerate PII-class events and structurally assert each has mandatory `cryptoShredKeyId`.

**Expected closer**
compliance-expert WRITER + data-expert CATCHER (cross-handoff).

## Cross-domain dependencies flagged

- **DATA-CRITICAL-003** confirms and EXTENDS platform-kernel-expert PLAT-CRITICAL-002. The kernel-side `NatsEventBus.deserializeEvent` string-to-Date re-coercion is the symptom; the cure is the contract-side `Date → string` flip. Joint fix required.
- **DATA-CRITICAL-004** confirms billing-expert BILLING-CRITICAL-002 (no outbox). Adoption is W7 BLOCKER-20 family — multi-PR convergence; ESLint rule should land first.
- **DATA-HIGH-001** confirms database-reviewer DBR-CRITICAL-003 (dual migration trees). Single delete-only PR closes both.
- **DATA-HIGH-002** is a direct response to auth-security-expert SEC-CRITICAL-001 cross-handoff request. Contract + producer + token-family migration ship together; data-expert authors the contract, auth-security-expert authors the producer side.
- **DATA-HIGH-003** confirms billing-expert BILLING-CRITICAL-003 (Stripe persistent dedupe table missing).
- **DATA-HIGH-007** confirms billing-expert BILLING-HIGH-005 (Money discipline gap on JSONB line items).
- Auth-security-expert SEC-CRITICAL-004 (jwtService.verify* skipping `getJwtVerifyOptions` SSoT): event-contract surface unaffected — `JwtPayload` is constructed inside auth-service, not on the bus. **No data-expert finding raised**; treated as auth-service-internal.
- Multi-tenant-saas-expert is the secondary reviewer for DATA-CRITICAL-001 + DATA-CRITICAL-002 (tenant provisioning surface).

## Verdict

**BLOCK** — 4 CRITICAL findings (advisory-lock leak, runtime DDL on boot, contract type-lie, outbox under-adoption). All 4 require coordinated multi-PR work; do not merge anything that depends on tenant provisioning, event contract integrity, or billing webhook ingest until at least DATA-CRITICAL-001 (advisory lock) and DATA-CRITICAL-002 (TenantSchemaSyncService) are closed. DATA-CRITICAL-003 and DATA-CRITICAL-004 may proceed via tracked plan phases if every new event added in the meantime ships through outbox + has a proper interface.

## References

- ADRs: 006 (event flat), 011 (schema ownership), 012 (drift prevention), 014 (NATS mTLS), 015 (NATS cert-is-identity SSoT)
- Layer-1: `.claude/knowledge/layer-1-typeorm.md`, `layer-1-nestjs.md`
- Layer-2: `.claude/knowledge/layer-2-patterns.md` (CQRS / Outbox / event-flat / tenant isolation)
- Layer-3: `.claude/knowledge/layer-3-adrs.md`
- Sibling reviews this cycle: `docs/reviews/auth-security-expert/2026-04-28-*.md` (SEC-CRITICAL-001/-004), `docs/reviews/billing-expert/2026-04-28-*.md` (BILLING-CRITICAL-002/-003 + HIGH-001/-002/-005), `docs/reviews/platform-kernel-expert/2026-04-28-*.md` (PLAT-CRITICAL-002), `docs/reviews/database-reviewer/2026-04-28-*.md` (DBR-CRITICAL-003)
- Prior cycles: `docs/reviews/data-expert/2026-04-10-full-repo-audit.md`, `2026-04-19-e2e-messaging-arch.md`
- Authoritative W1 finding list: `docs/reviews/_audit/2026-04-W16-backend-data.md`
- `tests/invariants/upcaster-chain.spec.ts` — current state of the W6 deliverable
- `libs/backend-common/src/database/tenant-connection-bootstrap.service.ts` — 2026-04-07 incident class, the canonical example of the architectural fix this report measures every other path against
