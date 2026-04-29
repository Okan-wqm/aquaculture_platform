# Audit-Trail Completeness Auditor — CATCHER — 2026-04-28 — Core/Cross-Cutting Review

## Scope

Cross-cutting audit-log completeness review on the **core/cross-cutting (auth/tenant/billing) surface**, repo HEAD `a958dc66`. Files reviewed:

- `libs/backend-common/src/audit/**` — canonical audit infrastructure (entity, service, two interceptors, two decorators).
- `libs/backend-common/src/guards/tenant.guard.ts` — SUPER_ADMIN cross-tenant audit path (`recordAwait`).
- `apps/admin-api-service/src/migrations/1782000000000-AuditLogImmutability.ts` — DB-level immutability triggers (UPDATE block + legalHold-DELETE block).
- `apps/admin-api-service/src/migrations/1787200000000-RealignSharedAuditLogsSchema.ts` — DBR-CRITICAL-001 centerpiece migration.
- `apps/admin-api-service/src/impersonation/services/impersonation.service.ts` — dual-identity audit on impersonation start/end/extend/terminate.
- `apps/auth-service/src/audit/**` — auth's own AuditLog table (separate schema, 90-day retention).
- `apps/auth-service/src/modules/authentication/services/mfa.service.ts` — MFA step-up audit (logMfaEvent helper).
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts` — Stripe webhook audit (BILLING-HIGH-004 sibling).
- `apps/billing-service/src/billing/handlers/*.handler.ts` — 7 `@AuditedOperation()` decorators on CQRS command handlers.
- `apps/*/src/app.module.ts` — interceptor wiring across all 15 runtime services.
- CQRS command-handler coverage sweep: 180 `@CommandHandler`-decorated classes vs 7 `@AuditedOperation` and 18 `@AuditLog` decorations.

Review trigger: orchestrator dispatch of cross-cutting audit-coverage cycle, with explicit centerpiece on DBR-CRITICAL-001 (immutability-triggers-dropped-by-realign-migration). Sibling agents in parallel: legal-hold-auditor (legalHold column), compliance-expert (SOC 2 CC4 evidence), auth-security-expert (primary on `libs/backend-common/src/audit/**`).

## Executive summary

The audit-trail surface fails open in five compounding ways:

1. **`shared.audit_logs` is no longer immutable** (DBR-CRITICAL-001 confirmed). The canonical 1782000000000 immutability triggers (`trg_audit_logs_prevent_update`, `trg_audit_logs_prevent_legal_hold_delete`) and the `legalHold` column itself were dropped by the 1787200000000 realign migration (`DROP TABLE shared.audit_logs CASCADE`) and never recreated. The realign also re-grants `INSERT, UPDATE, DELETE` to every per-service role — the role-level revoke is gone. SUPER_ADMIN cross-tenant audit rows from TenantGuard are now silently mutable by every application service role. **CRITICAL**.
2. **`@AuditedOperation()` is structurally inert across the entire monorepo.** The decorator metadata is set, but zero of 15 services import `AuditedOperationModule.forRoot()`, so the interceptor never fires. The 7 billing-service handlers labelled `@AuditedOperation()` write **zero** audit rows. **CRITICAL**.
3. **Stripe webhook authentication boundary writes no audit trail** (BILLING-HIGH-004 confirmed). Signature verification failure, idempotent duplicate, parse failure, and successful processing all return without an audit row — payment dispute trail is absent. **HIGH**.
4. **Impersonation lifecycle is single-event audited.** `startImpersonation` writes one fire-and-forget row (caught with `.catch(logger.warn)`). `endImpersonation`, `terminateSession`, `extendSession`, `expireSession`, `endAllSessionsForAdmin` write **zero** audit rows. SOC 2 CC4 + GDPR Art 30 require full lifecycle. **CRITICAL**.
5. **Audit retention defaults to 90 days across auth + farm + admin services**, far below SOC 2 CC4 / GDPR Art 30 (5–7 year norm). `auth.audit_logs` and `farm.farm_audit_logs` actively `DELETE` on a daily Cron. **HIGH**.

Top 3 CRITICAL: AUDITTRAIL-CRITICAL-001 (immutability gap), AUDITTRAIL-CRITICAL-002 (decorator inert), AUDITTRAIL-CRITICAL-003 (impersonation lifecycle gap). Tier distribution: 5 CRITICAL, 6 HIGH, 4 MEDIUM, 2 LOW. Verdict: **BLOCK**.

## Findings (by severity)

### CRITICAL

#### AUDITTRAIL-CRITICAL-001 — `shared.audit_logs` immutability triggers + legalHold column dropped by realign migration; not recreated
**Severity:** CRITICAL  
**Layer:** 3 (ADR-011 schema ownership + audit-trail-completeness-auditor invariant: immutability + retention)  
**State:** OPEN  
**Sub-kind:** `IMMUTABILITY_GAP`

**Evidence**
- `apps/admin-api-service/src/migrations/1782000000000-AuditLogImmutability.ts:40-82` — installs `audit_logs_prevent_update()` BEFORE UPDATE trigger and `audit_logs_prevent_legal_hold_delete()` BEFORE DELETE trigger plus `legalHold boolean DEFAULT false` column on `audit_logs`.
- `apps/admin-api-service/src/migrations/1787200000000-RealignSharedAuditLogsSchema.ts:176` — `DROP TABLE shared.audit_logs CASCADE` removes the table, its triggers, AND the `legalHold` column in one statement.
- `apps/admin-api-service/src/migrations/1787200000000-RealignSharedAuditLogsSchema.ts:181-202` — `CREATE TABLE shared.audit_logs (...)` recreates without ANY trigger or `legalHold` column. The 14 columns match the canonical backend-common shape but tamper-resistance is structurally absent.
- `apps/admin-api-service/src/migrations/1787200000000-RealignSharedAuditLogsSchema.ts:223-232` — `GRANT SELECT, INSERT, UPDATE, DELETE ON shared.audit_logs TO "<role>"` re-grants `UPDATE` and `DELETE` to every service role (auth_service, farm_service, sensor_service, hr_service, messaging_service, hydroponics_service, alert_service, billing_service, notification_service, ai_service, admin_service, observability_service, event_store_service). The role-level revoke that should exist per the agent invariant ("audit_logs table has NO `UPDATE` or `DELETE` grants to application roles") is the inverse here.
- `infrastructure/docker/init-scripts/10-shared-schema.sql:172-194` — fresh-cluster bootstrap also creates `shared.audit_logs` without immutability triggers, so even green-field deploys are mutable.

**Rule violated**
audit-trail-completeness-auditor invariant "Immutability + retention": *"audit_logs table has NO UPDATE or DELETE grants to application roles. Enforced via DB role grants + trigger prevent_audit_mutation(). Missing = CRITICAL (audit tampering vector)."* Tampering vector is now open for every application role on shared.audit_logs.

**Proposed fix direction**
- Tier-1 (make impossible): add a follow-up migration that (a) recreates `audit_logs_prevent_update()` BEFORE UPDATE trigger on `shared.audit_logs`, (b) recreates `audit_logs_prevent_legal_hold_delete()` (after re-adding `legalHold` boolean), (c) `REVOKE UPDATE, DELETE ON shared.audit_logs FROM <every role>` and re-grant only `SELECT, INSERT`, (d) write a CI invariant test under `e2e/tests/integration/audit-immutability.spec.ts` that asserts presence of the two triggers + role grants are `INSERT, SELECT` only.
- Document in ADR-011 amendment that `shared.audit_logs` is the single canonical immutable table for cross-service audit; any future re-shape migration MUST preserve triggers + grants in the same statement set (added to the migration-sql lint pre-commit gate).

**Affected surface (ripple set)**
- `apps/admin-api-service/src/migrations/1787300000000-RestoreAuditLogsImmutability.ts` (new)
- `infrastructure/docker/init-scripts/10-shared-schema.sql` (add triggers + revoke)
- `e2e/tests/integration/audit-immutability.spec.ts` (new CI invariant)
- `libs/backend-common/src/audit/audit-log.entity.ts` (re-add `legalHold` field — coordinate with legal-hold-auditor)
- `tools/gates/migration-sql-lint.ts` (R-immutability rule: any migration touching audit_logs must preserve triggers)

**Expected closer**
data-expert WRITER mode + auth-security-expert CATCHER (primary on `libs/backend-common/src/audit/**`).

---

#### AUDITTRAIL-CRITICAL-002 — `@AuditedOperation()` decorator structurally inert; zero services wire `AuditedOperationModule.forRoot()`
**Severity:** CRITICAL  
**Layer:** 2 (CQRS audit pattern) + 3 (ADR-007 + audit decorator-driven contract)  
**State:** OPEN  
**Sub-kind:** `UNAUDITED_COMMAND`

**Evidence**
- `libs/backend-common/src/audit/audited-operation.module.ts:42-65` — `AuditedOperationModule.forRoot()` exists and registers `AuditedOperationInterceptor` as `APP_INTERCEPTOR`. **No file imports it.**
- `apps/billing-service/src/app.module.ts:19,154,233-237` — billing imports `AuditLogModule.forRoot()` + `AuditLogInterceptor` (the LEGACY fire-and-forget interceptor that responds only to `@AuditLog()`, NOT `@AuditedOperation()`). `AuditedOperationModule` is not in the imports array.
- `apps/billing-service/src/billing/handlers/{create-invoice,create-subscription,refund-payment,record-payment,void-invoice,finalize-invoice,change-subscription-plan}.handler.ts` — 7 handlers carry `@AuditedOperation({ resource, action })` decorators. Without the matching interceptor wired, none of these handlers writes any audit row.
- `apps/admin-api-service/src/app.module.ts`, `apps/auth-service/src/app.module.ts`, `apps/farm-service/src/app.module.ts`, `apps/sensor-service/src/app.module.ts`, `apps/messaging-service/src/app.module.ts` — no `AuditedOperationModule` import either.
- Repo-wide: `grep -rln "AuditedOperationModule"` returns hits only inside `libs/backend-common/src/audit/` itself and zero application app.module.ts files.

**Rule violated**
audit-trail-completeness-auditor "Mandatory coverage surfaces": *"Every CQRS COMMAND handler emits an audit row. Unaudited command = CRITICAL (regulatory trail gap)."* The decorator was designed expressly to make this automatic ("STRUCTURALLY IMPOSSIBLE to forget audit logging") — the implementation ships dead.

**Proposed fix direction**
- Tier-2 (make automatic): add `AuditedOperationModule.forRoot()` to every backend service's `app.module.ts` imports[] in one batch migration. Failed audit writes throw `InternalServerErrorException` per `audited-operation.interceptor.ts:152-187`, so adoption forces handler authors to surface audit-write breakage. The interceptor already supports HTTP, GraphQL, and CQRS contexts.
- Tier-3 (make detectable): add a CI invariant test `tests/invariants/audited-operation-wired.spec.ts` that walks every `apps/**/src/app.module.ts` AST, asserts presence of `AuditedOperationModule.forRoot()` in imports[]. Same pattern as `tests/invariants/schema-invariants.spec.ts`.
- Tier-3 (make detectable): add an ESLint rule `no-command-handler-without-audit` that errors on any `@CommandHandler`-decorated class without sibling `@AuditedOperation`. This catches future regression even if interceptor-wiring drifts.

**Affected surface (ripple set)**
- `apps/{auth,farm,sensor,hr,messaging,hydroponics,alert-engine,billing,notification,ai,config,event-store-service,admin-api,observability,gateway-api}-service/src/app.module.ts` (15 files)
- `tests/invariants/audited-operation-wired.spec.ts` (new)
- `.eslintrc.json` (new rule registration)
- `tools/eslint-rules/no-command-handler-without-audit.ts` (new)

**Expected closer**
platform-kernel-expert WRITER mode (cross-service module wiring) + every domain expert CATCHER on their service's app.module.ts diff.

---

#### AUDITTRAIL-CRITICAL-003 — Impersonation end/extend/terminate write no audit row; start writes fire-and-forget
**Severity:** CRITICAL  
**Layer:** 2 (audit lifecycle pattern) + 3 (audit-trail-completeness invariant: dual-identity rows)  
**State:** OPEN  
**Sub-kind:** `DUAL_IDENTITY_MISSING` + `FIRE_FORGET`

**Evidence**
- `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:509-524` — `startImpersonation` calls `auditLogService.log(...).catch((err) => this.logger.warn(...))`. The promise is **not awaited** and errors are swallowed. The handler returns the impersonation token even if the audit write fails — silent loss on the most security-critical regulated action.
- `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:532-561` — `endImpersonation` mutates session row + logs to NestJS Logger. **No audit-table write.**
- `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:563-583` — `terminateSession` (privileged operator action) also has no audit-table write.
- `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:589-653` — `extendSession` records the action in the session's own `actionsPerformed` JSONB array, but the canonical `admin.audit_logs` table receives no row, so the action cannot be queried via the SOC 2 CC4 audit pipeline.
- `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:655-663` — `endAllSessionsForAdmin` (privileged emergency revocation) chains `endImpersonation` calls — same gap propagates.
- `libs/backend-common/src/guards/tenant.guard.ts:290-297` — even the SUPER_ADMIN cross-tenant audit `recordAwait` swallows errors silently: `try { await recordAwait(...) } catch { logger.error(...); /* do not re-throw */ }`. Combined with AUDITTRAIL-CRITICAL-001, a determined attacker can drop the trigger AND the application gracefully proceeds when the write fails.

**Rule violated**
audit-trail-completeness-auditor "Mandatory coverage surfaces": *"Every IMPERSONATION action during active SUPER_ADMIN session emits dual-identity row (actor ≠ acted_on). Single-identity row = CRITICAL."* Plus `recordAwait()` synchronous invariant: *"Audit write MUST be awaited before the handler returns to client. Fire-and-forget = CRITICAL."*

**Proposed fix direction**
- Tier-2 (make automatic): replace `auditLogService.log(...).catch(...)` with `await auditLogService.recordAwait(...)` (admin's audit service does not yet expose `recordAwait` — add it mirroring backend-common's contract). On failure, throw `InternalServerErrorException` so the impersonation token is NEVER issued without an audit row.
- Add audit-table writes (dual-identity row: `actorTenantId = superAdmin's home tenant`, `actedOnTenantId = targetTenantId`) for every impersonation lifecycle event: start, end, terminate, extend, expire, endAll. Link them via `relatedAuditIds` per agent invariant — the start row's id is the parent; subsequent rows reference it.
- Tier-2: apply `@AuditedOperation()` to each impersonation method **after** AUDITTRAIL-CRITICAL-002 lands.
- TenantGuard `auditCrossTenantAccess`: on `recordAwait` failure, throw — do not let the request proceed unaudited. The agent invariant explicitly demands "silent loss is unacceptable".

