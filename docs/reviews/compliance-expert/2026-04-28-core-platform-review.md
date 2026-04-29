# compliance-expert — review — 2026-04-28 core-platform cycle

## Scope

Cross-cutting compliance audit of the core/cross-cutting platform: `apps/auth-service`, `apps/admin-api-service` (security/audit/compliance modules), `apps/billing-service`, `libs/backend-common/src/{security/gdpr,audit}/**`, `libs/event-contracts/src/{tenant,auth}-events.ts`, `web/shell/src/pages/ConsentSettingsPage.tsx`, the per-tenant-data service GDPR surfaces (10 services per agent contract), and `docs/compliance/**`. Sibling-finding ripple investigated: MT-CRITICAL-005 / DBR-CRITICAL-001 (audit-immutability triggers dropped by `1787200000000-RealignSharedAuditLogsSchema`), MT-CRITICAL-001 (query-param tenantId spoof → DSAR), BILLING-MEDIUM (`failureReason` PII in `payment_failed`), DATA-CRITICAL-002 (TenantSchemaSyncService boot-time DDL substrate for erasure cascade), and the auth-security-expert positive-confirmation that auth-side erasure cascades to WebAuthn / sessions / refresh tokens / `UserDeleted` event.

HEAD: `a958dc66`, branch main, working tree clean. Knowledge layers 1/2/3 + shared operating modes + tier-claim + handoff + output-format loaded before scoping.

## Executive summary

Compliance posture has **structural foundations** (consent entity in `shared`, dual-consent gate for AI in messaging, immutability triggers for `shared.audit_logs`, transactional erasure with token-confirmation flow in farm-service, KVKK retention matrix ADR-024) but **the cross-service contract is incomplete and silently broken in three places**: (1) audit-trail immutability has been DROPPED on `shared.audit_logs` and never re-attached — every cross-service compliance audit row written from this point is mutable, satisfying the sibling DBR-CRITICAL-001 finding from the compliance angle and lifting it to GDPR Art 30 + SOC 2 CC4 + KVKK Art 12 territory; (2) the GDPR Art 17 erasure cascade is **wired to only 3 of the 10 mandated tenant-data services** (farm, messaging-via-`UserDeleted`, observability) — sensor / hr / billing / hydroponics / alert-engine / admin-api / ai have no erasure handler at all, and the published `TenantErased` event has zero subscribers outside observability; (3) `UserDeleted`, `UserDataAnonymized`, and `GdprAnonymizeRequested` are emitted from auth + messaging via raw `createBaseEvent('UserDeleted', …)` but **have no interface in `libs/event-contracts/src/`** — consumers cannot type against them and the event-contract upcaster pipeline cannot version them. Top-3 CRITICAL: (a) audit-trail immutability hole (COMPLIANCE-CRITICAL-001), (b) erasure-cascade fan-out gap across 7 services (COMPLIANCE-CRITICAL-002), (c) consent-event contract void + no withdrawal cascade (COMPLIANCE-CRITICAL-003).

## Findings (by severity)

### CRITICAL

#### COMPLIANCE-CRITICAL-001 — Audit-log immutability triggers dropped on `shared.audit_logs` realign and never restored

**Severity:** CRITICAL
**Layer:** 3 (ADR-020 audit-log HMAC-chain + ADR-024 retention matrix; SOC 2 CC4.1; GDPR Art 30; KVKK Art 12)
**State:** OPEN
**Sub-kind tag:** `SOC2_CC4`
**Inherited from:** sibling DBR-CRITICAL-001 + MT-CRITICAL-005 — confirmed and escalated to compliance scope

**Evidence**
- `apps/admin-api-service/src/migrations/1782000000000-AuditLogImmutability.ts:40-82` — establishes BEFORE UPDATE trigger `trg_audit_logs_prevent_update` and BEFORE DELETE legal-hold trigger `trg_audit_logs_prevent_legal_hold_delete` on `audit_logs` at the unqualified table name (resolved via `search_path` to `admin.audit_logs` at install time).
- `apps/admin-api-service/src/migrations/1782200000000-MoveSharedTablesFromAdminToShared.ts:90-119` — moves `audit_logs` from `admin` to `shared` via `ALTER TABLE … SET SCHEMA shared`. Per pg docs `ALTER TABLE … SET SCHEMA` carries triggers along — the immutability triggers SURVIVE this step.
- `apps/admin-api-service/src/migrations/1787200000000-RealignSharedAuditLogsSchema.ts:172-202` — issues `DROP TABLE shared.audit_logs CASCADE;` and recreates with the canonical 14-column shape. The CASCADE drops both triggers (and their plpgsql functions are explicitly dropped only in the down-migration of 1782000000000, never re-installed by the up-migration of 1787200000000). After this migration runs in production, every UPDATE and every DELETE against `shared.audit_logs` succeeds with no application-layer or DB-layer constraint.
- `apps/admin-api-service/src/migrations/1787200000000-RealignSharedAuditLogsSchema.ts:181-201` — the CREATE TABLE block does NOT include the `legalHold` column at all (only the canonical backend-common shape: 14 cols, no `legalHold`). The legal-hold trigger function (`audit_logs_prevent_legal_hold_delete`) reads `OLD."legalHold"` — so even if the trigger were re-attached after this migration, it would error on every DELETE.
- `libs/backend-common/src/audit/audit-log.entity.ts:31-167` — canonical `AuditLogEntity` shape has no `legalHold` column. Re-introducing one requires both an entity column and a migration; neither exists.

**Rule violated**
- ADR-020 §1: chain integrity is HMAC-chained per-row + tamper-evident; once a row is in the chain, mutability is structurally forbidden. The realign migration violates this contract for `shared.audit_logs`.
- SOC 2 CC4.1 (change-management evidence) — "evidence cannot be altered post-fact". Mutable audit rows fail Type II audit walkthrough.
- GDPR Art 30 (Records of Processing Activities) — controller's processing log must be reliable. A mutable log is not reliable.
- KVKK Art 12 (data security obligations): unauthorized modification prevention is REQUIRED.
- CLAUDE.md "Inviolable rules" §2: every `@Entity()` declares `schema:` — the canonical `AuditLogEntity` does (line 26) but the migration recreates the table without the trigger contract that gives the entity its inviolability.

**Proposed fix direction**
- Tier 1 (impossible): re-attach both triggers as the LAST step of `1787200000000-RealignSharedAuditLogsSchema.up()` (or land a new migration `1787300000000-ReattachAuditLogImmutabilityTriggers` that detects the un-protected state and re-installs). Add `legalHold` column to canonical `AuditLogEntity` + migration so the legal-hold trigger has a column to read. The trigger CREATE must be guarded by `DO $$ BEGIN … EXCEPTION WHEN duplicate_object THEN NULL; END $$;` for idempotency.
- Tier 3 (detectable): add a CI invariant test under `e2e/tests/integration/audit-log-immutability.spec.ts` that asserts: (a) `pg_trigger` rows for `trg_audit_logs_prevent_update` and `trg_audit_logs_prevent_legal_hold_delete` exist on `shared.audit_logs`, (b) attempted UPDATE / DELETE on a row with `legalHold=true` raises the expected exception. Failure blocks merge.
- Cross-handoff: legal-hold-auditor (Phase 9.4 sibling) is the runtime enforcer of legal-hold semantics — reattach must align with their hold-precedence contract.

