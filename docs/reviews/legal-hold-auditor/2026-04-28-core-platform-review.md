# legal-hold-auditor — review — 2026-04-28 — core/cross-cutting (auth/tenant/billing)

## Scope

First-cycle CATCHER sweep of every destructive action path that intersects auth-service, admin-api-service tenant lifecycle, billing-service, and the cross-cutting libraries (`libs/backend-common/src/database/**`, `platform/libs/outbox/**`, observability tenant-erase cascade). Surface inventory: 1 schema-DROP entry point in `libs/backend-common`, 1 admin-api `deleteSchema(hardDelete=true)`, 1 admin-api `deprovisionTenant` saga, 1 farm-service `TenantErasureService` cascade, 1 observability `EraseObservabilityTenantDataHandler`, 1 messaging `RetentionPolicyService` (reference implementation), 1 messaging `GdprService.anonymizeMyData` (reference implementation), 1 auth `GdprComplianceService.executeErasure`, 1 auth `UserLifecycleService.deleteUser` / `adminDeactivateUser` / `adminForceLogout`, 1 auth `audit-log.service` retention sweep, 1 admin-api `audit-trail.service` retention policy applier, 1 admin-api `job-queue.service` cleanup, 1 notification-service retention sweep, 1 billing `create-subscription.handler` cancelled-subscription delete, 1 messaging partition `dropPartition`, 1 outbox-worker `cleanupPublished`, 1 admin-api migration `1787200000000-RealignSharedAuditLogsSchema` that drops `shared.audit_logs.legalHold` column. Sibling-finding handoffs corroborated: `DBR-CRITICAL-001` (legalHold column drop), `DATA-CRITICAL-002` (TenantSchemaSyncService DDL).

## Executive summary

The platform has **one** working legal-hold reference implementation (`apps/messaging-service/src/compliance/services/legal-hold.service.ts`) and **zero** other call sites that consult it. Every destructive action outside messaging-service — including DROP SCHEMA CASCADE in tenant deprovisioning, GDPR erasure in auth/farm/observability, retention sweeps in auth/admin/notification, partition drops, outbox GC, and audit-log retention — proceeds without ever asking whether a hold is active. This is fail-OPEN by construction, not by accident: the canonical hold registry the agent spec mandates (`libs/backend-common/src/compliance/legal-hold/**`) does not exist. The messaging implementation is also tenant-scoped to messaging schema and cannot be consulted cross-service. Compounding this, migration `1787200000000-RealignSharedAuditLogsSchema` dropped the `legalHold` boolean column on `shared.audit_logs` (DBR-CRITICAL-001 sibling), eliminating the only platform-level row-level hold marker. Verdict: **BLOCK** — three CRITICAL legal-hold gaps in destructive paths the user explicitly scoped (auth/tenant/billing), plus six HIGH-severity coverage gaps in adjacent destructive paths reachable from the same admin/cron entry points.

## Findings (by severity)

### CRITICAL

#### LEGAL-CRITICAL-001 — DROP SCHEMA CASCADE has zero legal-hold check (tenant deprovisioning + admin schema mgmt)
**Severity:** CRITICAL
**Layer:** 2 (architectural pattern — destructive action precedence)
**State:** OPEN
**Sub-kind:** `GUARD_MISSING`

**Evidence**
- `libs/backend-common/src/database/schema-manager.service.ts:1025-1049` — `deleteTenantSchema(tenantId)` issues `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE` with no consultation of any hold registry. Advisory lock is taken; legal hold is not.
- `libs/backend-common/src/database/schema-manager.service.ts:856-863` — provisioning-failure cleanup also drops the partial schema unconditionally.
- `apps/admin-api-service/src/database-management/services/schema-management.service.ts:307-394` — `deleteSchema(tenantId, hardDelete=true, …)` — writes an immutable audit row, then `DROP SCHEMA IF EXISTS … CASCADE`. Audit gating exists; legal-hold gating does not.
- `apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts:441-515,902-927` — `deprovisionTenant()` saga step 4 = `cleanupTenantSchema()` → `schemaManager.deleteTenantSchema()`. Saga step 0 only blocks `TenantStatus.ACTIVE`; SUSPENDED / CANCELLED tenants — exactly the population an op flow would deprovision — get DROP'd. Held data inside is irretrievable.

**Rule violated**
Agent spec §"Precedence-check middleware": "Every destructive handler MUST invoke `await legalHoldGuard.check({ tenantId, resourceType, resourceId })` as the FIRST pre-action step. Missing = CRITICAL." Also §"Batch destructive operations": "DROP SCHEMA MUST check EVERY resource in scope; partial batch = CRITICAL." Schema drop is the maximum-blast-radius batch destructive action; it must be guarded at every entry point.

**Proposed fix direction**
- Tier 1 (make impossible): add `compliance.legal_holds` row with `resourceType='tenant_schema'` blocking the DROP at the SQL layer via a `BEFORE DROP` event trigger on the schema, OR via a `compliance_check_required = true` row in a control table that the schema manager's connection role lacks privilege to bypass. Both give structural enforcement that no app-level fix can bypass.
- Tier 2 (make automatic): wrap every `dataSource.query('DROP SCHEMA …')` in `libs/backend-common` behind a `SchemaDropGuard.check()` that reads the central hold registry; reject any caller that bypasses it via an ESLint `no-restricted-syntax` rule banning `DROP SCHEMA` outside the guarded helper.
- Tier 3 (detectable): add `tests/invariants/legal-hold-coverage.spec.ts` that statically lists every `DROP SCHEMA` / `dropTenantSchema` call site and asserts each is preceded (within the same function) by a `legalHoldGuard` call.