**Affected surface (ripple set)**
- `apps/admin-api-service/src/impersonation/services/impersonation.service.ts` (6 methods)
- `apps/admin-api-service/src/audit/audit.service.ts` (add `recordAwait`)
- `libs/backend-common/src/guards/tenant.guard.ts` (auditCrossTenantAccess re-throw)
- `apps/admin-api-service/src/audit/audit.entity.ts` (add `relatedAuditIds uuid[]`, `actorTenantId`, `actedOnTenantId`)

**Expected closer**
auth-security-expert WRITER (primary on tenant.guard.ts) + multi-tenant-saas-expert CATCHER (dual-identity row shape) + legal-hold-auditor CATCHER (lifecycle linkage).

---

#### AUDITTRAIL-CRITICAL-004 — Mandatory audit-row shape grossly incomplete on `shared.audit_logs` (8 missing fields)
**Severity:** CRITICAL  
**Layer:** 3 (audit-trail-completeness-auditor mandatory shape)  
**State:** OPEN  
**Sub-kind:** `SHAPE_FIELD_MISSING`

**Evidence** — `libs/backend-common/src/audit/audit-log.entity.ts:31-167` exposes 14 columns. The agent's mandatory shape requires:

| Field | Status | Where missing fits today |
|---|---|---|
| `actorUserId` | partial — only `userId` | rename + dual-identity context lost |
| `actorHomeTenantId` | **missing** | dual-identity impersonation must use metadata jsonb (not queryable) |
| `actedOnTenantId` | partial — `tenantId` is repurposed for target | semantically conflated |
| `method` ('HTTP'\|'GRAPHQL'\|'NATS'\|'CRON'\|'CLI') | **missing** | cannot distinguish CRON-triggered actions from HTTP |
| `mfaVerified` boolean | **missing** | only inside metadata jsonb (not queryable) |
| `result` ('SUCCESS'\|'DENIED'\|'FAILED') | partial — encoded via `severity` | DENIED ≠ ERROR semantically |
| `requestId` | partial — uses `correlationId` | aliased but not standardized |
| `preStateHash` | **missing** | mutation integrity cannot be proven |
| `postStateHash` | **missing** | mutation integrity cannot be proven |
| `justification` | **missing** | required for override actions per agent invariant |
| `relatedAuditIds` | **missing** | impersonation session linkage cannot be reconstructed |