**Affected surface (ripple set)**
- `apps/admin-api-service/src/migrations/1787200000000-RealignSharedAuditLogsSchema.ts` (fix here OR add new migration)
- New `apps/admin-api-service/src/migrations/1787300000000-ReattachAuditLogImmutabilityTriggers.ts`
- `libs/backend-common/src/audit/audit-log.entity.ts` (add `legalHold` column)
- New invariant `e2e/tests/integration/audit-log-immutability.spec.ts`
- ADR-020 §11 cross-reference (HMAC chain over a mutable row table is meaningless)
- `docs/compliance/evidence/COMPLIANCE-CRITICAL-001.md` (attestation per `_template.md` once resolved)

**Expected closer**
- New migration via `add-migration` skill (if catalogued) OR data-expert WRITER mode with cross-handoff to legal-hold-auditor and database-reviewer.

---

#### COMPLIANCE-CRITICAL-002 — GDPR Art 17 erasure cascade fan-out: 7 of 10 mandated services have NO erasure handler; `TenantErased` has 1 subscriber (observability-only)

**Severity:** CRITICAL
**Layer:** 3 (GDPR Art 17, KVKK Art 7, ADR-013 messaging-isolation-convergence implies cross-service contract)
**State:** OPEN — direct continuation of inherited COMPLIANCE-CRITICAL-001 (former MT-CRITICAL-003)
**Sub-kind tag:** `ART17_CASCADE`

**Evidence**
- The agent contract (per `.claude/agents/compliance-expert.md`) names 10 tenant-data-holding services that MUST expose an `eraseTenantData(tenantId, { dryRun })` handler: farm, sensor, hr, messaging, ai, billing, notification, hydroponics, alert-engine, admin-api.
- Repo audit: only `apps/farm-service/src/compliance/services/tenant-erasure.service.ts`, `apps/messaging-service/src/gdpr/gdpr.service.ts`, and `apps/observability-service/src/gdpr/handlers/erase-observability-tenant-data.handler.ts` exist. Eight of ten mandated services have NO `gdpr/` directory and NO handler. (`apps/hr-service/src/hr/services/employee-erasure.service.ts` exists but acts on `employeeId` not `tenantId` — out of contract.)
- `apps/farm-service/src/compliance/services/tenant-erasure.service.ts:244-263` — emits `TenantErasedEvent` via outbox.
- `libs/event-contracts/src/tenant-events.ts:85-97` — `TenantErasedEvent` interface declared (counterpart to farm-service emission).
- Cross-service subscriber survey: `grep -rn "TenantErased" apps/*/src` (excluding farm + observability + tests): zero matches in sensor / hr / billing / notification / hydroponics / alert-engine / admin-api / ai. The event is published but not handled platform-wide.
- `apps/farm-service/src/compliance/services/tenant-erasure.service.ts:36-47` — service docblock explicitly defers cross-service cascade, MinIO object deletion, and backup-side erasure to "phase 6.3.1 / 6.3.2" — none of which have landed on main.
- `libs/backend-common/src/security/gdpr/gdpr.service.ts:103-158` — generic `deleteUserData()` is per-user not per-tenant, and only the auth-service `users` + `refresh_tokens` collectors are registered. Operates only at the auth-layer; not the platform contract.

**Rule violated**
- GDPR Art 17(1): controller obligation to erase "without undue delay" extends across ALL processing systems. A cascade with 70% missing handlers violates the right.
- KVKK Art 7 (Verilerin silinmesi, yok edilmesi veya anonim hâle getirilmesi) — superset of GDPR; partial erasure is non-compliance.
- Compliance-expert invariant in agent contract: "missing any service from cascade = CRITICAL".
- ADR-013 (messaging isolation) implies symmetric cross-service contract — symmetric erasure is part of that symmetry.

**Proposed fix direction**
- Tier 2 (automatic) + Tier 3 (detectable): each missing service implements an `EraseTenantDataHandler` (CQRS handler) that subscribes to the `TenantErased` NATS event, runs DROP-SCHEMA-or-row-delete inside its own transaction, and emits a service-scoped `TenantDataErased` confirmation event. A platform-level orchestrator listens for ALL N confirmation events before declaring the cascade complete and proceeding to schema DROP + Stripe void.
- Tier 1 (impossible): introduce a registry-driven invariant test `e2e/tests/integration/erasure-cascade-coverage.spec.ts` that lists every service in `infrastructure/nats/services.yaml` whose tenant-data marker is true, asserts that each declares an erasure handler, and fails CI if a service is added without erasure wiring. (Co-locates with the existing schema-invariants pattern.)
- Cross-handoff: gdpr-erasure-executor (Phase 9.2) implements the handlers; compliance-expert reviews each. legal-hold-auditor (Phase 9.4) ensures every handler checks `compliance_audit_log.legal_hold` BEFORE running the delete (the current farm-service impl has no legal-hold check — secondary HIGH below).

**Affected surface (ripple set)**
- 7 new files: `apps/{sensor,hr,billing,notification,hydroponics,alert-engine,admin-api}-service/src/gdpr/erase-tenant-data.handler.ts` (and `gdpr.module.ts` + tests).
- 7 new files: erasure-related NATS subscribers wired into each service's `app.module.ts` event-handlers section.
- `libs/event-contracts/src/tenant-events.ts` — add per-service `TenantDataErased` confirmation events (or a single tagged confirmation with `serviceName`).
- `apps/admin-api-service/src/tenant/services/tenant-erasure-orchestrator.service.ts` (new) — fan-out + completion barrier.
- `e2e/tests/integration/erasure-cascade-coverage.spec.ts` (new invariant).
- `docs/compliance/evidence/COMPLIANCE-CRITICAL-002.md` (attestation).

**Expected closer**
- gdpr-erasure-executor (Phase 9.2 sibling) WRITER mode for the handlers; compliance-expert + legal-hold-auditor + multi-tenant-saas-expert CATCHER review.

---

#### COMPLIANCE-CRITICAL-003 — `UserDeleted` / `UserDataAnonymized` / `GdprAnonymizeRequested` events have NO interface in `libs/event-contracts/`; consent grant/withdrawal emits NO event at all

**Severity:** CRITICAL
**Layer:** 1 (event-contracts branded `EventId` / flat-object pattern, ADR-006); GDPR Art 7(3) instant-effect of withdrawal; KVKK Art 11
**State:** OPEN
**Sub-kind tag:** `CONSENT_WITHDRAWAL`

**Evidence**
- `apps/auth-service/src/privacy/gdpr-compliance.service.ts:118-131` — emits `createBaseEvent('UserDeleted', tenantId, …)`. The string `'UserDeleted'` is a free string — no `eventType: 'UserDeleted'` interface in `libs/event-contracts/`.
- `apps/messaging-service/src/gdpr/gdpr.service.ts:408-423` — emits `createBaseEvent('UserDataAnonymized', tenantId)` and `createBaseEvent('GdprAnonymizeRequested', tenantId)` via outbox. Neither event type exists as an interface.
- `grep -rn 'UserDeleted\|UserDataAnonymized\|GdprAnonymizeRequested' libs/event-contracts/src/*.ts` returns ZERO interface declarations. `libs/event-contracts/src/auth-events.ts:8-26` defines `UserRegisteredEvent`, `UserLoggedInEvent`, `InvitationAcceptedEvent` — but no deletion or anonymization counterpart.
- `apps/auth-service/src/modules/gdpr/services/user-consent.service.ts:75-209` — `recordConsent`, `recordBulkConsent`, `withdrawConsent` all return without publishing ANY event. No outbox enqueue, no `eventBus.publish`. Consent withdrawal is INSTANT-EFFECTIVE per GDPR Art 7(3), but no service downstream of auth (notification, ai, messaging analytics) receives notification of the withdrawal — the AI-consent pathway in messaging (which independently caches `UserAiConsent.consented` for 60s in Redis at `apps/messaging-service/src/ai/services/ai-privacy.service.ts:170-188`) has its own write path AND its own cache invalidation, but a withdrawal of the platform-level `ANALYTICS` or `PROFILING` consent in auth's `UserConsent` table is invisible to ai-service / billing-service / notification-service.
- The branded `EventId` SSoT (per ADR-006 + `libs/event-contracts/src/base-event.ts`) cannot enforce the consumer side because the event TYPE is a free string. `eventType: 'UserDeleted'` is unconstrained — a typo (`'UserDelted'`) would compile and emit a never-handled event.