**Affected surface (ripple set)**
- `libs/backend-common/src/database/schema-manager.service.ts` (2 sites)
- `libs/backend-common/src/compliance/legal-hold/**` (new — agent spec primary ownership; does not exist yet)
- `apps/admin-api-service/src/database-management/services/schema-management.service.ts`
- `apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts`
- `tests/invariants/legal-hold-coverage.spec.ts` (new)
- `docs/runbooks/legal-hold-deprovision.md` (new — operator workflow when hold blocks DROP)

**Expected closer**
`legal-hold-bootstrap` skill (new — composes the registry table migration + guard library + invariant test) → CATCHER review by data-expert + multi-tenant-saas-expert + auth-security-expert.

---

#### LEGAL-CRITICAL-002 — auth-service GDPR erasure cascade has zero legal-hold check
**Severity:** CRITICAL
**Layer:** 2 (architectural pattern — GDPR Art 17 ↔ legal hold interaction)
**State:** OPEN
**Sub-kind:** `GUARD_MISSING` + `ART17_REFUSE`

**Evidence**
- `apps/auth-service/src/privacy/gdpr-compliance.service.ts:66-133` — `executeErasure(userId, tenantId, requestedBy)`:
  - `:83` `authService.logoutAllDevices(userId)` — invalidates sessions
  - `:88` `webAuthnService.removeAllCredentials(userId)` — physically deletes WebAuthn credentials
  - `:96-111` transaction anonymises `User` row (`email='deleted-${userId}@gdpr.local'`, `password=''`, `isActive=false`) and revokes all refresh tokens
  - `:120-126` publishes `UserDeleted` event for cross-service cascade
  - **No call to any hold registry anywhere in this method or its callees.**
- `apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts:258-333` — `deleteUser(tenantId, userId, deletedBy)`: deactivates user + revokes role assignments + deletes refresh tokens; no hold check.
- `apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts:538-580` — `adminDeactivateUser` and `adminForceLogout` hard-delete refresh tokens with no hold check; tokens are admissible electronic records under several jurisdictions and a held user's session evidence chain breaks here.

**Rule violated**
Agent spec §"GDPR Art 17 interaction": "GDPR erasure request on a held resource: cascade handler returns `state: 'BLOCKED_LEGAL_HOLD'` + notifies the data subject. Missing notification = HIGH; running erasure on held data = CRITICAL spoliation." Compounded by sibling `auth-security-expert positive: GDPR erasure cascades to WebAuthn/sessions/refresh tokens` — the cascade is correct from a privacy-completeness angle, but each leg is destructive evidence the platform may be ordered to preserve.

**Proposed fix direction**
- Tier 2 (make automatic): introduce `LegalHoldGuard` in `libs/backend-common/src/compliance/legal-hold/`. `GdprComplianceService.executeErasure` MUST invoke `await legalHoldGuard.check({ tenantId, resourceType: 'user', resourceId: userId })` before the first destructive call (line 83). On `held: true`, abort with `BLOCKED_LEGAL_HOLD`, emit a structured audit row, and surface a typed `LegalHoldActiveException` for the caller to forward to the data-subject notification path. Same wiring on `UserLifecycleService.deleteUser`, `adminDeactivateUser`, `adminForceLogout`.
- Tier 1 (make impossible): the destructive helpers (`logoutAllDevices`, `webAuthnService.removeAllCredentials`, the in-transaction anonymise UPDATE) accept a guard token argument (branded type `HoldClearedToken`) which the compiler refuses to construct outside `LegalHoldGuard.check()`'s clear-path return. Mirrors the `EventId` branded pattern (ADR-006) which has 278 zero-escape construction sites — proven model.