**Rule violated**
audit-trail-completeness-auditor "Audit row mandatory shape": *"Missing any required field = HIGH. Missing preStateHash/postStateHash on a mutation = MEDIUM escalating to HIGH after 30d."* Eight missing fields stack to CRITICAL.

**Proposed fix direction**
- Tier-1 (make impossible): introduce `AuditLogV2` entity in a new `libs/backend-common/src/audit/v2/` directory with the full shape. New writes go through V2; legacy writes through V1 deprecated with a CI invariant blocking new V1 callsites.
- Tier-2 + 3: alter `shared.audit_logs` to add the 8 columns (nullable for backfill safety, blue-green safe migration), then a follow-up migration enforces NOT NULL on actor/method/result after backfill.
- Coordinate with legal-hold-auditor (relatedAuditIds + legalHold), data-expert (TimescaleDB hypertable migration concurrent with shape change), compliance-expert (GDPR Art 30 evidence — `actorHomeTenantId`/`actedOnTenantId` are GDPR Art 30 record-of-processing controllers).

**Affected surface (ripple set)**
- `libs/backend-common/src/audit/audit-log.entity.ts`
- `libs/backend-common/src/audit/audit-log.tokens.ts` (CreateAuditEntryDto)
- `libs/backend-common/src/audit/audit-log.service.ts`, `audited-operation.interceptor.ts`, `audit-log.interceptor.ts`
- `apps/admin-api-service/src/migrations/{NEW}-ExtendAuditLogShape.ts`
- All callsites of `auditLogService.record/recordAwait/log` across 13 services