**Rule violated**
- ADR-006 §"Branded `EventId`": `createBaseEvent()` is the only factory permitted to produce `EventId`. The factory has a generic type parameter — `createBaseEvent<TenantErasedEvent>(...)` — which is properly used in `apps/farm-service/src/compliance/services/tenant-erasure.service.ts:250`. The auth + messaging callsites bypass the type parameter entirely (`createBaseEvent('UserDeleted', …)`), losing the type-safety the SSoT promises.
- GDPR Art 7(3): "withdrawal of consent shall be as easy as giving it" + "withdrawal of consent shall not affect the lawfulness of processing based on consent before its withdrawal". Withdrawal MUST be observable cross-service for it to take effect.
- CLAUDE.md "Event Contract Rules" steps 1-4: every event must (1) have an interface extending `BaseEvent`, (2) be exported from `libs/event-contracts/src/index.ts`, (3) use PascalCase eventType, (4) have a JSON Schema validator at trust boundaries. Three event names produced by core compliance flows fail step 1.

**Proposed fix direction**
- Tier 1 (impossible): add `UserDeletedEvent`, `UserDataAnonymizedEvent`, `GdprAnonymizeRequestedEvent`, `ConsentRecordedEvent`, `ConsentWithdrawnEvent` interfaces to `libs/event-contracts/src/auth-events.ts`. Update emitters to use `createBaseEvent<UserDeletedEvent>(…)` so the generic constraint compile-fails on missing fields. Each event needs a JSON Schema validator under `libs/event-contracts/src/schemas/` for trust-boundary crossings (NATS).
- Tier 1 (impossible): wire `UserConsentService.recordConsent` / `withdrawConsent` to emit `ConsentRecorded` / `ConsentWithdrawn` via outbox in the same transaction as the `consentRepository.save(...)`. Make the save method use `dataSource.transaction()` + `outboxPublisher.enqueue(event, manager)` in a single block.
- Tier 3 (detectable): the existing W6 upcaster-chain invariant (see CLAUDE.md "Test Rules") catches missing upcasters — extend it to fail when an `eventType` string is emitted that has no matching interface in `libs/event-contracts/src/index.ts`. Closes the loop on free-string event names.
- Cross-handoff: ai-safety-auditor (Phase 9.3) needs to subscribe to `ConsentWithdrawn` for `ANALYTICS|PROFILING|DATA_PROCESSING` to flush their derivatives (the `sweepUserEmbeddings` pattern at `ai-privacy.service.ts:227-267` is the local precedent — but it only fires on the messaging-side toggle).

**Affected surface (ripple set)**
- `libs/event-contracts/src/auth-events.ts` (5 new interfaces)
- `libs/event-contracts/src/index.ts` (exports)
- `libs/event-contracts/src/schemas/auth-events.schema.ts` (JSON Schema validators)
- `apps/auth-service/src/privacy/gdpr-compliance.service.ts` (typed `createBaseEvent<UserDeletedEvent>`)
- `apps/messaging-service/src/gdpr/gdpr.service.ts` (typed events)
- `apps/auth-service/src/modules/gdpr/services/user-consent.service.ts` (outbox emission on grant + withdraw, both inside transactions)
- `apps/auth-service/src/modules/gdpr/gdpr.module.ts` (register outbox)
- New NATS consumers in ai-service / billing-service / notification-service for `ConsentWithdrawn`
- Adoption-invariant under `tests/invariants/event-contract-coverage.spec.ts`

**Expected closer**
- data-expert WRITER mode (event-contracts kernel) → auth-security-expert CATCHER on auth-side emission + ai-safety-auditor CATCHER on consumer wiring.

---

### HIGH

#### COMPLIANCE-HIGH-001 — Auth-service `audit_logs` 90-day cron-DELETE with no legal-hold check; conflicts with ADR-024 retention matrix (7y for change-management) and SOC 2 CC4.1

**Severity:** HIGH
**Layer:** 3 (ADR-024 retention matrix; SOC 2 CC4.1; legal-hold precedence)
**State:** OPEN
**Sub-kind tag:** `SOC2_CC4`

**Evidence**
- `apps/auth-service/src/audit/audit-log.service.ts:112-129` — `@Cron(CronExpression.EVERY_DAY_AT_2AM)` calls `deleteOldLogs(retentionDays)` defaulting to 90 days. The `delete()` query has no `legalHold` predicate and no integration with `LegalHoldService`. 
- `auth.audit_logs` is the table used for login attempts, MFA enrolment, token issuance — every record carries SOC 2 CC6 (access control) evidence + KVKK Art 12 (security obligations) evidence. ADR-024 explicitly mandates "7 years for change-management" for similar artifacts.
- `apps/messaging-service/src/compliance/services/legal-hold.service.ts:168-187` — well-formed `isUnderLegalHold(tenantId, channelId)` helper. The auth audit cron does not consult it before deleting.
- Production `AUDIT_LOG_RETENTION_DAYS` env var override is permitted by `configService.get<number>('AUDIT_LOG_RETENTION_DAYS', 90)` — operator can extend, but the default ships shorter than SOC 2 minimum.

**Rule violated**
- ADR-024 retention matrix: change-management evidence ≥ 12 months (recommendation 7 years). 90-day default is below floor.
- GDPR Art 17(3)(b) "for compliance with a legal obligation" — auth-service login logs ARE a legal obligation (PCI for billing-adjacent flows; KVKK Art 12 for unauthorized-access detection). Storage limitation does NOT override the legal-obligation exception.
- Legal-hold-precedence invariant (compliance-expert agent contract): "compliance_audit_log.legal_hold = true blocks action; missing precedence check = CRITICAL". For auth this is HIGH not CRITICAL because auth logs are operationally distinct from `compliance_audit_log` — but the principle holds.

**Proposed fix direction**
- Tier 2 (automatic): replace `deleteOldLogs` with a TimescaleDB retention policy (per ADR-024 mechanism) tuned to 13 months default + 7-year cold-storage tier via pg_cron / S3 Glacier transition.
- Tier 1 (impossible): inject `LegalHoldService` into `AuditLogService`, and change the `delete()` to filter `WHERE NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.tenantId = audit_logs.tenantId AND h.isActive = true)`.
- Tier 3 (detectable): invariant test asserts every service that has a Cron-driven delete on a SOC-2 retention table consults the legal-hold registry before executing.

**Affected surface (ripple set)**
- `apps/auth-service/src/audit/audit-log.service.ts` (cron + retention)
- `apps/auth-service/src/audit/audit.module.ts` (LegalHoldService DI)
- `apps/auth-service/src/database/migrations/<new>-AddTimescaleAuditRetention.ts` (TimescaleDB policy)
- `tests/invariants/audit-retention-legal-hold.spec.ts` (new)