**Affected surface (ripple set)**
- `apps/auth-service/src/privacy/gdpr-compliance.service.ts`
- `apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts` (3 methods)
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts` (`logoutAllDevices`)
- `apps/auth-service/src/modules/authentication/services/webauthn.service.ts` (`removeAllCredentials`)
- `libs/backend-common/src/compliance/legal-hold/legal-hold.guard.ts` (new)
- `libs/event-contracts/src/compliance-events.ts` (new — `LegalHoldErasureBlocked` notification event, GDPR Art 17 procedural compliance)

**Expected closer**
`legal-hold-bootstrap` skill (Phase 1) + auth-security-expert WRITER for the auth-service wire-up. Sibling cross-handoff to compliance-expert (GDPR Art 17 refusal-notice contract) + gdpr-erasure-executor (cascade-entry guard).

---

#### LEGAL-CRITICAL-003 — TenantErased cascade (farm-service + observability) destroys held data without checking
**Severity:** CRITICAL
**Layer:** 2 (cross-service event-driven choreography)
**State:** OPEN
**Sub-kind:** `GUARD_MISSING` + `BATCH_PARTIAL`

**Evidence**
- `apps/farm-service/src/compliance/services/tenant-erasure.service.ts:140-179,203-273` — `confirm(tenantId, token)` validates a 5-min ticket then runs `executeErasure()`:
  - `:222-232` `mgr.createQueryBuilder().delete().from(meta.target).where('"tenantId" = :tenantId', …).execute()` over every TypeORM entity sorted topologically
  - `:241` audit logs anonymised (not deleted, but `userId` hashed — irreversible)
  - `:247-262` outbox-publishes `TenantErased` event triggering downstream cascades
  - **No hold registry consulted anywhere in the file.**
- `apps/observability-service/src/gdpr/handlers/erase-observability-tenant-data.handler.ts:45-83` — `EraseObservabilityTenantDataHandler.execute()` (consumer of `TenantErased`) runs `repo.delete({ tenantIdHash })` on `migration_event` rows with no hold check; agent spec calls out observability-service as a sibling-finding directly.
- `libs/event-contracts/src/tenant-events.ts:85-86` — `TenantErasedEvent` defines the event but no upcaster / consumer is required to assert hold-cleared status.

**Rule violated**
Agent spec §"Hold state registry: every destructive action checks this key BEFORE proceeding" + §"Batch destructive operations: bulk delete MUST check EVERY resource in scope; batch success when ZERO held resources, else fail entire batch. Partial batch = CRITICAL." A tenant-wide erasure is the canonical batch — every leaf resource (channel, batch, sensor reading) is in scope and each may individually be held.

**Proposed fix direction**
- Tier 2: extend the erasure-ticket protocol — `initiate(tenantId, requestedBy)` must consult the hold registry and refuse to issue a token while ANY hold (tenant-wide OR resource-scoped) exists. `confirm()` re-checks immediately before the cascade transaction (TOCTOU close). Cascade consumers (observability, others) re-check on event receipt and either complete the local erasure or emit `TenantEraseBlockedDownstream` for the orchestrator.
- Tier 1: the `TenantErasedEvent` shape gains a required `holdCheckSignature: HmacSignature` field — only the hold-registry service knows the HMAC key. Consumers refuse to dispatch a `TenantErased` whose signature does not verify. Spoofing requires compromising the registry service's key — the same trust class as gateway→subgraph HMAC (`libs/backend-common/src/utils/service-identity.util.ts`).
- Tier 3: contract test in `tests/invariants/tenant-erase-hold-precedence.spec.ts` enumerating every `TenantErased` consumer and asserting the consumer file references `legalHoldGuard.check`.

**Affected surface (ripple set)**
- `apps/farm-service/src/compliance/services/tenant-erasure.service.ts`
- `apps/observability-service/src/gdpr/handlers/erase-observability-tenant-data.handler.ts`
- `libs/event-contracts/src/tenant-events.ts` + `libs/event-contracts/src/upcasters/tenant-erased-v1-to-v2.ts` (new — adds `holdCheckSignature`)
- Every other downstream `TenantErased` consumer that ripple-tracer enumerates (sensor, hr, alert-engine, hydroponics, ai)
- `tests/invariants/tenant-erase-hold-precedence.spec.ts` (new)

**Expected closer**
data-expert WRITER (event-contract upcaster) + farm-expert WRITER (initiator-side) + multi-tenant-saas-expert CATCHER (cascade completeness). Cross-handoff to gdpr-erasure-executor.

---

### HIGH

#### LEGAL-HIGH-001 — `shared.audit_logs.legalHold` column dropped without replacement (DBR-CRITICAL-001 sibling)
**Severity:** HIGH (escalates to CRITICAL once merge lands in production)
**Layer:** 3 (ADR-011 schema ownership + audit-trail integrity)
**State:** OPEN
**Sub-kind:** `GUARD_MISSING` + sibling-handoff from database-reviewer

**Evidence**
- `apps/admin-api-service/src/migrations/1787200000000-RealignSharedAuditLogsSchema.ts:172-202` (up) — `DROP TABLE shared.audit_logs CASCADE; … CREATE TABLE shared.audit_logs (…)` — the canonical recreation **omits** the `legalHold` boolean column that lived on the old `admin.audit_logs` shape (visible in the down rollback at `:265`: `"legalHold" boolean NOT NULL DEFAULT false`).
- Sibling finding `DBR-CRITICAL-001`: `BEFORE UPDATE`/`BEFORE DELETE` triggers on `legalHold` were also dropped — the row-level immutability mechanism for held audit rows is gone.
- After this migration runs, the only legal-hold marker that survives platform-wide is the messaging-service `legal_holds` table (tenant + channel scope) — there is no cross-service row-level hold flag.

**Rule violated**
Agent spec §"Hold state registry: single source of truth: `compliance.legal_holds`". Dropping the legacy boolean column without first introducing the canonical registry leaves the platform with NO row-level hold mechanism and with stale code paths (any leftover ON-trigger logic) silently no-oping.

**Proposed fix direction**
- Tier 1: introduce `compliance.legal_holds` table + `compliance.audit_log_hold_links (auditLogId, legalHoldId)` join in the SAME migration sequence that drops `legalHold`, with `BEFORE UPDATE/DELETE` triggers re-pointed to the join table. Either both land or neither does — fix-forward is the only option once `1787200000000` ships.
- Tier 3: extend `e2e/tests/integration/schema-invariants.spec.ts` to assert that `compliance.legal_holds` exists and is referenced by any audit-log retention sweep. Today's schema-invariants test cites the old `legalHold` column at `e2e/tests/integration/schema-invariants.spec.ts` (text grep shows `legalHold`/`legal_hold`); the spec must be updated lock-step.

**Affected surface (ripple set)**
- New migration `1787250000000-CreateComplianceLegalHoldRegistry.ts`
- `e2e/tests/integration/schema-invariants.spec.ts`
- All admin/auth audit-log retention sweeps (which still proceed unaware)

**Expected closer**
data-expert WRITER for the migration; database-reviewer CATCHER (already raised the sibling) + legal-hold-auditor CATCHER (this agent).

---

#### LEGAL-HIGH-002 — outbox-worker `cleanupPublished` deletes events older than 7 days with no hold check
**Severity:** HIGH
**Layer:** 2 (event sourcing — published events are evidentiary records)
**State:** OPEN
**Sub-kind:** `GUARD_MISSING`

**Evidence**
- `platform/libs/outbox/src/outbox-worker.service.ts:430-454` — `cleanupPublished()` cron `0 3 * * *`: `repo.delete({ publishedAt: LessThan(sevenDaysAgo) })`. Runs in **every** service that registers `OutboxModule`. No tenant-scope filter, no hold check.
- Outbox events in this platform include `UserDeleted`, `TenantErased`, `LegalHoldToggled`, `MessageDeleted`, `BatchHarvested`, `UserDataAnonymized` — every published row is a contemporaneous business-event record. In litigation, the outbox is the canonical "what events were published when" replay log; a 7-day GC silently spoliates any hold older than that.

**Rule violated**
Agent spec §"every destructive action checks this key BEFORE proceeding" + §"Hold state registry … resource-level lookup index `(tenantId, resourceType, resourceId)`". The outbox row has `tenantId`; the `resourceType` is `'outbox_event'` and the resource is the event itself. Each must be checked.

**Proposed fix direction**
- Tier 2: `cleanupPublished()` reads `compliance.legal_holds` and excludes any tenant under tenant-wide hold; for resource-scoped holds, joins on the event's `aggregateId` to skip held aggregates.
- Tier 4 (last resort): publish events to a NATS JetStream replay topic with infinite retention before DB GC — outbox table is then a transactional ledger only, replay is via JetStream. This is a deeper architectural change; flag as future-state but Tier 2 closes today's gap.

**Affected surface (ripple set)**
- `platform/libs/outbox/src/outbox-worker.service.ts`
- `platform/libs/outbox/src/__tests__/outbox-worker.service.spec.ts`
- Adoption-invariant test: every service that wires `OutboxModule` should pick up the legal-hold-aware variant automatically (no ripple to consumers).

**Expected closer**
platform-kernel-expert WRITER + legal-hold-auditor CATCHER. Sibling cross-handoff to data-expert (kernel ownership of outbox module).

---

#### LEGAL-HIGH-003 — auth-service / admin-api / notification-service retention sweeps delete audit + log rows with no hold check
**Severity:** HIGH
**Layer:** 2 (retention vs. preservation)
**State:** OPEN
**Sub-kind:** `GUARD_MISSING`

**Evidence**
- `apps/auth-service/src/audit/audit-log.service.ts:112-129` — `@Cron(EVERY_DAY_AT_2AM) scheduledLogCleanup` → `deleteOldLogs()` → `auditLogRepository.delete({ createdAt: LessThan(cutoffDate) })`. No tenant filter; no hold check.
- `apps/admin-api-service/src/security/services/audit-trail.service.ts:792-858` — `@Cron(EVERY_DAY_AT_3AM) applyRetentionPolicies()` archives + deletes activity logs by `category` + `archivedAt` predicates. No hold consultation.
- `apps/admin-api-service/src/system-management/services/job-queue.service.ts:736-754` — `cleanupOldJobs()` deletes COMPLETED jobs > 30d, execution logs > 30d, CANCELLED jobs > 7d. No hold check.
- `apps/notification-service/src/notification/services/notification-retention.service.ts:45-73` — `cleanupOldLogs` deletes terminal-status notification rows > 90d. No hold check. Email/SMS/push delivery records are commonly subpoenaed in employment + harassment matters.
- `apps/admin-api-service/src/system-management/services/error-tracking.service.ts:792` (Cron at line 792) and `apps/admin-api-service/src/database-management/services/database-monitoring.service.ts:1084` — same pattern.

**Rule violated**
Agent spec §"Every destructive handler MUST invoke `legalHoldGuard.check()` as the FIRST pre-action step" + §"Cross-service propagation: hold state cached per-service (60s TTL) but invalidated on `LegalHoldApplied` events." None of these crons subscribe to hold events; none cache; none consult.

**Proposed fix direction**
- Tier 2: the central `RetentionEnforcementService` (already exists at `libs/backend-common/src/database/retention/retention-enforcement.service.ts`) should be the single retention entry point; every service-local cron delegates to it and it consults `compliance.legal_holds`. Adoption-invariant: ESLint rule banning `Repository.delete({ createdAt: LessThan(…) })` outside `RetentionEnforcementService`.
- Tier 3: lint rule `no-bare-retention-delete` — pattern match on `LessThan` + `delete` in the same expression.

**Affected surface (ripple set)**
- 5 cron-driven retention sweeps listed above
- `libs/backend-common/src/database/retention/retention-enforcement.service.ts` (extend with hold check)
- `libs/backend-common/src/database/retention/__tests__/retention-enforcement.service.spec.ts`

**Expected closer**
data-expert WRITER (retention library) + auth-security-expert WRITER (auth-service cleanup) + admin-expert WRITER (admin-api crons) + platform-services CATCHER (notification).

---

#### LEGAL-HIGH-004 — `TenantSchemaSyncService` boot-time DDL silently mutates held tenants (DATA-CRITICAL-002 sibling)
**Severity:** HIGH
**Layer:** 2 (boot-time DDL bypasses runtime checks by definition)
**State:** OPEN
**Sub-kind:** `GUARD_MISSING` + sibling-handoff from data-expert

**Evidence**
- `libs/backend-common/src/database/tenant-schema-sync.service.ts:32-50,83-113` — `onApplicationBootstrap()` enumerates every `tenant_*` schema and runs `CREATE TABLE IF NOT EXISTS … (LIKE source INCLUDING ALL)` and `ALTER TABLE ADD COLUMN` on each. Boot-time, no human-in-loop, no hold check. Registered in 8 service `app.module.ts` files (farm, sensor, hr, messaging, hydroponics, alert-engine, ai, billing per grep).
- The DDL is not strictly destructive (ADD COLUMN doesn't drop data) but **does** mutate held tenants' schemas mid-litigation — column adds change query plans, may invalidate snapshots taken under one shape, and a corresponding `DROP COLUMN` in a future deploy is destructive. The sibling finding `DATA-CRITICAL-002` flags this as "DDL rides past boundaries"; legal-hold concern is an extension.

**Rule violated**
Agent spec §"Hold application + release emit NATS events `LegalHoldApplied` … for cross-service cache invalidation" — boot-time DDL has no propagation channel to receive these events; it executes once and exits.

**Proposed fix direction**
- Tier 2: `TenantSchemaSyncService.syncTenantSchema()` reads `compliance.legal_holds` for the tenant before any DDL; if held, log a WARN audit row and skip that tenant (manual review required). Held tenants stay on their existing schema until release; a follow-up sweep on `LegalHoldReleased` event re-runs sync.
- Tier 3: add boot-time invariant — if any `tenant_*` schema is under hold, the service emits a `HeldTenantSchemaSyncSkipped` Prometheus counter that the operator dashboard surfaces.

**Affected surface (ripple set)**
- `libs/backend-common/src/database/tenant-schema-sync.service.ts`
- `libs/backend-common/src/database/__tests__/tenant-schema-sync.service.spec.ts`
- 8 `app.module.ts` files that register the service (no API change required if the guard is internal)

**Expected closer**
data-expert WRITER (kernel ownership) + multi-tenant-saas-expert CATCHER (tenant-slice review) + legal-hold-auditor CATCHER.

---

#### LEGAL-HIGH-005 — Auth `assignModules` and `tenant-management` admin paths bulk-delete TenantModule rows with no hold check
**Severity:** HIGH
**Layer:** 2
**State:** OPEN
**Sub-kind:** `GUARD_MISSING`

**Evidence**
- `apps/auth-service/src/modules/tenant/services/tenant.service.ts:444-493` — `assignModules()` runs `tmRepo.delete({})` (line 467) within a transaction to wipe and re-create all module assignments. If the tenant is under hold, removing the module bindings can disable access to held data — discovery-relevant configuration is destroyed.
- `apps/auth-service/src/modules/tenant/services/tenant.service.ts:393-439` — `suspend()` and `cancel()` are state-transition only (do not destroy data) but emit events that downstream services may interpret as cleanup triggers — must still consult hold to refuse the state transition that triggers cascading deletes.
- `apps/auth-service/src/modules/tenant/handlers/auth-admin-nats.handler.ts` — NATS-RPC entry point exposing the same destructive operations cross-service.

**Rule violated**
Agent spec §"every destructive handler MUST invoke `legalHoldGuard.check()`". `tenantManagerRepo(…).delete({})` is the exact partial-batch pattern called out as CRITICAL when held resources are silently swept up; here `delete({})` is "delete every row" which is the most aggressive form.

**Proposed fix direction**
- Tier 2: `assignModules()` consults the hold registry before issuing the wipe; if held, refuses with `LegalHoldActiveException`.
- Tier 1: `tenantManagerRepo(…)` wrapper exposes `delete()` only when accompanied by a `HoldClearedToken` (branded type) — same pattern as LEGAL-CRITICAL-002. Single chokepoint covers all callers.

**Affected surface (ripple set)**
- `apps/auth-service/src/modules/tenant/services/tenant.service.ts`
- `apps/auth-service/src/modules/tenant/handlers/auth-admin-nats.handler.ts`
- `libs/backend-common/src/database/tenant-manager-repo.ts` (the scoped wrapper)

**Expected closer**
auth-security-expert WRITER + multi-tenant-saas-expert CATCHER (since the wrapper is tenant-isolation infrastructure).

---

#### LEGAL-HIGH-006 — billing-service `create-subscription.handler` deletes cancelled subscription rows; no hold check
**Severity:** HIGH
**Layer:** 2
**State:** OPEN
**Sub-kind:** `GUARD_MISSING`

**Evidence**
- `apps/billing-service/src/billing/handlers/create-subscription.handler.ts:81-88` — when an existing subscription is in `CANCELLED` state, the handler hard-deletes it (`subscriptionRepo.delete({ id: existingSubscription.id })`) so the unique-on-`tenantId` index doesn't collide on the new insert.
- Subscription rows are billing-history evidence (revenue recognition, regulatory financial reporting, fraud investigations). Deleting a cancelled-then-resubscribed customer's prior row destroys the audit chain. No hold registry consulted.
- Subscription is cited by CLAUDE.md as billing SSoT (W1 audit) — destroying it is high-impact.

**Rule violated**
Agent spec §"every destructive handler MUST invoke `legalHoldGuard.check()`" + agent spec §"Override protocol: SUPER_ADMIN + MFA step-up + reason ≥ 50 chars + dual-approver". The handler runs as part of routine subscription creation — there's no operator approval at all, let alone dual-approver.

**Proposed fix direction**
- Tier 1: replace the hard-delete with soft-delete (`isActive = false` or `deletedAt = now`) + a partial unique index `WHERE deletedAt IS NULL`. Preserves history; collision avoided structurally.
- Tier 2: if soft-delete is rejected for billing-domain reasons, gate the hard-delete behind `legalHoldGuard.check({ tenantId, resourceType: 'subscription', resourceId })`.

**Affected surface (ripple set)**
- `apps/billing-service/src/billing/handlers/create-subscription.handler.ts`
- `apps/billing-service/src/billing/entities/subscription.entity.ts` (add `deletedAt` if Tier-1)
- New billing migration for the partial unique index
- `libs/event-contracts/src/billing-events.ts` (rev `SubscriptionCancelled` to include `deletedAt` semantics)

**Expected closer**
billing-expert WRITER + data-expert CATCHER (migration + index review).

---

### MEDIUM

#### LEGAL-MEDIUM-001 — Existing messaging-service `LegalHoldService` does not fail-CLOSED on registry timeout
**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Sub-kind:** `GUARD_MISSING` (timeout/fallback class)

**Evidence**
- `apps/messaging-service/src/compliance/services/legal-hold.service.ts:168-187` — `isUnderLegalHold()` reads from `holdRepo.findOne(…)`. If the DB query hangs (connection-pool exhausted, DB primary failover), the call never returns; the caller's outer cleanup transaction sits open. There is no `WITH TIMEOUT` / no `Promise.race` against a deadline — the agent spec mandates 500ms fail-CLOSED on timeout (`§Hold state registry: Fail-CLOSED: if registry lookup fails (DB error, timeout > 500ms), action BLOCKED with LegalHoldCheckUnavailable error`).
- The Redis cache invalidation at `:246-266` swallows errors with a logger.warn — the comment says "Non-fatal — cache will expire naturally via TTL" — but a stale TTL window allows destructive action on an entry that was just placed under hold. Spec §"Stale cache causing destructive action = CRITICAL" (this becomes critical when the platform-wide guard rolls out).

**Rule violated**
Agent spec §"Fail-CLOSED" + §"Stale cache".

**Proposed fix direction**
- Tier 2: wrap `holdRepo.findOne` in `Promise.race(query, deadline(500))`; on deadline, throw `LegalHoldCheckUnavailable`. Caller treats as `held: true`.
- Tier 2: cache invalidation failure flips a process-local circuit breaker that forces 0-TTL until Redis recovers.

**Affected surface (ripple set)**
- `apps/messaging-service/src/compliance/services/legal-hold.service.ts`
- once promoted to platform: `libs/backend-common/src/compliance/legal-hold/legal-hold.service.ts`

**Expected closer**
messaging-expert WRITER (current owner) — surface migrates to platform-kernel-expert when Phase 9.4 lands.

---

#### LEGAL-MEDIUM-002 — Override protocol absent platform-wide; messaging implementation has no dual-approver
**Severity:** MEDIUM
**Layer:** 4 (no mechanism today; documented gap)
**State:** OPEN
**Sub-kind:** `OVERRIDE_DUAL`

**Evidence**
- `apps/messaging-service/src/compliance/commands/toggle-legal-hold.handler.ts:39-121` — `ToggleLegalHoldCommand` activates/releases a hold based on a single user's request; no MFA step-up requirement at the handler, no second-approver gate, no override-session-token TTL enforcement.
- Spec §"Override protocol: requires ALL of: SUPER_ADMIN role + MFA step-up (≤5min) + explicit reason (≥50 chars) + dual-approver (second SUPER_ADMIN click-through)". Single-identity override = CRITICAL per spec — but raised at MEDIUM here because messaging holds are scoped (channel/tenant) not platform-wide and the SUPER_ADMIN gate at the resolver layer (`compliance.resolver.ts`) is at least present, just not dual.
- `apps/messaging-service/src/compliance/services/legal-hold.service.ts:50` — `legalMatterId` is mandatory (good) but `reason` is just `text` (no length check on activate; release has no reason field at all).

**Rule violated**
Agent spec §"Override protocol".

**Proposed fix direction**
- Tier 3: add release-reason field; enforce reason ≥ 50 chars; require MFA step-up claim (`mfaVerified === true && mfaVerifiedAt + 5min > now`) on the handler; require a second `LegalHoldApprovalCommand` from a different SUPER_ADMIN before the actual release commits.
- Tier 1 (long-term): the `LegalHold` entity has `releasedBy`; add `releasedByApprover` (NOT NULL on release path) + DB CHECK constraint `releasedBy <> releasedByApprover`.

**Affected surface (ripple set)**
- `apps/messaging-service/src/compliance/entities/legal-hold.entity.ts`
- `apps/messaging-service/src/compliance/commands/toggle-legal-hold.handler.ts`
- New approval command + handler

**Expected closer**
messaging-expert WRITER + auth-security-expert CATCHER (MFA step-up wiring).

---

#### LEGAL-MEDIUM-003 — `dropPartition` SQL helper has no caller-side hold check; messaging retention only handles `messages` table
**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Sub-kind:** `GUARD_MISSING`

**Evidence**
- `apps/messaging-service/src/partition/partition-queries.ts:101-113` — `dropPartition(schema, tableName, year, month)` returns a `DROP TABLE IF EXISTS` SQL string. The header comment warns "WARNING: This permanently deletes all data in the partition. Use for retention cleanup only after confirming the data retention policy allows it" — Tier-4 documentation only. No invariant test ensures every caller of this helper consulted the hold registry first.
- The helper is exported and reachable from `TenantMigrationRunner` (per `:5` comment) and admin tooling. A future caller can drop a partition belonging to a held tenant.

**Rule violated**
Agent spec §"DROP SCHEMA partition DROP migrations" — explicitly enumerated as a destructive surface; "primary remains the destructive handler's owner" and the helper lacks a guard at the architectural choke-point.

**Proposed fix direction**
- Tier 1: rename to `unsafeDropPartitionSql` and require the caller pass a `HoldClearedToken` (branded type, only constructible by `LegalHoldGuard.check()` happy path).
- Tier 3: ESLint rule `no-direct-drop-partition` banning the helper outside the guarded service.

**Affected surface (ripple set)**
- `apps/messaging-service/src/partition/partition-queries.ts`
- callers (currently RetentionPolicyService is the only one — it does check holds, so wrapper is preventive for future callers)

**Expected closer**
messaging-expert WRITER (clarifying ownership) + data-expert CATCHER.

---

#### LEGAL-MEDIUM-004 — Per-tenant retention drop_chunks fast path skips held-channel exclusion list when tenantHeld=false but held-channels-changed mid-cycle
**Severity:** MEDIUM
**Layer:** 2 (TOCTOU race)
**State:** OPEN
**Sub-kind:** `GUARD_MISSING` (race-condition class)

**Evidence**
- `apps/messaging-service/src/compliance/services/retention-policy.service.ts:208-216` — fast path: when `!channelId && heldChannelIds.length === 0`, skip directly to `dropChunksForTenant(tenantId, cutoffDate)` which `drop_chunks(messages, …)` over the entire tenant schema. The `getHeldChannelIds()` call at `:200` is read OUTSIDE any transaction; between read and drop, a new channel-scoped hold can land and be silently bypassed.
- `gdpr.service.ts:262-275` solves the same TOCTOU class with `SELECT … FOR UPDATE` on `legal_holds` inside the transaction (`MSG-CRITICAL-019` per the inline comment). The retention path lacks the same protection.

**Rule violated**
Agent spec §"Cross-service propagation: hold state cached per-service (60s TTL) but invalidated on events" + §"Stale cache causing destructive action = CRITICAL". The hold change here is not a stale cache; it's a stale read inside the same process — strictly worse.

**Proposed fix direction**
- Tier 2: bring the hold-channel read inside the same transaction as the chunk-drop; `SELECT … FOR UPDATE` on `legal_holds WHERE tenantId = … AND isActive = true`. drop_chunks is non-transactional in TimescaleDB historically — use an advisory lock around `(tenantId)` for the duration so concurrent hold-creation blocks until the drop completes or vice versa.

**Affected surface (ripple set)**
- `apps/messaging-service/src/compliance/services/retention-policy.service.ts`

**Expected closer**
messaging-expert WRITER + database-reviewer CATCHER.

---

### LOW

#### LEGAL-LOW-001 — Hold lifecycle events (`LegalHoldApplied` / `LegalHoldReleased` / `LegalHoldExpired`) not in `libs/event-contracts`
**Severity:** LOW (inhibits cross-service propagation but not directly destructive)
**Layer:** 2
**State:** OPEN
**Sub-kind:** `PROPAGATION_LAG`

**Evidence**
- Grep across `libs/event-contracts/src/*-events.ts` returns zero hits for `LegalHoldApplied`, `LegalHoldReleased`, `LegalHoldExpired`. The only event present is `LegalHoldToggled` published by messaging-service (`apps/messaging-service/src/compliance/commands/toggle-legal-hold.handler.ts:110`).
- Spec §"Hold application + release emit NATS events `LegalHoldApplied` / `LegalHoldReleased` for cross-service cache invalidation (< 5s propagation target)". Without these contracts, no other service can subscribe; cache invalidation cross-service is impossible.

**Rule violated**
Agent spec §"Cross-service propagation".

**Proposed fix direction**
- Tier 1: add the three events to `libs/event-contracts/src/compliance-events.ts` (new file). Brand types per ADR-006. Add JSON Schema validators since these cross trust boundaries.

**Affected surface (ripple set)**
- `libs/event-contracts/src/compliance-events.ts` (new)
- `libs/event-contracts/src/index.ts` (export)
- `libs/event-contracts/src/schemas/compliance/*.json` (validators)

**Expected closer**
data-expert WRITER (event-contract owner per ADR-006).

---

#### LEGAL-LOW-002 — `cleanupForPolicy` audits cleanup with hardcoded zero-UUID tenant + user; loses audit chain
**Severity:** LOW
**Layer:** 4
**State:** OPEN

**Evidence**
- `apps/messaging-service/src/compliance/services/retention-policy.service.ts:148-157` — the post-cleanup audit row uses `tenantId: '00000000-...0'` and `userId: '00000000-...0'` — anonymous system row. Per-tenant retention deletes are not attributed to the tenant whose data was deleted; cross-tenant retention reporting becomes impossible. For legal-hold post-mortems ("did retention sweep on this tenant during the hold window?") this row gives no signal.

**Rule violated**
Agent spec §"Hold override audit row MUST include … final action executed, outcome". The successful (non-override) path also needs per-tenant attribution to verify legal-hold compliance retrospectively.

**Proposed fix direction**
- Tier 4 → Tier 3: emit one audit row per (tenantId, policyId) processed with deleted count + held-channel-skip count.

**Affected surface (ripple set)**
- `apps/messaging-service/src/compliance/services/retention-policy.service.ts`

**Expected closer**
messaging-expert WRITER.

---

## Cross-domain dependencies flagged

- **Finding LEGAL-CRITICAL-001**: recommend invoking `data-expert` (kernel ownership of `schema-manager.service.ts`) + `multi-tenant-saas-expert` (tenant-lifecycle slice) + `auth-security-expert` (override protocol MFA gating).
- **Finding LEGAL-CRITICAL-002**: recommend invoking `auth-security-expert` (primary owner of GDPR cascade) + `gdpr-erasure-executor` (cascade-entry guard alignment) + `compliance-expert` (GDPR Art 17 refusal-notice contract).
- **Finding LEGAL-CRITICAL-003**: recommend invoking `data-expert` (event-contract upcaster) + `farm-expert` (initiator) + ripple-tracer to enumerate all `TenantErased` consumers (sensor, hr, alert-engine, hydroponics, ai). Sibling `audit-trail-completeness-auditor` for evidentiary chain review.
- **Finding LEGAL-HIGH-001**: direct sibling of `DBR-CRITICAL-001` (database-reviewer) — co-resolve in the same migration sequence.
- **Finding LEGAL-HIGH-002**: `platform-kernel-expert` (primary owner of `platform/libs/outbox`).
- **Finding LEGAL-HIGH-003**: `data-expert` (retention library) + `auth-security-expert` (auth audit-log) + `admin-expert` (admin-api crons) + `platform-services` (notification).
- **Finding LEGAL-HIGH-004**: direct sibling of `DATA-CRITICAL-002` (data-expert TenantSchemaSyncService DDL) — co-resolve.
- **Finding LEGAL-HIGH-005**: `auth-security-expert` + `multi-tenant-saas-expert`.
- **Finding LEGAL-HIGH-006**: `billing-expert` + `data-expert`.
- **Finding LEGAL-MEDIUM-002**: `auth-security-expert` (MFA step-up) — current messaging implementation can be promoted to platform once dual-approver lands.
- **Architectural-arbiter** invocation recommended on the question: "Where does the canonical `compliance.legal_holds` registry table live — in admin-api-service (operates as platform service) or in a new minimal compliance-service, or as a shared-schema table managed by `db-migrate`?" The agent spec assigns primary ownership to `libs/backend-common/src/compliance/legal-hold/**` but the table itself needs schema-ownership per ADR-011.

## Verdict

**BLOCK.**

Three CRITICAL findings, six HIGH findings, four MEDIUM, two LOW. The platform today has zero functional cross-service legal-hold enforcement. The messaging-service implementation is correct in pattern but cannot be consulted by any other service. Every destructive path the user scoped (auth/tenant/billing) fails the agent spec's "FIRST pre-action step" check. Migration `1787200000000` (already merged on a958dc66) has dropped the only platform-level row-level hold marker without replacement — the regression window is open RIGHT NOW.

**Recommended sequence to lift the BLOCK:**
1. `legal-hold-bootstrap` skill lands the canonical registry + guard library + invariant test (closes LEGAL-CRITICAL-001 architectural prerequisite, LEGAL-HIGH-001 column replacement, LEGAL-LOW-001 events).
2. WRITER cycles per service close the per-path findings (LEGAL-CRITICAL-002/003, LEGAL-HIGH-002 through HIGH-006, LEGAL-MEDIUM-001 through MEDIUM-004) — each in its primary-owner agent.
3. Adoption-invariant test enumerating every destructive surface and asserting `legalHoldGuard.check()` precedes — fails CI on any regression.

## References

- Layer-1 core / nestjs / typeorm — read at start of cycle
- Layer-2 patterns §"Outbox pattern", §"Saga compensation"
- Layer-3 ADR-006 (event flat + branded `EventId` proves the LEGAL-CRITICAL-002 / LEGAL-HIGH-002 Tier-1 model is achievable here), ADR-011 (schema ownership — `compliance.legal_holds` placement question for arbiter), ADR-014/015 (NATS cert-is-identity — lifecycle events propagate via that channel).
- Sibling findings: `DBR-CRITICAL-001`, `DATA-CRITICAL-002`, auth-security-expert positive (GDPR cascade completeness), multi-tenant-saas-expert (tenant lifecycle saga).
- Spec: `.claude/agents/legal-hold-auditor.md` §"Active findings this agent owns" — first-cycle inventory delivered here.