**Expected closer**
data-expert WRITER (entity + migration) + auth-security-expert CATCHER + every domain expert CATCHER on their service's auditLogService callsites.

---

#### AUDITTRAIL-CRITICAL-005 — Stripe webhook authentication boundary writes no audit row on signature failure or success (BILLING-HIGH-004 confirmed and escalated)
**Severity:** CRITICAL (escalated from sibling HIGH — financial trust boundary)  
**Layer:** 2 (audit lifecycle on auth boundary) + 3 (PCI-DSS adjacent compliance)  
**State:** OPEN  
**Sub-kind:** `UNAUDITED_COMMAND`

**Evidence**
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:111-116` — signature verification failure: `logger.warn(...)`; `res.status(400).json(...)`. **No audit row.**
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:99-103` — missing `stripe-signature` header: `logger.warn`; 400. No audit row.
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:138-151` — Redis idempotent duplicate: `logger.log`; `res.status(200).json({ duplicate: true })`. No audit row.
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:154-174` — successful processing path also writes no audit row. Webhook processing happens via `routeEvent` → `webhookService.handlePaymentIntentSucceeded` etc., which call CQRS commands carrying `@AuditedOperation` — but those decorators are **inert** per AUDITTRAIL-CRITICAL-002. So the entire payment lifecycle has zero audit trail.
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:82-83` — `@Public()` bypasses JWT auth and tenant guard. The audit-emit path therefore cannot rely on TenantGuard's `auditCrossTenantAccess`.

**Rule violated**
audit-trail-completeness-auditor "Mandatory coverage surfaces" #6: *"Every STRIPE WEBHOOK (after dedup) emits audit row with event_id + processed_at + result. Missing = HIGH (payment dispute trail)."* Combined with the auth-boundary character (signature verification failure is a security event), escalates to CRITICAL.

**Proposed fix direction**
- Tier-2: instrument the controller with explicit audit calls at every branch — signature failure, missing header, duplicate, parse failure, route success, route failure. Use `auditLogService.recordAwait` so failures propagate.
- Wire `@AuditedOperation()` on the controller method once AUDITTRAIL-CRITICAL-002 lands and the interceptor is global. The interceptor already supports HTTP context.
- Add a Prometheus alert on `stripe.webhook.signature.failure` count > 0 in 5min — signature failures are a leading indicator of credential drift or attempted forgery.
- The audit row must include `event_id` (idempotency token) in the indexed `metadata` jsonb plus a top-level `correlationId = event_id` so queries align.

**Affected surface (ripple set)**
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts`
- `apps/billing-service/src/billing/controllers/stripe-webhook.service.ts` (handler audit per route case)
- `apps/observability-service/src/alerts/stripe-webhook-failure.alert.ts` (new)
- Coordination: BILLING-HIGH-004 in billing-expert's review

**Expected closer**
billing-expert WRITER + auth-security-expert CATCHER (signature-failure as security event).

---

### HIGH