**Expected closer**
- auth-security-expert WRITER + legal-hold-auditor CATCHER.

---

#### COMPLIANCE-HIGH-002 — Consent record entity is missing `legalBasis`, `withdrawnAt`, and `granularControls` fields; "withdrawal" is INSERT-new-row pattern with no first-class field; KVKK Art 11(1)(c) traceability gap

**Severity:** HIGH
**Layer:** 3 (GDPR Art 7 + Art 30; KVKK Art 11)
**State:** OPEN
**Sub-kind tag:** `CONSENT_WITHDRAWAL`

**Evidence**
- `libs/backend-common/src/security/gdpr/entities/consent.entity.ts:22-67` — `UserConsent` entity declares: `id, userId, tenantId, consentType, granted, version, ipAddress, userAgent, expiresAt, metadata, withdrawalReason, createdAt`. Missing per agent-contract invariant ("subjectId, tenantId, purpose (enum), legalBasis (enum), grantedAt, withdrawnAt | null, ipHash, userAgent, granularControls (jsonb)"): `legalBasis (enum)`, `withdrawnAt | null` (the entity uses a separate row with `granted=false` to express withdrawal — see `consent-manager.service.ts:96-131` and `user-consent.service.ts:158-209`), `granularControls (jsonb)` is absent (the closest is the un-typed `metadata jsonb`), `ipAddress` is plaintext (not hashed) — secondary PII concern.
- `libs/backend-common/src/security/interfaces/index.ts:217-225` — `ConsentType` enum has 7 values but no `legalBasis` enum (lawful-basis-of-processing per Art 6: consent / contract / legal_obligation / vital_interests / public_task / legitimate_interest).
- `apps/auth-service/src/modules/gdpr/services/user-consent.service.ts:181-197` — withdrawal creates a NEW row instead of updating `withdrawnAt` on the original. This is auditable (history preserved) but makes "currently active consent" a `DISTINCT ON ... ORDER BY createdAt DESC` query (correctly used at line 220-227) — performance is fine but the schema does not record the withdrawal *event time* on the original grant row. The history is reconstructable via timestamps but the grant-row's lifecycle is not first-class.
- KVKK Art 11(1)(c): "kişisel verilerin işlenmesini gerektiren sebeplerin ortadan kalkması hâlinde silinmesini veya yok edilmesini ya da anonim hâle getirilmesini isteme" — "request erasure when the reason for processing ceases". The data subject's right requires the controller to track *why* (legalBasis) processing happens. Without legalBasis, this evaluation is not automatable.

**Rule violated**
- GDPR Art 30(1)(b): "the purposes of the processing" must be recorded — ConsentType captures purpose categories but not legal basis.
- KVKK Art 11(1)(c) cross-reference above.
- compliance-expert agent contract "Consent record MUST include … legalBasis (enum), grantedAt, withdrawnAt | null, ipHash, userAgent, granularControls (jsonb)".