#### AUDITTRAIL-HIGH-001 — Audit retention defaults to 90 days across auth + farm + admin services; SOC 2 CC4 minimum 5–7y
**Severity:** HIGH  
**Layer:** 3 (audit-trail-completeness invariant: retention)  
**State:** OPEN

**Evidence**
- `apps/auth-service/src/audit/audit-log.service.ts:112-129` — `@Cron(EVERY_DAY_AT_2AM)` calls `deleteOldLogs(retentionDays)` with default `90` days. Active deletion daily. Audit rows are explicitly *not* immutable in this table (no triggers).
- `apps/farm-service/src/database/services/audit-log.service.ts:44` — `private readonly DEFAULT_RETENTION_DAYS = 90;`
- `apps/admin-api-service/src/audit/audit.service.ts:438-453` — `purgeOldLogs(retentionDays)` accepts arbitrary days; no minimum guard.
- `apps/admin-api-service/src/security/controllers/audit-trail.controller.ts:165-201` — operator can configure retention policy via API (no minimum-floor enforcement on input).

**Rule violated**
audit-trail-completeness-auditor "Immutability + retention": *"retention 7 years minimum (SOC 2 CC4 alignment + most jurisdictions 5-7y)."* 90 days is 30x below the floor.

**Proposed fix direction**
- Tier-2 (make automatic): platform-wide `AUDIT_RETENTION_MIN_DAYS = 2557` (7y) constant; every retention-policy entry-point enforces ≥ this floor. Reject API requests below the floor with explicit error.
- Tier-3: ESLint rule on `retentionDays` literal arguments < 2557 in `*.service.ts`.
- Add a TimescaleDB hypertable migration on `shared.audit_logs` (1-week chunks, compression after 30d, drop_chunks after 7y) — coordinate with data-expert + observability-expert.

**Affected surface (ripple set)**
- `apps/auth-service/src/audit/audit-log.service.ts` (cron + default)
- `apps/farm-service/src/database/services/audit-log.service.ts`
- `apps/admin-api-service/src/audit/audit.service.ts` + `security/controllers/audit-trail.controller.ts`
- `libs/backend-common/src/audit/retention-policy.ts` (new)
- `apps/admin-api-service/src/migrations/{NEW}-AuditHypertable.ts` (TimescaleDB)

**Expected closer**
data-expert + compliance-expert co-WRITER.

---

#### AUDITTRAIL-HIGH-002 — Legacy `AuditLogInterceptor` is fire-and-forget; `auditLogService.record()` (non-await variant) used in interceptor path
**Severity:** HIGH  
**Layer:** 2 (audit synchronous-write invariant)  
**State:** OPEN  
**Sub-kind:** `FIRE_FORGET`

**Evidence**
- `libs/backend-common/src/audit/audit-log.service.ts:54-85` — `record(dto)` calls `repository.save(entity).catch(err => { failureCount++; logger.error(...); })`. Caller does not see the failure; counter is the only signal.
- `libs/backend-common/src/audit/audit-log.interceptor.ts:91, 137` — `tap({ next: () => this.recordAuditLog(...) })` runs AFTER the handler completes; `recordAuditLog` invokes `auditLogService.record()` (the fire-and-forget variant). On a process crash between handler-return and worker-flush, the audit row is lost.
- 6 services wire `AuditLogInterceptor` (alert-engine, hydroponics, hr, ai, billing, config, notification) — all 6 are exposed to silent loss on the legacy `@AuditLog()` decorator path.

**Rule violated**
"recordAwait synchronous invariant": *"Audit write MUST be awaited before the handler returns to client. Fire-and-forget = CRITICAL." Caveat: extreme-throughput paths may use outbox.* None of these legacy callers is extreme-throughput; they're tenant-admin / billing / HR. The CRITICAL classification is mitigated to HIGH only because the new `AuditedOperationInterceptor` (which IS awaited) is the architectural successor — but the legacy path remains in production while AUDITTRAIL-CRITICAL-002 closes.

**Proposed fix direction**
- Deprecate `AuditLogInterceptor` and `@AuditLog()` decorator. Migrate all `@AuditLog()` callsites to `@AuditedOperation()` (different shape: `resource` + `action` instead of `action` + `resource` + `description` — automated codemod possible). Once AUDITTRAIL-CRITICAL-002 wires `AuditedOperationModule` globally, remove the legacy interceptor + decorator.
- Until then, change `audit-log.interceptor.ts:137` to use `recordAwait` and re-throw failures so the consumer learns audit failed. Even fire-and-forget can still propagate a 500 to the client.

**Affected surface (ripple set)**
- `libs/backend-common/src/audit/audit-log.interceptor.ts`, `audit-log.service.ts`, `audit-log.module.ts`
- `libs/backend-common/src/decorators/audit-log.decorator.ts` (deprecate)
- 30+ callsites of `@AuditLog` in `apps/hr-service/src` (codemod target)

**Expected closer**
auth-security-expert WRITER + every domain expert CATCHER.

---

#### AUDITTRAIL-HIGH-003 — MFA step-up audit swallows DB failure silently
**Severity:** HIGH  
**Layer:** 2 (auth audit lifecycle)  
**State:** OPEN  
**Sub-kind:** `FIRE_FORGET`

**Evidence**
- `apps/auth-service/src/modules/authentication/services/mfa.service.ts:804-828` — `logMfaEvent` wraps `await auditLogService.log(...)` in try/catch; on failure: `this.logger.error(...)`. The MFA verify / step-up / lockout flow proceeds as if audit succeeded.
- 16 callsites at lines 312, 345, 355, 379, 392, 404, 442, 514, 546, 553, 563, 615, 641, 648, 657, 727 — including `MFA_VERIFY_FAILED`, `MFA_LOCKOUT`, `MFA_STEPUP_FAILED`, `MFA_STEPUP_LOCKOUT`, `MFA_STEPUP_SUCCESS` (all critical security events). Every one of these can silently lose audit on a DB blip.

**Rule violated**
"recordAwait() synchronous invariant" + "Mandatory coverage surfaces" #4: *"Every MFA STEP-UP emits audit row (method, success/fail, resulting-privilege-scope). Missing = HIGH."* Silent loss = effectively missing.

**Proposed fix direction**
- Remove try/catch in `logMfaEvent`; let failures propagate to the caller. The MFA step-up flow then becomes "MFA succeeds AND audit succeeds OR neither" — fail-closed posture appropriate for a security gate.
- Coordinate with auth-security-expert: the verify-failure path may legitimately want to allow the verify failure to be recorded even if audit DB is down (degraded auth still better than locked-out users). If so, write to `auth.audit_logs` AND emit a NATS `audit.fallback` event so a downstream consumer reconciles when DB recovers.

**Affected surface (ripple set)**
- `apps/auth-service/src/modules/authentication/services/mfa.service.ts:804-828`
- `apps/auth-service/src/modules/authentication/services/webauthn.service.ts:621` (same pattern)

**Expected closer**
auth-security-expert WRITER.

---

#### AUDITTRAIL-HIGH-004 — `access_logs` low-level HTTP audit stream absent
**Severity:** HIGH  
**Layer:** 2 (audit two-level pattern)  
**State:** OPEN

**Evidence** — repo-wide `grep "access_logs"` returns zero hits. Agent invariant calls for *"every HTTP request emits low-level access log to access_logs (separate stream, lower retention, includes method+path+status). Distinct from audit_logs which is semantic-action level."* Without this stream, request-level forensics for non-mutation reads (PII field reads via background jobs, admin dashboard queries, GDPR data exports) is unavailable.

**Proposed fix direction**
- Tier-3: introduce `LoggingMiddleware` writing to `shared.access_logs` (TimescaleDB hypertable, 90d retention) on every HTTP/GraphQL request post-handler. Distinct from audit_logs which captures semantic mutations. Include `method, path, status, duration, userId, tenantId, requestId, ip`.
- Coordinate with observability-expert (Prometheus access-log volume budgets) + data-expert (hypertable + retention).

**Affected surface (ripple set)**
- `libs/backend-common/src/middleware/access-log.middleware.ts` (new)
- `libs/backend-common/src/audit/access-log.entity.ts` (new)
- All app.module.ts middleware registration

**Expected closer**
platform-kernel-expert + observability-expert co-WRITER.

---

#### AUDITTRAIL-HIGH-005 — `farm.farm_audit_logs` and `auth.audit_logs` lack DB-level immutability triggers (only `messaging.compliance_audit_log` has them)
**Severity:** HIGH  
**Layer:** 3 (audit-trail-completeness immutability invariant)  
**State:** OPEN  
**Sub-kind:** `IMMUTABILITY_GAP`

**Evidence**
- `apps/messaging-service/src/migrations/1782000000000-AddTenantIsolationAndAuditImmutability.ts:104-117` — installs `prevent_audit_log_mutation()` BEFORE UPDATE OR DELETE on `compliance_audit_log`. Single survivor.
- `apps/farm-service/src/database/migrations/` — no immutability trigger on `farm_audit_logs`.
- `apps/auth-service/src/database/migrations/` — no immutability trigger on `auth.audit_logs`.
- `apps/admin-api-service/src/migrations/1787100000000-CreateAdminAuditLogsTable.ts:121` — `GRANT SELECT, INSERT, UPDATE, DELETE ON admin.audit_logs TO admin_service` — UPDATE + DELETE granted to the only role; no triggers. Note: admin.audit_logs IS the recipient of the legalHold-flagged rows migrated by 1787200000000, but it ALSO has no immutability triggers.

**Rule violated**
audit-trail-completeness-auditor immutability invariant — applied per audit table, not just `shared.audit_logs`.

**Proposed fix direction**
- Tier-1: install `audit_logs_prevent_update()` and `audit_logs_prevent_legal_hold_delete()` on every audit table. Standardize via shared migration helper in `libs/backend-common/src/database/migrations/audit-immutability.helper.ts` so per-service migrations call one function.
- Add CI invariant `tests/invariants/audit-immutability.spec.ts` that asserts every `*_audit_logs` table in pg_tables has both triggers.

**Affected surface (ripple set)**
- `libs/backend-common/src/database/migrations/audit-immutability.helper.ts` (new)
- `apps/auth-service/src/database/migrations/{NEW}-AuthAuditImmutability.ts`
- `apps/farm-service/src/database/migrations/{NEW}-FarmAuditImmutability.ts`
- `apps/admin-api-service/src/migrations/{NEW}-AdminAuditImmutability.ts`
- `tests/invariants/audit-immutability.spec.ts` (new)

**Expected closer**
data-expert WRITER.

---

#### AUDITTRAIL-HIGH-006 — `tap({ next })` audit emission in `AuditLogInterceptor` runs OUTSIDE the response observable's commit; on handler success but slow audit, response goes back before audit is durable
**Severity:** HIGH  
**Layer:** 2 (CQRS audit lifecycle ordering)  
**State:** OPEN  
**Sub-kind:** `FIRE_FORGET`