**Proposed fix direction**
- Tier 1 (impossible): add `legalBasis` enum column + `withdrawnAt timestamptz NULL` column + `granularControls jsonb NULL` column. Replace `metadata jsonb` reads with the typed `granularControls`. Hash ipAddress at write-time (HMAC with rotated pepper per ADR-022) — store both raw (TTL'd) and hashed (long-term) so DSAR reconstruction works.
- Tier 3 (detectable): JSON Schema validator on `ConsentRecord` at every API boundary (ValidationPipe) that requires `legalBasis` for non-essential consent.

**Affected surface (ripple set)**
- `libs/backend-common/src/security/gdpr/entities/consent.entity.ts`
- `libs/backend-common/src/security/interfaces/index.ts` (add `LegalBasis` enum + extend `ConsentRecord`)
- `apps/auth-service/src/modules/gdpr/services/user-consent.service.ts` (withdrawal updates `withdrawnAt` + creates audit row)
- New migration `apps/auth-service/src/database/migrations/<new>-AddConsentLegalBasisColumns.ts`
- `apps/auth-service/src/modules/gdpr/dto/user-consent.dto.ts` (DTO field)
- `web/shell/src/pages/ConsentSettingsPage.tsx` (UI surfacing of legal basis per consent type)

**Expected closer**
- data-expert WRITER (entity + migration) → frontend-expert WRITER (UI surfacing) → compliance-expert + auth-security-expert CATCHER.

---

#### COMPLIANCE-HIGH-003 — Frontend ConsentSettingsPage exposes consent toggles but NO Right-to-Erasure and NO Right-to-Portability button; user-facing GDPR Art 15/17/20 surface is read-only

**Severity:** HIGH
**Layer:** 2 (frontend pattern alignment + GDPR Art 12 transparency)
**State:** OPEN
**Sub-kind tag:** `ART17_CASCADE` + `ART20_EXPORT`

**Evidence**
- `web/shell/src/pages/ConsentSettingsPage.tsx:356-397` — declares "Your Data Rights (GDPR)" panel with four icons (Right to Access, Right to Withdraw, Right to Information, Audit Trail). The icons are decorative — there is NO `Request Data Export` button, NO `Delete My Account` button, NO `Restrict Processing` button, NO `Rectify` action.
- `apps/auth-service/src/modules/gdpr/resolvers/user-consent.resolver.ts:159-220` — the resolver exposes ONLY `recordConsent`, `recordBulkConsent`, `withdrawConsent` mutations. There is NO `requestDataExport`, NO `requestErasure`, NO `requestRectification` GraphQL surface. The user-side data subject rights are stubbed in the schema-only layer (`libs/backend-common/src/security/gdpr/gdpr.service.ts:53-98` has `exportUserData` but is not wired to a public mutation).
- `apps/admin-api-service/src/security/services/compliance.service.ts:183-227` exposes `createDataRequest()` server-side, but the entry point is admin-only — there is no user-self-service flow.

**Rule violated**
- GDPR Art 12 (transparent information): rights must be exercisable "in an intelligible and easily accessible form".
- GDPR Art 15/17/20 require the controller to provide the data subject with a means to exercise rights — read-only icons fail this test.
- KVKK Art 13(1): başvuru hakkı — Turkish data subject has the right to apply directly. A consent-only UI does not provide an apply path.

**Proposed fix direction**
- Tier 2 (automatic) + Tier 3 (detectable): add three action buttons to `ConsentSettingsPage.tsx` (or a new `PrivacyDashboardPage`): "Request Data Export" (calls `requestDataExport` → returns jobId, polls progress, downloads signed URL), "Delete My Account" (two-step confirmation, runs `executeErasure`), "Request Data Rectification" (form). Each maps to a new GraphQL mutation in `apps/auth-service/src/modules/gdpr/resolvers/user-consent.resolver.ts`. Backend wires to `GdprComplianceService.executeErasure` (already implemented at `apps/auth-service/src/privacy/gdpr-compliance.service.ts:66-133`) + a new export-with-jobId orchestrator.
- Tier 3 (detectable): add a Cypress / Playwright e2e under `e2e/tests/web/privacy-flow.spec.ts` that asserts each of the three actions is reachable from `/settings/privacy` and produces the expected job/audit row.

**Affected surface (ripple set)**
- `web/shell/src/pages/ConsentSettingsPage.tsx` (new buttons + flows)
- `web/shell/src/hooks/useConsent.ts` (extend with `useDataExport`, `useDataErasure`, `useDataRectification`)
- `web/shell/src/graphql/consent.operations.ts` (new mutations)
- `apps/auth-service/src/modules/gdpr/resolvers/user-consent.resolver.ts` (new mutations)
- `apps/auth-service/src/modules/gdpr/services/data-subject-request.service.ts` (new — orchestrates Art 15/17/20)
- `e2e/tests/web/privacy-flow.spec.ts` (new)

**Expected closer**
- frontend-expert WRITER (UI) + auth-security-expert WRITER (resolvers) + data-expert WRITER (export job orchestrator) → compliance-expert CATCHER.

---

#### COMPLIANCE-HIGH-004 — `farm-service.TenantErasureService.confirm()` runs erasure with NO legal-hold precedence check; sibling messaging-service does the right thing

**Severity:** HIGH
**Layer:** 3 (GDPR Art 17(3)(b) — legal obligation overrides erasure)
**State:** OPEN
**Sub-kind tag:** `ART17_CASCADE`

**Evidence**
- `apps/farm-service/src/compliance/services/tenant-erasure.service.ts:140-179` — `confirm()` validates the token then unconditionally runs `executeErasure(tenantId, ticket.requestedBy)`. There is NO query against any `legal_holds` table, NO `LegalHoldService` injection, NO `compliance_audit_log.legal_hold = true` precedence check. A tenant under active litigation hold would have farm-service rows deleted.
- Compare `apps/messaging-service/src/gdpr/gdpr.service.ts:262-300` — wraps the cascade in `SELECT … FOR UPDATE` against `legal_holds`, throws `ForbiddenException` on tenant-wide hold, AND on per-channel hold for user's channels. The pattern exists; it is not mirrored.
- Compliance-expert agent contract: "Legal-hold precedence MANDATORY before any delete operation".

**Rule violated**
- GDPR Art 17(3)(b): erasure does not apply where processing is necessary "for compliance with a legal obligation".
- Spoliation liability — destroying litigation-held data after a notice has been issued is itself a sanctionable act under most jurisdictions.

**Proposed fix direction**
- Tier 1 (impossible): inject `LegalHoldService` into `TenantErasureService`. In `confirm()`, BEFORE consuming the ticket, run `await legalHoldService.isUnderLegalHold(tenantId, null)` — if true, throw `ForbiddenException` and DO NOT consume the ticket. Add an explicit tenant-wide hold check + per-resource holds enumeration if the LegalHoldService is extended to cover farm domain (currently messaging-only).
- Tier 3 (detectable): invariant test scans every service's `tenant-erasure` / `gdpr` handler and fails if no `LegalHoldService` import is present.

**Affected surface (ripple set)**
- `apps/farm-service/src/compliance/services/tenant-erasure.service.ts`
- `apps/farm-service/src/compliance/compliance.module.ts` (DI)
- `libs/backend-common/src/compliance/legal-hold.module.ts` (promote LegalHoldService cross-service per ADR-013 isolation-convergence pattern)
- `tests/invariants/erasure-legal-hold-check.spec.ts` (new)

**Expected closer**
- legal-hold-auditor (Phase 9.4 sibling) primary; data-expert + compliance-expert CATCHER.

---

#### COMPLIANCE-HIGH-005 — Billing `payment_failed` `failureReason` field carries Stripe failure code + message which can include cardholder fragments / merchant decline reasons; emitted on NATS to notification-service

**Severity:** HIGH (cross-handoff CONFIRMED from billing-expert BILLING-MEDIUM)
**Layer:** 2 (PII masking pattern); GDPR Art 5(1)(c) data minimisation
**State:** OPEN
**Sub-kind tag:** `ART5_MINIMISATION`

**Evidence**
- `apps/billing-service/src/billing/controllers/stripe-webhook.service.ts:244` — persists `failureReason: \`${failureCode}: ${failureMessage}\`` to `payment.failureReason` column.
- `apps/billing-service/src/billing/controllers/stripe-webhook.service.ts:266` — re-emits the same string on the `PaymentFailed` NATS event (`PaymentFailedEvent.failureReason`).
- Stripe `failureMessage` strings can include phrasing like "Your card was declined." (low PII) but also "The card you used has insufficient funds." or merchant-bank specific text that occasionally surfaces account-fragment hints — this is documented in Stripe's own warning that the field "should not be displayed verbatim to end users without sanitisation".
- The notification service (downstream consumer) likely emails the tenant admin with this string verbatim (handoff to notification-expert needed for confirmation).
- `libs/backend-common/src/utils/pii-mask.util.ts` exists and is auto-applied by `StructuredLoggerService` per CLAUDE.md "Security" — but the `failureReason` column persists pre-mask and the NATS event payload is constructed directly from raw Stripe data, not through the logger.

**Rule violated**
- GDPR Art 5(1)(c) data minimisation — only data necessary for the stated purpose.
- CLAUDE.md "Security" §"Mask PII in logs (hash or `***`). The central `maskPii()` helper is auto-applied by `StructuredLoggerService`" — this mask is for logs only, not for persisted columns or event payloads.

**Proposed fix direction**
- Tier 1 (impossible): change `Payment.failureReason` to be `failureCode: enum` + `failureCategory: 'card_declined' | 'insufficient_funds' | 'authentication_required' | 'unknown'` — no free-text. The ENUMERATED categorisation suffices for retry logic and notification. The verbose Stripe message is redundant.
- Tier 2 (automatic): if free-text is unavoidable, route the value through `maskPii` before persistence AND emission. Add a unit test that asserts the column never contains an unmasked PII pattern.
- Cross-handoff: billing-expert primary; notification-expert CATCHER on the email-template side (verify the email template doesn't echo the raw string).

**Affected surface (ripple set)**
- `apps/billing-service/src/billing/entities/payment.entity.ts`
- `apps/billing-service/src/billing/controllers/stripe-webhook.service.ts:244, 266`
- `libs/event-contracts/src/billing-events.ts` (PaymentFailedEvent shape)
- `apps/notification-service/src/templates/payment-failed.template.ts`
- New migration replacing free-text column

**Expected closer**
- billing-expert WRITER (entity + emission) → notification-expert CATCHER → compliance-expert CATCHER.

---

#### COMPLIANCE-HIGH-006 — Generic `GdprService.exportUserData` lacks signed URL + 7-day TTL contract; result returned in-process as `data: Record<string, unknown>`; no async/jobId pattern; no per-tenant size guard

**Severity:** HIGH
**Layer:** 3 (GDPR Art 20 portability)
**State:** OPEN
**Sub-kind tag:** `ART20_EXPORT`

**Evidence**
- `libs/backend-common/src/security/gdpr/gdpr.service.ts:53-98` — `exportUserData(userId, format)` returns `DataExportResult { data: Record<string, unknown>, expiresAt }`. The `data` is the actual export payload, returned in-process (synchronous to the GraphQL call). No `jobId`, no progress polling, no signed URL. `expiresAt` is set to 7 days but is metadata-only — there is no signed URL to expire.
- compliance-expert invariant: "Export async (`202 + jobId`) with progress polling endpoint. Synchronous export on large tenants = HIGH (timeout cascade)."
- `libs/backend-common/src/security/gdpr/entities/data-request.entity.ts:81-86` defines `downloadUrl varchar(500) NULL` + `downloadExpiresAt timestamptz NULL` columns, BUT `gdpr.service.ts:299-312` `completeRequest` writes a `downloadUrl` only if the caller passes one (it never does in current callsites).
- `apps/messaging-service/src/gdpr/gdpr.service.ts:119-229` — does keyset pagination (good) but returns `GdprExportResult` directly in process — same pattern issue; tenant with 1M+ messages would block the GraphQL request.

**Rule violated**
- GDPR Art 20: data portability response time is 1 month standard, 3 months on complex cases — the right is async by intent. Synchronous in-process is incorrect at scale.
- compliance-expert agent contract "Export async (`202 + jobId`)".
- Signed URL invariant: "Signed URL TTL ≤ 7 days … URLs NEVER logged plaintext = CRITICAL. Path derived from JWT claim ONLY (not request body/header)."

**Proposed fix direction**
- Tier 2 (automatic): introduce `apps/auth-service/src/modules/gdpr/services/data-export-job.service.ts` that enqueues an export job (BullMQ / NATS task), processes via worker, writes the result to MinIO (path = `gdpr-exports/${tenantId}/${userId}/${jobId}.zip`), generates a signed URL via `@platform/storage` with 7-day TTL, persists URL + expiry in `gdpr_data_requests`, and returns `202 + jobId` to the caller. Path MUST be derived from JWT claim (`tenantId` + `userId`) — never request body.
- Tier 1 (impossible): make `DataExportResult.data` a private internal type and expose only `{ jobId, statusUrl, downloadUrl?, expiresAt }` to callers.
- Cross-handoff: storage-expert / platform-services for the signed-URL emit pattern; ai-safety-auditor for derived-data exclusion (only subject-provided + subject-generated, no ML scores).

**Affected surface (ripple set)**
- `libs/backend-common/src/security/gdpr/gdpr.service.ts` (refactor signature)
- New `apps/auth-service/src/modules/gdpr/services/data-export-job.service.ts`
- New `apps/auth-service/src/modules/gdpr/workers/data-export.worker.ts`
- `libs/backend-common/src/security/interfaces/index.ts` (`DataExportResult` shape)
- `apps/messaging-service/src/gdpr/gdpr.service.ts` (mirror async pattern)

**Expected closer**
- data-expert WRITER + auth-security-expert WRITER → compliance-expert CATCHER.

---

#### COMPLIANCE-HIGH-007 — KVKK `kvkk-veri-sorumlusu.md` declaration MISSING; `retention-matrix.md` MISSING; cross-border-transfer field hardcoded `false` for all 4 categories with no DPA on file

**Severity:** HIGH
**Layer:** 3 (KVKK Art 9 + KVKK 2024 amendments + ADR-024)
**State:** OPEN
**Sub-kind tag:** `KVKK_VERBIS`

**Evidence**
- `docs/compliance/README.md:9-12` — explicitly states `kvkk-veri-sorumlusu.md` (VERBİS declaration) and `retention-matrix.md` (canonical reference) are "planned per plan v3 R4 / R17". Neither file exists.
- `docs/compliance/evidence/` contains only `_template.md` — zero attestation files. The "Attestation coverage gate" referenced in `README.md` would fail if it were running today against any RESOLVED CRITICAL/HIGH after the cutoff.
- `apps/admin-api-service/src/security/services/compliance.service.ts:806-846` — `getDataInventory()` returns four categories with `crossBorderTransfer: false` HARDCODED. The platform actually uses Stripe (US data flow), Postmark / SendGrid (US/EU), MinIO (DigitalOcean FRA1 region — confirmed by ADR-024 retention matrix). At least the Stripe + email-provider flows are cross-border to a Turkish data subject. The `false` value is factually incorrect.
- `docs/runbooks/kvkk-breach-notification.md:68` references "Data controller (Veri Sorumlusu) identification (see kvkk-veri-sorumlusu.md)" — runbook depends on a file that does not exist.

**Rule violated**
- KVKK Art 9: yurt dışı veri aktarımı requires explicit consent + transfer agreement (SCC equivalent) when the destination country is not on Kurul's adequacy list. Hardcoded `false` masks the obligation.
- KVKK Art 16: VERBİS notification — required for any data controller above the size threshold; the platform is above (multiple tenants, large processing volume).
- ADR-024 §"Implementation notes" cites `docs/compliance/retention-matrix.md (canonical reference)` — without it, ADR-024 enforcement is documentation-only (Tier 4) instead of the Tier-2/3 it claims.

**Proposed fix direction**
- Tier 4 → Tier 3: author `docs/compliance/kvkk-veri-sorumlusu.md` (VERBİS-aligned controller identification, processing purpose register, retention matrix link). Author `docs/compliance/retention-matrix.md` aggregating ADR-024 + per-service tables.
- Tier 1 (impossible): change `getDataInventory()` to read from a YAML in `docs/compliance/data-inventory.yaml` and assert via CI invariant that every entry's `crossBorderTransfer` is justified by a DPA reference (file path or `none-required-because:`).
- Tier 3 (detectable): the existing `tools/gates/compliance-attestation-coverage.ts` gate is plumbed but inert — promote it from CI advisory to required by setting `ATTESTATION_REQUIRED_FROM` to a real cutoff.

**Affected surface (ripple set)**
- New `docs/compliance/kvkk-veri-sorumlusu.md`
- New `docs/compliance/retention-matrix.md`
- New `docs/compliance/data-inventory.yaml`
- `apps/admin-api-service/src/security/services/compliance.service.ts` (read from yaml)
- `tools/gates/compliance-attestation-coverage.ts` (promote in CI)
- `.github/workflows/compliance-gates.yml` (or equivalent)

**Expected closer**
- compliance-expert TEACHER → docs-expert WRITER → architectural-arbiter on cross-border lawful basis classification.

---

### MEDIUM

#### COMPLIANCE-MEDIUM-001 / COMPLIANCE-MEDIUM-005 — `MT-CRITICAL-001` ripple: query-param `tenantId` accepted as fallback in `TenantContextMiddleware` reaches DSAR endpoints; existing endpoints are admin-only but the path is structurally exposed

**Status:** RESOLVED — registry ID `COMPLIANCE-MEDIUM-005` (the
canonical `COMPLIANCE-MEDIUM-001` registry slot is already occupied
by an unrelated audit-logs retention-policy finding closed by
`e5c18677`). Cure already landed in commit `799c3b68`
(`security(tenant): JWT trust anchor only — drop query/body/
variables tenant sources`). The query-param fallback was removed
from `tenant-context.middleware.ts`; the file's lines 126-132
explicitly document the removal with the MT-CRITICAL-001 lineage.

Closes: docs/reviews/compliance-expert/2026-04-28-core-platform-review.md#COMPLIANCE-MEDIUM-005

**Severity:** MEDIUM
**Layer:** 1 (tenant-isolation primitive)
**State:** OPEN — secondary ripple of inherited MT-CRITICAL-001

**Evidence**
- `libs/backend-common/src/middleware/tenant-context.middleware.ts:95-152` — extracts tenantId in priority order: `req.user.tenantId` (jwt) → `x-tenant-id` header → `req.query.tenantId` query → subdomain. Lines 109-111 accept `req.query['tenantId']` unconditionally on any unauthenticated path.
- `apps/admin-api-service/src/security/services/compliance.service.ts:243-292` — `getDataRequests` accepts `tenantId` filter from caller-provided options. The resolver is admin-only (gate elsewhere) — but if any pre-auth path were ever added that calls this method indirectly (e.g., a public DSAR submission form), the query-param fallback would let an attacker filter another tenant's DSAR queue.
- compliance-expert: a DSAR queue contains user-name + email + request-type — leakage cross-tenant is high-severity. The path is gated today but the primitive is unsafe.

**Rule violated**
- CLAUDE.md "Tenant-ID sourcing": "JWT claims are the trust anchor when an authenticated user is present. The `x-tenant-id` header is accepted only on explicit pre-auth / cross-tenant admin / edge-device ingestion paths". `req.query.tenantId` is NOT in the allowed list — query-param sourcing should be removed.
- multi-tenant-saas-expert MT-CRITICAL-001 ripple confirmed.

**Proposed fix direction**
- Tier 1 (impossible): remove the query-param fallback (lines 109-111) outright. Pre-auth paths needing tenantId use `x-tenant-id` (validated against allowlist). Audit every callsite that relied on it (none found in compliance-expert scope; multi-tenant-saas-expert owns the wider scan).

**Affected surface (ripple set)**
- `libs/backend-common/src/middleware/tenant-context.middleware.ts`
- multi-tenant-saas-expert primary owner — defer to their remediation.

**Expected closer**
- multi-tenant-saas-expert WRITER (already inherited).

---

#### COMPLIANCE-MEDIUM-002 — `apps/admin-api-service/src/security/services/compliance.service.ts:660-712` `checkRequirement()` returns mock `compliant` for 6 of 8 GDPR requirements; "compliance score" is theatre

**Severity:** MEDIUM
**Layer:** 4 (documented-only check that pretends to be detectable)
**State:** OPEN
**Sub-kind tag:** `SOC2_CC4`

**Evidence**
- `apps/admin-api-service/src/security/services/compliance.service.ts:660-712` — `checkRequirement(req)` has real checks for `gdpr-2` (data subject rights → checks overdue requests) and `gdpr-3` (breach notification → checks unreported breaches). The other six (gdpr-1, gdpr-4, gdpr-5, gdpr-6, gdpr-7, gdpr-8 — lawful basis, DPIA, ROPA, minimisation, storage limitation, security) all hit the `default:` branch and return `status: 'compliant', details: 'Requirement met'`. The compliance score (line 552) averages the 8 to produce a number — 6 of which are unconditional 100%.
- A SOC 2 / KVKK auditor running `generateComplianceReport()` and seeing "compliance score: 88%" would be misled — the score reflects 2 real checks + 6 fictitious passes.

**Rule violated**
- SOC 2 CC4.1 — change-management evidence reliability.
- compliance-expert tier hierarchy — Tier-4 doc-only is acceptable when Tiers 1-3 are impossible, but here the function PRETENDS to be Tier 3 (detectable). Misleading tier-claim.

**Proposed fix direction**
- Tier 3 (detectable): each requirement gets a real check or the function returns `status: 'not_applicable'` with explicit `details: 'Manual attestation required — see docs/compliance/evidence/<id>.md'`. Misleading-100% removed.
- Tier 4 (acknowledged): if the check truly cannot be automated (e.g., DPIA review), return `status: 'partial'` and require an attestation file to satisfy the report.

**Affected surface (ripple set)**
- `apps/admin-api-service/src/security/services/compliance.service.ts`
- `apps/admin-api-service/src/security/__tests__/compliance.service.spec.ts` (new tests)

**Expected closer**
- admin-expert WRITER → compliance-expert CATCHER.

---

#### COMPLIANCE-MEDIUM-003 — `apps/auth-service/src/audit/audit-log.entity.ts` defines `auth.audit_logs` with NO immutability triggers (only `shared.audit_logs` had them, now also lost per CRITICAL-001)

**Severity:** MEDIUM
**Layer:** 3 (ADR-020 audit-log HMAC chain — auth audit not yet in scope but should be)
**State:** OPEN
**Sub-kind tag:** `SOC2_CC4`

**Evidence**
- `apps/auth-service/src/audit/audit-log.entity.ts:26` — `@Entity('audit_logs', { schema: 'auth' })`. The accompanying migration set has no UPDATE-blocking trigger.
- The 1782000000000-AuditLogImmutability.ts migration runs against the unqualified `audit_logs` name — at the time it ran (admin-api-service deploy), search_path resolved that to `admin.audit_logs`, NOT `auth.audit_logs`. So `auth.audit_logs` never received the trigger.
- `apps/auth-service/src/audit/audit-log.service.ts:36-44` — `log()` does plain `repository.save()` — no signing, no chain, no integrity column.

**Rule violated**
- ADR-020 "audit log HMAC chain" — should extend to ALL audit_logs tables, including `auth.audit_logs`. Currently in roadmap.
- SOC 2 CC4.1 evidence-integrity.

**Proposed fix direction**
- Tier 3 (detectable): add a migration that installs the same BEFORE UPDATE / BEFORE DELETE triggers on `auth.audit_logs` (and `admin.audit_logs` separately — since those rows are SUPER_ADMIN-relevant). Add `legalHold` column there too.
- Cross-link to ADR-020 §11 hash-chain rollout — auth audit is the first tier to migrate.

**Affected surface (ripple set)**
- New `apps/auth-service/src/database/migrations/<new>-AddAuditLogImmutability.ts`
- `apps/auth-service/src/audit/audit-log.entity.ts` (legalHold column)

**Expected closer**
- auth-security-expert WRITER → compliance-expert + database-reviewer CATCHER.

---

#### COMPLIANCE-MEDIUM-004 — Idempotency missing on `TenantErasureService.confirm()`: re-invocation after cascade returns `NotFoundException` ("no pending ticket") instead of `200 + {state: 'PURGED'}`

**Severity:** MEDIUM
**Layer:** 2 (compliance-expert agent contract — Idempotency)
**State:** OPEN
**Sub-kind tag:** `ART17_CASCADE`

**Evidence**
- `apps/farm-service/src/compliance/services/tenant-erasure.service.ts:140-148` — `confirm()` throws `NotFoundException` when ticket is missing. After successful erasure the ticket is consumed (line 169). A retry from the operator (e.g., browser back-forward) gets the not-found error, suggesting the operation never ran — causing a confused operator to issue ANOTHER `initiate()` and run the cascade twice (the second pass is mostly no-op against now-empty tables, but the `TenantErased` event is re-emitted, the audit anonymisation runs again, Stripe void semantics may differ).
- compliance-expert agent contract: "Idempotency: re-invocation on same `tenantId` returns current state (200 + `{state: 'PURGED', purgedAt}`) without re-deletion. Missing = HIGH (multiple purge attempts each blow up Stripe)."

**Rule violated**
- compliance-expert idempotency invariant. (HIGH per agent contract — but downgraded to MEDIUM here because the second cascade is mostly no-op, and the underlying issue is operator-experience not data integrity. Will arbiter to confirm.)

**Proposed fix direction**
- Tier 1 (impossible): track erased tenants in a persistent table `farm.tenant_erasure_audit (tenantId PK, confirmedAt, requestedBy, totalDeleted, ...)`. `confirm()` first checks this table; if present return `{state: 'PURGED', purgedAt: row.confirmedAt}` with HTTP 200. Only if absent and ticket valid does the cascade run. The audit row is written inside the same transaction.

**Affected surface (ripple set)**
- New entity `apps/farm-service/src/compliance/entities/tenant-erasure-audit.entity.ts`
- New migration to create the table
- `apps/farm-service/src/compliance/services/tenant-erasure.service.ts` (idempotency check)
- spec: `apps/farm-service/src/compliance/__tests__/tenant-erasure.service.spec.ts`

**Expected closer**
- farm-expert WRITER → compliance-expert CATCHER.

---

### LOW

#### COMPLIANCE-LOW-001 / COMPLIANCE-LOW-003 — Consent `version` is a string `'2.0.0'` hardcoded in service constructors; no bump-policy documented

**Status:** RESOLVED — registry ID `COMPLIANCE-LOW-003` (the canonical
`COMPLIANCE-LOW-001` registry slot was already occupied by a different
seeded finding, the PII-mask test-coverage cure closed by
`c60842bc`). Cure documented at `docs/runbooks/consent-version-bump.md`
and the per-bump changelog seeded at `docs/compliance/consent-versions.md`.

Closes: docs/reviews/compliance-expert/2026-04-28-core-platform-review.md#COMPLIANCE-LOW-003

**Severity:** LOW
**Layer:** 4 (documented-only)
**State:** OPEN

**Evidence**
- `apps/auth-service/src/modules/gdpr/services/user-consent.service.ts:58` and `libs/backend-common/src/security/gdpr/consent-manager.service.ts:28` — `private readonly currentVersion = '2.0.0';` hardcoded. No documentation of the bump policy (when does v2.0.0 become v2.1.0 vs v3.0.0?), no migration of stale consents on bump.
- The `getUsersWithOutdatedConsent()` helper (`consent-manager.service.ts:216`) exists, but no scheduled re-prompt job uses it.

**Proposed fix direction**
- Tier 4: ADR or runbook documenting consent-version bump policy + tooling for re-prompt.

**Expected closer**
- compliance-expert TEACHER → product owner + frontend-expert.

---

#### COMPLIANCE-LOW-002 — `ConsentSettingsPage` does not display privacy policy text inline; user toggles consent without seeing the policy text the consent applies to

**Severity:** LOW
**Layer:** 4 (GDPR Art 7(2) — informed consent transparency)
**State:** OPEN

**Evidence**
- `web/shell/src/pages/ConsentSettingsPage.tsx:184-189` — consent types are listed and described via `CONSENT_TYPE_LABELS[ct].description` but the privacy policy ITSELF is not rendered. Users tick boxes without seeing the policy version's actual processing terms.

**Proposed fix direction**
- Surface a `Privacy Policy v{version}` collapsible section on the same page, fetched from `apps/auth-service/src/modules/gdpr/services/privacy-policy.service.ts` (new), with the version match against `currentVersion`.

**Expected closer**
- frontend-expert WRITER + auth-security-expert (resolver) → compliance-expert CATCHER.

---

## Cross-domain dependencies flagged

- **COMPLIANCE-CRITICAL-001**: recommend invoking **legal-hold-auditor** (Phase 9.4 sibling) — they own legal-hold trigger semantics; their concurrent review will produce the matching invariant for legal-hold-precedence + the missing `legalHold` column. Recommend invoking **database-reviewer** for migration ordering.
- **COMPLIANCE-CRITICAL-002**: recommend invoking **gdpr-erasure-executor** (Phase 9.2 sibling — implementer) and **multi-tenant-saas-expert** (cross-service tenant-data registry). Recommend invoking **billing-expert** for Stripe-subscription void verification step in cascade order.
- **COMPLIANCE-CRITICAL-003**: recommend invoking **data-expert** (event-contracts kernel owner) and **ai-safety-auditor** (Phase 9.3 sibling — needs ConsentWithdrawn for analytics flush).
- **COMPLIANCE-HIGH-001**: legal-hold-auditor primary, auth-security-expert WRITER.
- **COMPLIANCE-HIGH-002 & -005**: data-expert + frontend-expert (UI surfacing of legalBasis); billing-expert + notification-expert for the failureReason cross-handoff.
- **COMPLIANCE-HIGH-003**: frontend-expert (UI), auth-security-expert (resolver).
- **COMPLIANCE-HIGH-006**: storage-expert / platform-services for signed-URL pattern.
- **COMPLIANCE-HIGH-007**: architectural-arbiter on cross-border lawful basis classification (Stripe US flow vs Turkish data subject); docs-expert / runbook-author.
- **COMPLIANCE-MEDIUM-001**: deferred to multi-tenant-saas-expert (already inherited).
- All findings cross-link to **audit-trail-completeness-auditor** (Phase 9.5 sibling) for handler-level audit completeness.

## Verdict

**BLOCK** — compliance posture has 3 CRITICAL findings spanning three orthogonal axes (audit immutability, erasure cascade fan-out, consent event contract). Each is independently a blocker for SOC 2 Type II readiness AND GDPR/KVKK regulator scrutiny. CRITICAL-001 is also a direct re-confirmation of sibling DBR-CRITICAL-001 / MT-CRITICAL-005 — the two siblings raised the same hole from different lenses; this review confirms the third (compliance) lens. CRITICAL-002 was inherited as MT-CRITICAL-003 and the closer-attempt (farm-service-only) closes only 1/10 of the cascade — escalation justified.

The HIGH findings (especially HIGH-001 retention default + HIGH-007 KVKK declaration absence) compound: a SOC 2 auditor walking through "show me the audit log of all consent changes for tenant X across services Y, Z" today returns partial answers from auth and silence from the others.

Conditions to lift BLOCK:
1. CRITICAL-001 fix lands + invariant test added (1 commit + 1 test file).
2. CRITICAL-002 has at minimum a tracked plan with per-service owner + deadline registered in `docs/reviews/_registry/findings.jsonl`. Full remediation in subsequent commits.
3. CRITICAL-003 lands the 5 missing event-contract interfaces + outbox emission on consent grant/withdraw (1-2 commits).
4. HIGH-007 KVKK declaration + retention-matrix files authored (no code change required for this one).

## References

- Layer-1 cites: `tsconfig.base.json`, branded-types invariant, no `as any`.
- Layer-2 cites: outbox pattern (ADR-006 + `platform/libs/outbox`), event flat pattern (ADR-006), tenant isolation discipline.
- Layer-3 cites: ADR-006 (event contracts), ADR-008 (guards / consent enforcement), ADR-011 (schema ownership for `shared`), ADR-013 (messaging-isolation-convergence as cross-service-symmetry precedent), ADR-020 (audit HMAC chain), ADR-022 (pseudonymisation key management), ADR-024 (compliance retention matrix).
- Sibling cycles consulted: DBR-CRITICAL-001 (audit-immutability triggers — confirmed), MT-CRITICAL-001 (query-param tenantId — ripple recorded), MT-CRITICAL-003 (erasure cascade — direct continuation as COMPLIANCE-CRITICAL-002), MT-CRITICAL-005 (audit triggers from multi-tenant lens — confirmed), DATA-CRITICAL-002 (TenantSchemaSyncService boot-time DDL — substrate noted; not in compliance scope).
- BILLING-MEDIUM `failureReason` PII — promoted to COMPLIANCE-HIGH-005.
- auth-security-expert positive confirmation that auth-side erasure cascades to WebAuthn + sessions + refresh tokens + UserDeleted event — confirmed at file level (`apps/auth-service/src/privacy/gdpr-compliance.service.ts:66-133`); auth-side completeness REVIEWED PASS, but cross-service consumer wiring REVIEWED FAIL (only 1 service consumes the event).
- Frozen reference: `.claude/agents/product-audit/gdpr-compliance-auditor.md`, `.claude/agents/product-audit/soc2-readiness-auditor.md`.
- Plan section: `/root/.claude/plans/abstract-brewing-mochi.md#Phase-9` (this agent's plan section).