**Evidence**
- `libs/backend-common/src/audit/audit-log.interceptor.ts:87-104` — `next.handle().pipe(tap({ next: (result) => this.recordAuditLog(...) }))`. The `tap` runs as a side-effect during emission, but `recordAuditLog` calls `auditLogService.record()` (fire-and-forget) and returns `void`. Even if it called `recordAwait`, RxJS `tap` does not wait for promises — the response stream completes regardless.
- Compare to `AuditedOperationInterceptor` line 113-130: uses `switchMap(result => from(writeAuditEntry(...)).pipe(switchMap(() => [result])))` — this PROPERLY blocks emission until audit write resolves. The legacy interceptor's design is fundamentally racy.

**Rule violated**
recordAwait synchronous invariant.

**Proposed fix direction** — converges with AUDITTRAIL-HIGH-002 (deprecate legacy interceptor entirely once `AuditedOperationModule` is wired globally per AUDITTRAIL-CRITICAL-002).

**Expected closer** — auth-security-expert WRITER (same diff as HIGH-002).

---

### MEDIUM

#### AUDITTRAIL-MEDIUM-001 — Audit rows have no `preStateHash`/`postStateHash` for mutation integrity proof
**Severity:** MEDIUM (escalates to HIGH at 30d per agent invariant)  
**Evidence:** see AUDITTRAIL-CRITICAL-004 (subset). No mutation-integrity hash present anywhere in the audit pipeline. Closer: data-expert + every domain expert.

#### AUDITTRAIL-MEDIUM-002 — `auditLogService.record()` does not include the request `tenantId` from the JWT trust anchor when called from CQRS handlers without an HTTP context
**Severity:** MEDIUM  
**Evidence:** `libs/backend-common/src/audit/audited-operation.interceptor.ts:297-311` — for RPC/CQRS context, `tenantId` extracted via `command?.tenantId` (a property on the command object). If the command author forgets to populate `tenantId` in the command DTO, the audit row's `tenantId = null` even though TenantContextMiddleware resolved it earlier. Recommend reading from AsyncLocalStorage tenant-context store as the trust anchor.  
**Closer:** multi-tenant-saas-expert WRITER.

#### AUDITTRAIL-MEDIUM-003 — `AuditLogInterceptor` extracts tenantId from the `x-tenant-id` HEADER even when JWT user has tenantId
**Severity:** MEDIUM  
**Evidence:** `libs/backend-common/src/audit/audit-log.interceptor.ts:218` — `tenantId: user?.tenantId ?? (headers['x-tenant-id'] as string) ?? null`. Acceptable, but per CLAUDE.md "JWT claims are the trust anchor when an authenticated user is present" — header fallback should be guarded behind explicit pre-auth/cross-tenant-admin/edge-device contexts only. Otherwise a compromised intermediary that injects `x-tenant-id` can manipulate which tenant the audit row attributes to (read after `user?.tenantId` so JWT wins, but if `user?.tenantId` is null on a partially-authed path, header still wins).  
**Closer:** auth-security-expert + multi-tenant-saas-expert.

#### AUDITTRAIL-MEDIUM-004 — Sensor-service uses TypeORM `AuditSubscriber` (event-driven entity-mutation logger) — bypasses interceptor coverage entirely
**Severity:** MEDIUM  
**Evidence:** `apps/sensor-service/src/app.module.ts:101,138` — `AuditSubscriber` registered as TypeORM subscriber; entity-level CRUD events drive audit writes, not CQRS handlers. This means `@AuditedOperation` on sensor handlers (none currently) would double-record; also, entity-level audit captures only the persistence shape, not the semantic action. Document and standardize: subscriber-based audit is acceptable for ingestion fast-paths (per agent invariant outbox exception) but must emit the SAME row shape so cross-service queries align.  
**Closer:** sensor-service domain expert + auth-security-expert.

---

### LOW

#### AUDITTRAIL-LOW-001 — Sanitization key list inconsistent between `AuditLogInterceptor` (10 keys) and `AuditedOperationInterceptor` (12 keys)
**Severity:** LOW  
**Evidence:** `audit-log.interceptor.ts:25-36` SENSITIVE_KEYS (10) vs `audited-operation.interceptor.ts:26-39` SENSITIVE_KEYS (12: adds `apikey`, `privatekey`). Drift will widen. Centralize in `libs/backend-common/src/audit/sensitive-keys.ts`.  
**Closer:** auth-security-expert.

#### AUDITTRAIL-LOW-002 — IP not hashed for EU subjects; agent invariant requires region-gated hashing
**Severity:** LOW  
**Evidence:** `audit-log.entity.ts:137-139` `ip varchar(45) NULL` plaintext. Agent invariant: *"IP addresses: hash for EU subjects (GDPR); store plaintext otherwise (region-gated via tenant config)."* Region detection + hashing not implemented. GDPR Art 6/Art 32 alignment.  
**Closer:** compliance-expert + auth-security-expert.

---

## Pattern usage table — `@CommandHandler` vs audit decorator coverage

| Service | `@CommandHandler` count | `@AuditedOperation` | `@AuditLog` | Coverage % | AuditedOperationModule wired? | Net audit-row coverage |
|---|---|---|---|---|---|---|
| farm-service | 90 | 0 | 0 | 0% | NO | 0% |
| hr-service | 55 | 0 | 18 (resolvers, not handlers) | 33% (resolvers only) | NO | partial — interceptor fires, but fire-and-forget |
| messaging-service | 14 | 0 | 0 | 0% | NO | 0% (compliance_audit_log via subscriber covers some) |
| billing-service | 11 | 7 | 0 | 64% (decorator) | **NO — DECORATORS INERT** | **0%** |
| config-service | 4 | 0 | 0 | 0% | NO | 0% |
| observability-service | 3 | 0 | 0 | 0% | NO | 0% |
| admin-api-service | 3 | 0 | 0 | 0% | NO | 0% |
| **Total** | **180** | **7** | **18** | **3.9% / 10%** | **0/15** | **~1% effectively audited** |

## Cross-domain dependencies flagged

- **AUDITTRAIL-CRITICAL-001** → recommend invoking **legal-hold-auditor** (legalHold column dropped, restoration ripple) and **data-expert** (migration strategy + role grants) and **compliance-expert** (SOC 2 CC4 evidence break).
- **AUDITTRAIL-CRITICAL-002** → recommend invoking **platform-kernel-expert** (cross-service module wiring) and every domain expert for CATCHER on their `app.module.ts` diff.
- **AUDITTRAIL-CRITICAL-003** → recommend invoking **auth-security-expert** (primary on tenant.guard.ts), **multi-tenant-saas-expert** (dual-identity row shape on impersonation) and **legal-hold-auditor** (lifecycle linkage, override audit).
- **AUDITTRAIL-CRITICAL-004** → recommend invoking **data-expert** (entity + migration), **compliance-expert** (GDPR Art 30 record-of-processing fields), every domain-expert callsite ripple.
- **AUDITTRAIL-CRITICAL-005** → recommend invoking **billing-expert** (primary owner) — converges with their BILLING-HIGH-004; this auditor escalates to CRITICAL because of compounding loss with AUDITTRAIL-CRITICAL-002.
- **AUDITTRAIL-HIGH-001** → recommend invoking **compliance-expert** (SOC 2 CC4 7y minimum), **data-expert** (TimescaleDB hypertable migration).
- **AUDITTRAIL-HIGH-004** → recommend invoking **observability-expert** (access-log volume budget, Prometheus alerts) + **platform-kernel-expert** (middleware standardization).

## Verdict

**BLOCK.**

5 CRITICAL + 6 HIGH unresolved. The audit surface fails three structural invariants simultaneously:
- **Immutability** (DBR-CRITICAL-001 confirmed: triggers + grants + legalHold gone on shared.audit_logs).
- **Coverage** (only ~1% of CQRS handlers effectively audited; the decorator-driven contract is 100% inert; webhook auth boundary unaudited).
- **Retention** (90 days vs SOC 2 CC4 7y minimum on the three primary audit tables).

The original architectural intent (`@AuditedOperation` decorator + `AuditedOperationInterceptor` with awaited writes + transactional integration + DB-level immutability + 7y retention + dual-identity row + state-hash integrity proof) was correctly designed in the libs but has been operationally destroyed by:
1. The 1787200000000 realign migration's destructive recreate (deletes triggers, drops legalHold, re-grants UPDATE/DELETE to all roles).
2. Zero adoption of `AuditedOperationModule.forRoot()` in any service's app.module.ts.
3. Default 90-day retention + active daily DELETE crons.

This is not a small drift — it is the audit subsystem operating in **fail-open** mode. Any commit that mutates auth/tenant/billing must close at minimum AUDITTRAIL-CRITICAL-001 (immutability) and AUDITTRAIL-CRITICAL-002 (decorator wiring) before merge.

## References

- CLAUDE.md — "Behavioral Rules" (audit, retention, no-fire-and-forget).
- Layer-2 patterns — CQRS discipline + audit lifecycle.
- ADR-011 — schema ownership (shared schema canonical tables; `audit_logs` is one of the 4).
- audit-trail-completeness-auditor agent file — mandatory shape, immutability, recordAwait, decorator-driven contract.
- DBR-CRITICAL-001 (sibling, data-expert / data-boundary-reviewer) — root migration analysis.
- BILLING-HIGH-004 (sibling, billing-expert) — Stripe webhook signature failure no alert/audit.
- auth-security-expert — primary on `libs/backend-common/src/audit/**` (this auditor secondary reviewer for coverage + shape).
- legal-hold-auditor — running in parallel; AUDITTRAIL-CRITICAL-001 + AUDITTRAIL-CRITICAL-003 require coordination on `legalHold` + `relatedAuditIds` shape.
- compliance-expert — SOC 2 CC4 + GDPR Art 30 evidence-completeness coordination.

---

## Registry-anchor addenda (2026-04-29 closure cycle)

### AUDITTRAIL-HIGH-007 — farm-service audit retention default 90d → 7y compliance floor

**Status:** RESOLVED — closure tracked in `docs/reviews/_registry/findings.jsonl`.

farm-service `apps/farm-service/src/database/services/audit-log.service.ts:44`
declared `DEFAULT_RETENTION_DAYS = 90`, 30x below the SOC 2 CC4 audit-window
+ proof-preservation floor (5-7y), SOX § 802 (7y), PCI-DSS § 10.7 (multi-year
forensic), Mattilsynet aquaculture traceability (10y combined with legal-hold).
Cure: build-time constant raised to `7 * 365`. Operators retain
`FARM_AUDIT_LOG_RETENTION_DAYS` env-var override, but the floor moved from
the env layer to the build layer — forgetting the env var defaults to 7y,
not 90d. Sibling closure to AUDITTRAIL-HIGH-001 (auth-side, prior W0 cycle).
