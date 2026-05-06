# database-reviewer — review (CATCHER) — 2026-04-28-core-platform-review

## Scope

Schema state audit across the core / cross-cutting platform surfaces — auth, tenant
provisioning, isolation, billing, shared schema. Domain modules (farm, hr, sensor,
hydroponics, alert, messaging) intentionally out of scope per invocation. Files
reviewed:

- `database/migrations/{core,modules}/V*.sql` (canonical-named tree)
- `apps/auth-service/src/migrations/*.ts` (8 files), `apps/auth-service/src/modules/**/entities/*.entity.ts`
- `apps/billing-service/src/database/migrations/*.ts` (2 files), `apps/billing-service/src/billing/entities/*.entity.ts`
- `apps/admin-api-service/src/migrations/*.ts` (10 files), shared/admin entities
  (audit, gdpr, impersonation, user-permissions, tenant)
- `libs/backend-common/src/{audit,security/gdpr}/entities/*.entity.ts`
- `apps/auth-service/src/database/schema-bootstrap.service.ts`
- `apps/auth-service/src/app.module.ts` (migration loader, RLS exclude list)
- `.github/workflows/db-migration-check.yml` (canon-vs-actual migration tree
  reconciliation)

Trigger context: full state-health audit at HEAD `a958dc66` on `main`, working
tree clean. Re-baseline of the 2026-04-10 review — its CRITICAL-001 (zero-byte
canonical SQL files) is RESOLVED (files are now non-zero), but a new strain of
the same root cause has surfaced: those files are still vestigial — a separate
TypeORM-per-service migration tree is the actual source of truth. The CI
workflow `db-migration-check.yml` documents the abandonment in its own header.

## Executive summary

The auth-tenant-billing-shared core has correct intentions but carries
SECURITY-grade structural drift the existing schema-drift validator did not
catch:

1. The audit-log immutability triggers (BEFORE UPDATE / BEFORE DELETE on
   legalHold rows) installed by `1782000000000-AuditLogImmutability.ts` were
   silently dropped when `1787200000000-RealignSharedAuditLogsSchema.ts` did
   `DROP TABLE shared.audit_logs CASCADE` and recreated the table without
   re-attaching the triggers — and the new schema dropped the `legalHold`
   column the triggers reference. Audit rows are now mutable at the database
   level on both `shared.audit_logs` (cross-service) AND `admin.audit_logs`
   (created without triggers from the start).
2. The admin `impersonation_sessions` security-audit table has bare `@Column()`
   on its `expiresAt` and `endedAt` columns — TypeORM postgres default is
   `TIMESTAMP WITHOUT TIME ZONE`. Neither the explicit-type sweep
   (`1781500000000`) nor the audit-column sweep (`1781900000000`) covered
   them; the table is created by `synchronize` so the wrong type lands at
   runtime.
3. Two parallel migration trees exist — `database/migrations/{core,modules}/`
   and `apps/<svc>/src/(database/)migrations/`. CI explicitly states the
   former is unused; the entity column shapes (`tenantId` camelCase) confirm
   the auth.users table on the live droplet is built from TypeORM
   `migrationsRun: true`, NOT from V003.

Beyond the three CRITICALs, billing carries a soft-delete vs unique-index
contradiction (full unique on `subscriptions.tenantId` blocks any
re-subscription after soft-delete) and the platform has 3-way enum drift
between `auth.TenantPlan` / `admin.TenantPlan` / `billing.PlanTier` with no
DB-side constraint. Verdict: **BLOCK** — CRITICAL-001 / CRITICAL-002 are
audit-trail integrity and compliance regressions.

## Findings (by severity)

### CRITICAL

### DBR-CRITICAL-001 — `shared.audit_logs` immutability triggers silently dropped by realign migration

**Severity:** CRITICAL
**Layer:** 2 (pattern — audit immutability)
**State:** OPEN

**Evidence**
- `apps/admin-api-service/src/migrations/1782000000000-AuditLogImmutability.ts:40-82` — installs `audit_logs_prevent_update()` BEFORE UPDATE trigger and `audit_logs_prevent_legal_hold_delete()` BEFORE DELETE trigger on `audit_logs` (current_schema = admin at the time of this migration).
- `apps/admin-api-service/src/migrations/1782200000000-MoveSharedTablesFromAdminToShared.ts:99` — `ALTER TABLE admin."audit_logs" SET SCHEMA shared` (preserves triggers — fine).
- `apps/admin-api-service/src/migrations/1787200000000-RealignSharedAuditLogsSchema.ts:172-202` — `DROP TABLE shared.audit_logs CASCADE` then `CREATE TABLE shared.audit_logs (...)` with the canonical backend-common shape. This drops both triggers AND the `legalHold` column the legal-hold trigger references. The migration's `up()` does NOT re-create the triggers and the new schema has no `legalHold` column at all.
- `apps/admin-api-service/src/migrations/1787100000000-CreateAdminAuditLogsTable.ts:84-110` — `admin.audit_logs` is created WITHOUT triggers and WITHOUT `legalHold`.
- `libs/backend-common/src/audit/audit-log.entity.ts:24-28` — entity docstring claims "NO soft delete - audit logs are immutable by design" but no DB-level mechanism backs that claim today.

**Rule violated**
Layer-2 audit-pattern + agent rule: "Triggers with `SECURITY DEFINER` writing to RLS-protected tables = HIGH until audited + justified (common audit-logging escape hatch, must be documented)" — the inverse case here is that an immutability trigger that was justified and auditable was silently dropped. Compliance: SOX / PCI-DSS / GDPR Article 32 require demonstrable tamper-evident audit trails. With both triggers gone, an attacker (or a buggy service) holding `admin_service` / `shared` write privileges can `UPDATE shared.audit_logs SET action = '…'` or `DELETE FROM shared.audit_logs` with zero DB-level resistance.

**Proposed fix direction**
- Tier-1: re-install BEFORE UPDATE / BEFORE DELETE triggers on BOTH `shared.audit_logs` AND `admin.audit_logs` in a follow-up migration. Re-add `legalHold boolean NOT NULL DEFAULT false` to both tables (the canonical backend-common entity does not declare it, so the entity also needs the column).
- Tier-3 backstop: add a CI invariant test that asserts `pg_trigger` rows exist for `audit_logs_prevent_update` + `audit_logs_prevent_legal_hold_delete` on both audit tables — running on every PR. Drift on a future destructive migration should fail-loud.
- Document the trigger contract in `docs/security/audit-immutability.md` with the `legalHold` semantics (see auth.audit_logs for the third audit-log table — confirm whether it carries the same protection).

**Affected surface (ripple set)**
- `libs/backend-common/src/audit/audit-log.entity.ts` (add `legalHold`)
- `apps/admin-api-service/src/audit/audit.entity.ts` (add `legalHold`)
- New migration to attach triggers in admin-api-service (`shared` + `admin` audit tables)
- Optionally: `apps/auth-service/src/audit/audit-log.entity.ts` for parity
- `tests/invariants/audit-trigger-presence.spec.ts` (new)

**Expected closer**
data-expert WRITER mode (migration authoring) + auth-security-expert review.

---

### DBR-CRITICAL-002 — `admin.impersonation_sessions.expiresAt` / `endedAt` are `TIMESTAMP WITHOUT TIME ZONE`

**Severity:** CRITICAL
**Layer:** 1 (TypeORM postgres-driver default)
**State:** OPEN

**Evidence**
- `apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts:115-116` — `@Column() expiresAt!: Date;` (no `type`).
- Same file `:118-119` — `@Column({ nullable: true }) endedAt?: Date;` (no `type`).
- Same file `:193-196` for `ImpersonationPermission.grantedAt` / `expiresAt` — same pattern.
- TypeORM postgres-driver default for bare `@Column()` on `Date` is `timestamp without time zone` (confirmed in `libs/backend-common/src/database/convert-audit-columns-to-timestamptz.helper.ts:18-22` quoting the driver source).
- `apps/admin-api-service/src/migrations/1781500000000-ConvertTimestampToTimestamptz.ts:108-203` — explicit-type `timestamp` sweep does NOT include `impersonation_sessions` or `impersonation_permissions`.
- `apps/admin-api-service/src/migrations/1781900000000-ConvertAuditColumnsToTimestamptz.ts` — only sweeps columns named `createdAt` / `updatedAt` / `created_at` / `updated_at` (per `DEFAULT_AUDIT_COLUMNS` in the helper at `:94-99`); `expiresAt` / `endedAt` are never matched.
- The table is created via `synchronize` (no explicit DDL migration creates it — see `1782100000000-AddMfaCompletedToImpersonationSessions.ts` which already assumes the table exists and only adds one column).

**Rule violated**
Agent rule: "Timestamps always `TIMESTAMPTZ`, never `TIMESTAMP WITHOUT TIME ZONE`. … `TIMESTAMP` on audit/compliance column = CRITICAL (audit trail ambiguity across multi-TZ fleet, regulatory non-conformance; arithmetic breaks across DST)." Impersonation sessions ARE security-audit columns: `expiresAt` controls the session lifetime that grants a SUPER_ADMIN access to ANOTHER tenant's data; `endedAt` is the audit timestamp of forced termination. A ±1h DST drift on either is a forensic-blocker and a SOC 2 finding.

**Proposed fix direction**
- Tier-1: change the entity decorators to `@Column({ type: 'timestamptz' })`, then ship a migration that runs `ALTER COLUMN ... TYPE TIMESTAMPTZ USING ... AT TIME ZONE 'UTC'` for the four columns (or extend `DEFAULT_AUDIT_COLUMNS` in the helper to include `expiresAt`, `endedAt`, `grantedAt` etc., though that widens scope).
- Tier-3 backstop: an invariant test that scans all `*.entity.ts` files for `@Column()` (no type) on properties typed `Date` and rejects — the bare-decorator pattern always lands as `timestamp without time zone`.

**Affected surface (ripple set)**
- `apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts`
- New migration in `apps/admin-api-service/src/migrations/`
- Sweep all other entities in scope for the same anti-pattern (`scheduled-plan-change.entity.ts:52-70` uses `@Column()` on string fields — separate finding DBR-MEDIUM-002 below).
- `tests/invariants/typeorm-bare-column-decorator.spec.ts` (new)

**Expected closer**
data-expert WRITER mode (migration) + database-reviewer (re-CATCHER on the entity edits).

---

### DBR-CRITICAL-003 — Two competing migration trees; `database/migrations/core/V*.sql` is dead but still exists, drifts from reality

**Severity:** CRITICAL
**Layer:** 3 (ADR-011 schema ownership / ADR-012 drift prevention)
**State:** OPEN

**Evidence**
- Tree A (vestigial): `database/migrations/core/V001-V008__*.sql` and `database/migrations/modules/{alert,farm,hydroponics,sensor}/V*.sql` — 21 files, 50KB total. Uses snake_case column names, e.g. `database/migrations/core/V003__add_user_table.sql:5-46` declares `auth.users (... tenant_id UUID …, first_name VARCHAR, …)`.
- Tree B (live): `apps/<svc>/src/migrations/<ts>-<Class>.ts` — 94 files. Uses camelCase quoted columns, e.g. `apps/auth-service/src/migrations/1787000000000-DropRlsFromAuthUsersIdentity.ts:121` references `"tenantId"`, and `1781700000000-AddUsersAccessTypeCheck.ts:128-134` queries `"users"."accessType"` / `"createdAt"`.
- `.github/workflows/db-migration-check.yml:9-67` — header explicitly documents Tree A as "vestigial scaffolding experiment that was never completed; nothing in the runtime code references it".
- `apps/auth-service/src/app.module.ts:62-64` — `migrationsRun: true, migrations: [__dirname + '/migrations/*{.ts,.js}']` — Tree B is what actually runs at boot.
- `libs/backend-common/src/database/watchdog/cross-tenant-probe.ts:77-80` — code-level acknowledgment: *"this codebase has no global SnakeNamingStrategy — some entities use explicit name: 'tenant_id' while others default to camelCase 'tenantId'"*. Watchdog has to query both column names defensively.

**Rule violated**
ADR-011 "Schema ownership model" and ADR-012 "Schema drift prevention" both presume a single source of truth. Two trees with mutually-exclusive column conventions defeat both. Per the agent's review checklist item #2: "Cross-reference TypeORM entities against latest applied migrations — flag drift as HIGH." The drift here is between two migration trees, not entity↔migration, but the systemic confusion is identical and the cost is concrete: every reviewer ramping in must understand which tree is canonical, the watchdog and ad-hoc tooling must run dual queries, and any developer who runs `flyway migrate` against Tree A will create a parallel `auth.users` (snake_case) table next to the real one.

**Proposed fix direction**
- Tier-1 (preferred): delete `database/migrations/core/**` and `database/migrations/modules/**` entirely. Document the deletion in an ADR amendment ("Tree A retired 2026-04-28; Tree B per-service is canonical"). Update `tools/gates/migration-sql-lint.ts:71-72` (which still scans `database/migrations/`) to drop the path.
- Tier-3 fallback if deletion is blocked: add a CI invariant that fails the build if any `database/migrations/**/*.sql` file is non-empty AND newer than the deletion-cutoff commit. Forces a positive operator decision.
- Update `docs/DEPLOY.md` and any onboarding docs that still mention Flyway / V-numbered SQL.

**Affected surface (ripple set)**
- `database/migrations/**` (delete tree)
- `tools/gates/migration-sql-lint.ts:71-72` (drop scan path)
- `.github/workflows/db-migration-check.yml` (already abandoned the Flyway job; comment block can be trimmed)
- `docs/adr/011-schema-ownership-model.md` or new ADR amendment

**Expected closer**
data-expert WRITER mode (delete + ADR) + architectural-arbiter (Tree-A retention call if anyone objects).

---

### HIGH

### DBR-HIGH-001 — `billing.subscriptions` full-unique on `tenantId` collides with documented soft-delete

**Severity:** HIGH
**Layer:** 2 (soft-delete pattern)
**State:** OPEN

**Evidence**
- `apps/billing-service/src/billing/entities/subscription.entity.ts:93` — `@Index(['tenantId'], { unique: true })` (full unique, NOT partial).
- Same file `:204-217` — entity declares `is_deleted` / `deleted_at` / `deleted_by` columns and a `softDelete()` helper. The docblock at `:204-209` explicitly states subscriptions are soft-deleted to preserve audit trail for "billing reconciliation and customer disputes".
- `apps/billing-service/src/database/migrations/1786300000000-ConvergeTenantIdAndAddSoftDelete.ts:55-61` — comment claims *"existing partial indexes on (tenant_id) WHERE is_deleted = false already exist on the three tables"* but no migration in the tree creates such an index, and the entity decorator's `unique: true` overrides any partial index TypeORM might pick up.
- Net effect: once a tenant's subscription is soft-deleted (row remains, `is_deleted=true`), creating a NEW subscription for the same tenant raises `duplicate key violates unique constraint`. The soft-delete pattern is broken for any tenant that ever cancels and re-subscribes.

**Rule violated**
Agent rule: "Unique constraints on soft-delete tables MUST be partial (`UNIQUE (col) WHERE deleted_at IS NULL`). Full unique colliding with soft-deleted rows = MEDIUM-HIGH (blocks re-signup, forces premature PII hard-delete)." The financial-criticality of subscription records pushes this to HIGH.

**Proposed fix direction**
- Tier-1: drop the `unique: true` from the entity decorator; add a partial unique index `CREATE UNIQUE INDEX uq_subscriptions_tenant_active ON billing.subscriptions (tenant_id) WHERE is_deleted = false`.
- Same scrutiny on `billing.invoices` (line 100, `[tenantId, invoiceNumber]` unique) and `billing.payments` (line 83, `[tenantId, transactionId]` unique) — those CAN keep the full unique because the secondary key (invoiceNumber, transactionId) varies per row, but partial-unique is still cleaner.
- Add a CI invariant: any entity declaring `is_deleted`/`deleted_at` columns must NOT carry full-unique on a re-issuable identity column.

**Affected surface (ripple set)**
- `apps/billing-service/src/billing/entities/subscription.entity.ts`
- New migration to drop full unique + create partial unique
- `apps/billing-service/src/billing/services/*` — any code that relies on the full-unique constraint as an integrity check (likely none — subscription create paths should already de-duplicate)
- `tests/invariants/soft-delete-partial-unique.spec.ts` (new)

**Expected closer**
data-expert WRITER mode (migration) + billing domain expert review.

---

### DBR-HIGH-002 — `auth.users.tenantId` FK to `auth.tenants` declared in dead V003 only; live schema has no FK

**Severity:** HIGH
**Layer:** 2 (referential integrity)
**State:** OPEN

**Evidence**
- `database/migrations/core/V003__add_user_table.sql:12` — declares `tenant_id UUID REFERENCES auth.tenants(id) ON DELETE CASCADE`. This file is dead (DBR-CRITICAL-003).
- `apps/auth-service/src/modules/authentication/entities/user.entity.ts:91-95` — declares `tenantId` as a plain `@Column({ type: 'uuid', nullable: true })` with NO `@ManyToOne`/`@JoinColumn`. TypeORM does not synthesise a FK without one.
- `apps/auth-service/src/modules/tenant/entities/tenant.entity.ts:55` — Tenant entity has no inverse `@OneToMany` to User either.
- Live droplet evidence: the entity file is what `migrationsRun: true` materialises, so the actual `auth.users` table has NO FK on `tenantId`.

**Rule violated**
ADR-011 + general referential-integrity expectation. Per the agent's constraint-completeness rules, "Every `REFERENCES` clause declares explicit `ON DELETE` + `ON UPDATE`" — but here the deeper issue is that there is NO REFERENCES at all on the production schema for the most security-critical identity-to-tenant link in the platform. Side effects:
1. Orphan users — a tenant can be deleted (or re-created with a different UUID) and `auth.users.tenantId` rows continue to point at a non-existent tenant. No CASCADE/RESTRICT discipline.
2. Direct SQL writes (admin tooling, raw migrations) can insert a `tenantId` referencing a non-existent tenant with no DB pushback. The application-layer check is the only line of defence — same bypass class the agent rules call out for HIGH promotion.

**Proposed fix direction**
- Tier-1: add `@ManyToOne(() => Tenant, { onDelete: 'SET NULL' })` + `@JoinColumn({ name: 'tenantId' })` on `User.tenantId`. SET NULL (not CASCADE) because deleting a tenant should NOT delete the SUPER_ADMIN-managed user records — those carry historical accountability. Cleanup of orphaned users is a separate audited workflow.
- Migration adds the FK constraint with `NOT VALID` initially, then `VALIDATE CONSTRAINT` after the orphan-row sweep (some live environments may already have orphans).
- Same scrutiny on `auth.refresh_tokens.tenantId`, `auth.invitations.tenantId`, `auth.tenant_modules.tenantId` — refresh_tokens and tenant_modules have `@ManyToOne` to Tenant declared via inverse-side relation (`refresh-token.entity.ts:28` to User, but no Tenant FK; `tenant-module.entity.ts:114` to Tenant — declares CASCADE, fine).

**Affected surface (ripple set)**
- `apps/auth-service/src/modules/authentication/entities/user.entity.ts`
- `apps/auth-service/src/modules/authentication/entities/refresh-token.entity.ts:32` (no Tenant FK; should match)
- `apps/auth-service/src/modules/authentication/entities/invitation.entity.ts:78` (same — `@Column({ type: 'uuid', nullable: true }) tenantId`)
- New migration adds FKs (NOT VALID + VALIDATE)
- Orphan-row sweep script (one-shot, audited)

**Expected closer**
data-expert WRITER mode (FK migration + entity decorator change) + auth-security-expert review.

---

### DBR-HIGH-003 — `TenantPlan` enum drift across 3 services; no DB CHECK constraint

**Severity:** HIGH
**Layer:** 3 (enum-as-source-of-truth pattern)
**State:** OPEN

**Evidence**
- `apps/auth-service/src/modules/tenant/entities/tenant.entity.ts:15-20` — TRIAL / STARTER / PROFESSIONAL / ENTERPRISE (4 values).
- `apps/admin-api-service/src/tenant/entities/tenant.entity.ts:20-26` — FREE / TRIAL / STARTER / PROFESSIONAL / ENTERPRISE (5 values; `FREE` is unique to admin-api).
- `apps/admin-api-service/src/analytics/entities/external/tenant.entity.ts:11` — separate copy of the enum (analytics surface).
- `apps/billing-service/src/billing/entities/subscription.entity.ts:32-37` — `PlanTier`: STARTER / PROFESSIONAL / ENTERPRISE / CUSTOM (different name AND different values — `CUSTOM` doesn't exist in either tenant enum).
- `auth.tenants.plan` is `@Column({ type: 'varchar', length: 20, default: 'starter' })` — no PG ENUM, no CHECK constraint.
- Net: a SUPER_ADMIN can create a tenant with `plan='free'` (legal in admin-api), the row reaches auth-service, and auth-service's TenantPlan enum doesn't have `FREE` — TypeORM happily coerces the string into a runtime value the type system promised could not exist.

**Rule violated**
Agent rule: "Every enum business state MUST enforce valid values via ONE of: (a) PG `ENUM` type, (b) `CHECK (col IN (...))` on TEXT, (c) `FOREIGN KEY` to lookup table. Untyped `VARCHAR`/`TEXT` status = MEDIUM." Cross-service enum drift escalates this to HIGH because the application layer cannot enforce a single source of truth — each service has its own and they disagree.

**Proposed fix direction**
- Tier-1 (best): introduce a `shared.tenant_plans` lookup table with `code TEXT PRIMARY KEY, display_name TEXT, billing_tier TEXT, …`; FK from `auth.tenants.plan_code` to it; remove the local enum copies and `IsEnum()` decorators in favour of `IsIn(plansCache)` from a config service. Adding a 5th plan = INSERT one row, no code change.
- Tier-3 fallback: add a `CHECK (plan IN ('trial','starter','professional','enterprise','free'))` constraint on `auth.tenants.plan` (and the equivalent on `billing.subscriptions.plan_tier`), reconcile the enums to one canonical TS enum exported from `@platform/shared`. CI invariant: only one `TenantPlan` enum may exist across `apps/**` and `libs/**`.

**Affected surface (ripple set)**
- New `shared.tenant_plans` table (per CLAUDE.md "Tenant row placement" / W5 `add-shared-table` skill — REQUIRES architectural-arbiter approval per BLOCKER-15 since this would be the 5th canonical shared-schema table)
- `apps/auth-service/src/modules/tenant/entities/tenant.entity.ts`
- `apps/admin-api-service/src/tenant/entities/tenant.entity.ts` (drop FREE or move to canonical)
- `apps/billing-service/src/billing/entities/subscription.entity.ts` (PlanTier reconciliation)
- New migration adds CHECK / lookup table
- `tests/invariants/single-tenant-plan-enum.spec.ts` (new)

**Expected closer**
multi-tenant-saas-expert TEACHER → data-expert WRITER → architectural-arbiter on the shared-table addition.

---

### DBR-HIGH-004 — `shared.user_permissions` has no FK to user/tenant; orphans possible

**Severity:** HIGH
**Layer:** 2 (referential integrity)
**State:** OPEN

**Evidence**
- `apps/admin-api-service/src/users/entities/user-permissions.entity.ts:97-109` — `userId` and `tenantId` are bare `@Column({ type: 'uuid' })` with NO `@ManyToOne`/`@JoinColumn` and no FK constraint declared in any migration.
- Same file `:100` — composite unique `(userId, tenantId)` exists, but uniqueness ≠ referential integrity.
- The table is in `shared` schema (cross-service). Cross-schema FKs are forbidden by CLAUDE.md, so a hard FK to `auth.users(id)` is not the right solution — but eventual-consistency cleanup (a tombstone listener on `UserDeleted` events) is required.

**Rule violated**
Layer-1 + agent constraint-completeness rules: "Every `REFERENCES` clause declares explicit `ON DELETE` + `ON UPDATE`." The implicit alternative — application-layer event-driven cleanup — is acceptable IF the listener exists and is observed. No such listener appears to be present, so deleting a user leaves their permission rows alive forever.

**Proposed fix direction**
- Tier-2 (right tier here, given cross-schema FK ban): add a NATS event consumer in admin-api-service for `UserDeleted` / `TenantDeleted` that removes matching rows. Track removal counts via Prometheus metric.
- Same pattern needed for `shared.audit_logs` (intentionally NOT cleaned — audit retention) and `shared.gdpr_data_requests` (ditto — legal-hold retention).
- Document the cross-schema FK substitute in `docs/architecture/cross-schema-cleanup-pattern.md`.

**Affected surface (ripple set)**
- `apps/admin-api-service/src/users/handlers/` (new event consumer)
- `libs/event-contracts/src/auth-events.ts` (verify `UserDeleted` exists)
- New observability metric on the consumer

**Expected closer**
multi-tenant-saas-expert TEACHER → admin-api or auth-service WRITER (event consumer).

---

### DBR-HIGH-005 — `gdpr_data_requests.requestType` and `status` use untyped `varchar(50)` — no ENUM, no CHECK

**Severity:** HIGH
**Layer:** 1 (column-type discipline)
**State:** OPEN

**Evidence**
- `libs/backend-common/src/security/gdpr/entities/data-request.entity.ts:53-64` — `requestType` and `status` declared as `@Column({ type: 'varchar', length: 50 })` even though the TS layer has well-defined `DataRequestType` and `DataRequestStatus` enums (`:13-30`).
- No CHECK constraint added in any migration.
- GDPR data-request status drives compliance SLA (the request response window). An invalid value silently breaks the workflow.

**Rule violated**
Agent rule (CHECK on enums): "Untyped `VARCHAR`/`TEXT` status = MEDIUM"; HIGH given GDPR criticality.

**Proposed fix direction**
- Tier-3: add `CHECK (request_type IN ('export','deletion','rectification','restriction','portability'))` and same for `status`. Pre-validate offending rows like `apps/auth-service/src/migrations/1781700000000-AddUsersAccessTypeCheck.ts` does — that migration is the canonical pattern.
- Same audit on `auth.tenants.status` (`varchar(20)`), `auth.tenants.plan` (covered by DBR-HIGH-003), `auth.invitations.status` (`varchar(20)`), `auth.users.role` (`varchar(50)`).

**Affected surface (ripple set)**
- New migration in `libs/backend-common`-owning service (admin-api per current ownership) or auth-service (which imports the GDPR module).
- `tests/invariants/string-enum-check-constraint.spec.ts` — invariant: any varchar column whose entity field is typed as a TS enum MUST have a CHECK constraint.

**Expected closer**
data-expert WRITER mode (migration) + auth-security-expert review for the data-request criticality.

---

### MEDIUM

### DBR-MEDIUM-001 — `auth.tenants.customDomain` has no unique constraint; cross-tenant collision possible

**Severity:** MEDIUM
**Layer:** 2 (natural-key uniqueness)
**State:** OPEN

**Evidence**
- `apps/auth-service/src/modules/tenant/entities/tenant.entity.ts:198-200` — `@Column({ type: 'varchar', length: 255, nullable: true }) customDomain?: string | null;` — no `unique: true`, no separate `@Index()` with unique.
- Custom domain routes inbound requests to a specific tenant; allowing two tenants to register the same `customDomain` is a tenant-isolation breach (which tenant does the request resolve to?).

**Rule violated**
Agent rule: "Unique constraints on natural keys (email, slug, tenant+name composite) — missing = MEDIUM-HIGH depending on domain criticality." `customDomain` is a routing primitive — closer to HIGH for the platform, but only enterprise tenants set it, so MEDIUM is fair.

**Proposed fix direction**
- Tier-1: partial unique `CREATE UNIQUE INDEX uq_tenants_custom_domain ON auth.tenants(custom_domain) WHERE custom_domain IS NOT NULL`.
- Domain validation layer should also reject duplicates pre-write (application-layer + DB constraint = defense-in-depth).

**Expected closer**
data-expert WRITER mode (migration + entity edit).

---

### DBR-MEDIUM-002 — `billing.scheduled_plan_changes` uses bare `@Column()` on string FK fields

**Severity:** MEDIUM
**Layer:** 1 (column-type discipline)
**State:** OPEN

**Evidence**
- `apps/billing-service/src/billing/entities/scheduled-plan-change.entity.ts:51-71` — `currentPlanId`, `currentPlanTier`, `newPlanId`, `newPlanTier`, `newPlanName` all use bare `@Column()` (no type, no length).
- `currentPlanId` and `newPlanId` reference `Plan.id` which is `uuid` — they should be `@Column({ type: 'uuid' })`.
- `currentPlanTier` and `newPlanTier` should be `varchar(50)` matching the `PlanTier` enum length convention.
- Bare `@Column()` resolves to `varchar` (no length cap) on PG; while not security-critical here, it diverges from the rest of the schema and silently rejects no input.

**Rule violated**
Agent rule: "TypeORM 0.3.x: declare explicit types (`@Column('uuid')`, `@Column('timestamptz')` …). Implicit inference drifts between TypeORM versions." Also the `VARCHAR(255)` rule — though bare `@Column()` is even worse (uncapped).

**Proposed fix direction**
- Tier-1: edit the entity, ship a migration `ALTER COLUMN ... TYPE uuid USING (...)::uuid` for the two ID columns.
- Same audit on every other `@Column()` (no type) in scope; previous reviewers' bare-column report at `1781900000000-ConvertAuditColumnsToTimestamptz.ts` only swept date columns named `createdAt`/`updatedAt`.

**Expected closer**
data-expert WRITER mode (migration + entity edit).

---

### DBR-MEDIUM-003 — IP-address column type inconsistency across core platform tables

**Severity:** MEDIUM
**Layer:** 1 (column-type discipline / cross-service consistency)
**State:** OPEN

**Evidence**
| Table | Column | Type | Source |
|---|---|---|---|
| `auth.refresh_tokens` | `ipAddress` | `varchar(50)` | `refresh-token.entity.ts:50-51` |
| `auth.users` | `lastLoginIp` | `varchar(50)` | `user.entity.ts:230-232` |
| `admin.impersonation_sessions` | `ipAddress` | `inet` | `impersonation-session.entity.ts:93-94` |
| `shared.audit_logs` | `ip` | `varchar(45)` | `audit-log.entity.ts:138` |
| `shared.gdpr_data_requests` | `ipAddress` | `varchar(50)` | `data-request.entity.ts:69` |
| `shared.user_consents` | `ipAddress` | `varchar(50)` | `consent.entity.ts:44` |

PG's native `inet` type is 7 bytes (IPv4) or 19 bytes (IPv6), supports `<<` (subnet containment), index-friendly comparisons, and rejects malformed addresses at INSERT time. `varchar(45)` and `varchar(50)` accept any string, including invalid addresses, breaking later analytical queries.

**Rule violated**
Agent rule + Layer-2 consistency expectation. Not strictly forbidden, but the heterogeneity forces cross-table joins to cast (`varchar::inet`) and disables network-aware filtering in audit reports.

**Proposed fix direction**
- Tier-1: settle on `inet` for all six columns; ship migration `ALTER COLUMN ... TYPE inet USING ip::inet` (handle malformed legacy values via pre-check pattern from `AddUsersAccessTypeCheck`).
- Document the platform-wide convention in layer-1-typeorm.md.

**Expected closer**
data-expert WRITER mode (multi-service migration coordination).

---

### DBR-MEDIUM-004 — `shared.user_consents` lacks unique on (userId, consentType, version); duplicate consent records possible

**Severity:** MEDIUM
**Layer:** 2 (consent-record integrity)
**State:** OPEN

**Evidence**
- `libs/backend-common/src/security/gdpr/entities/consent.entity.ts:17-21` — only B-tree indexes on `(userId)`, `(tenantId)`, `(consentType)`, `(userId, consentType)`. No unique.
- Same file `:38-42` — `granted` boolean + `version` string (e.g. policy version "v3.0"). The natural key is `(userId, consentType, version)` — a single user has at most one consent record per type per policy version. Today, two parallel records with conflicting `granted` values can exist — the "did this user consent to telemetry under privacy-policy v3?" query becomes non-deterministic.

**Rule violated**
Agent rule on natural-key uniqueness; GDPR audit-evidence integrity.

**Proposed fix direction**
- Tier-1: `CREATE UNIQUE INDEX uq_user_consents_natural ON shared.user_consents("userId", "consentType", version)`.
- Application-layer write path uses ON CONFLICT (..., ..., ...) DO UPDATE.

**Expected closer**
data-expert WRITER mode.

---

### DBR-MEDIUM-005 — `billing.invoice.subscriptionId` and `payment.invoiceId` FKs declared without explicit ON DELETE

**Severity:** MEDIUM
**Layer:** 2 (FK semantics)
**State:** OPEN

**Evidence**
- `apps/billing-service/src/billing/entities/invoice.entity.ts:122-124` — `@ManyToOne('Subscription', 'invoices') @JoinColumn({ name: 'subscription_id' })`. No `onDelete:` option in the decorator.
- `apps/billing-service/src/billing/entities/payment.entity.ts:106-108` — `@ManyToOne('Invoice', (invoice: any) => invoice.payments) @JoinColumn({ name: 'invoice_id' })`. No `onDelete:`.
- TypeORM default for missing `onDelete` is `NO ACTION` (DB-level), which fails INSERT on dangling reference but does NOT block parent DELETE — the parent delete will just fail at FK check time with a generic error.

**Rule violated**
Agent rule: "Every `REFERENCES` clause declares explicit `ON DELETE` + `ON UPDATE`. Silent `NO ACTION` default = MEDIUM (force reviewer to pick semantics consciously)." For invoice/payment, RESTRICT is the right call (financial records survive subscription/invoice deletion via soft-delete; a hard-delete attempt should fail-loud).

**Proposed fix direction**
- Tier-1: add `{ onDelete: 'RESTRICT' }` to both `@ManyToOne`s. Soft-delete on Subscription / Invoice already preserves the audit trail; the FK then becomes a defense-in-depth against accidental hard-deletes.
- Migration to ALTER the existing FK constraints.

**Expected closer**
data-expert WRITER mode.

---

### DBR-MEDIUM-006 — `auth.audit_log` (auth-service local) state vs `shared.audit_logs` overlap unclear; risk of dual-write divergence

**Severity:** MEDIUM
**Layer:** 3 (canonical-tables doctrine, ADR-011)
**State:** OPEN

**Evidence**
- `apps/auth-service/src/audit/audit-log.entity.ts` exists and is referenced by `1787200000000-RealignSharedAuditLogsSchema.ts:46-49` as the THIRD audit table (after `shared.audit_logs` + `admin.audit_logs`).
- CLAUDE.md "Tenant row placement (D14)": shared schema reserved for 4 canonical tables; if auth.audit_log is per-service operational audit (login/MFA/token-revoke), it overlaps semantically with `shared.audit_logs` which the same auth-service flows could also write to.
- No migration explicitly creates `auth.audit_log`; it is materialised via `synchronize` (auth-service uses `migrationsRun: true` + entity loading). Schema details are not auditable from the migration tree alone.

**Rule violated**
Layer-3 ADR-011 ambiguity: which write-path goes to which table? Without a documented contract, code paths drift and the same event ends up in 0, 1, or 2 audit tables depending on which service wrote it.

**Proposed fix direction**
- Tier-4 (here a documented contract is the right tier): write `docs/architecture/audit-tables.md` with a 3-line decision tree per event class. Code paths reviewed against it. Replace the comment-only design with a tested invariant: every `AuditService.log()` call across services routes through a single typed dispatcher that writes to the correct table.
- Optional Tier-3: invariant test that scans all `audit*Repository.save()` / `audit*Repository.insert()` callsites and rejects raw inserts outside the dispatcher.

**Expected closer**
auth-security-expert TEACHER → architectural-arbiter ratification.

---

### LOW

### DBR-LOW-001 — `auth.tenants.farm_count` / `sensor_count` denormalised counters with no DB-side reconciliation guard

**Severity:** LOW
**Layer:** 2 (denormalisation discipline)
**State:** OPEN

**Evidence**
- `apps/auth-service/src/modules/tenant/entities/tenant.entity.ts:160-179` — `userCount`, `farmCount`, `sensorCount` carry the docstring "denormalized for quick access".
- No DB trigger / scheduled reconciliation job documented to keep them in sync with farm-service / sensor-service tenant schemas.
- Drift is invisible until an admin opens a usage report and the counters are stale.

**Rule violated**
Agent rule: "3NF baseline. Denormalisation requires explicit justification in entity comment or migration comment." Justification exists ("quick access"); reconciliation discipline does not.

**Proposed fix direction**
- Tier-3: scheduled job (Temporal / cron) that recomputes the counters daily and emits a metric on drift > 0. Drift over threshold raises an alert.
- Long-term: drop the counters in favour of cached query results in Redis with a defined TTL — denormalisation in the source-of-truth table is the wrong tier for telemetry-shaped data.

**Expected closer**
data-expert WRITER mode (reconciliation job migration) — low priority.

---

### DBR-LOW-002 — `audit_logs.tenantId` nullable on a tenant-isolation-discriminator column

**Severity:** LOW (intentional-design judgment call)
**Layer:** 2 (RLS predicate semantics)
**State:** OPEN — pending architectural decision

**Evidence**
- `libs/backend-common/src/audit/audit-log.entity.ts:118-120` — `@Column({ type: 'uuid', nullable: true }) tenantId!: string | null;`
- `apps/admin-api-service/src/migrations/1787200000000-RealignSharedAuditLogsSchema.ts:188` — `"tenantId" uuid NULL`.

**Rule violated** (potentially)
Agent rule: "tenant_id on RLS-protected or tenant-scoped tables MUST be `NOT NULL`. Nullable = CRITICAL (NULL policy behaviour, leaked rows)."

**Why LOW (not CRITICAL)**: `shared.audit_logs` records BOTH tenant-scoped AND system-level events. System-level events legitimately have `tenantId IS NULL` (e.g., a `SUPER_ADMIN` provisioning a new tenant — the event happens BEFORE the tenant exists). The nullable-tenantId here is intentional, not an oversight, and the schema does NOT have RLS enabled on `shared.audit_logs` (so the NULL-policy concern does not apply). However: if RLS is ever ADDED for defense-in-depth (recommended in agent guidance), the policy must explicitly handle NULL tenantId rows (e.g., `(tenantId = current OR tenantId IS NULL AND has_role('platform_admin'))`).

**Proposed fix direction**
- Document the NULL-tenantId semantics in the entity docblock + an `audit-tables.md` (paired with DBR-MEDIUM-006).
- If/when RLS is added to shared.audit_logs, design the policy with explicit NULL handling.

**Expected closer**
auth-security-expert TEACHER mode review.

## Cross-domain dependencies flagged

- **DBR-CRITICAL-001 (audit immutability)** → also invoke `auth-security-expert` (audit-trail tamper-evidence is a security guarantee) and `security-reviewer` (compliance posture).
- **DBR-CRITICAL-002 (timestamp without time zone)** → also invoke `data-expert` for migration authoring + `auth-security-expert` for the impersonation-session security review.
- **DBR-CRITICAL-003 (dead migration tree)** → invoke `architectural-arbiter` for the deletion ADR; also `data-expert` (migration authoring is its primary).
- **DBR-HIGH-001 (subscription unique)** → also invoke `multi-tenant-saas-expert` (subscription is per-tenant).
- **DBR-HIGH-002 (missing FK on auth.users.tenantId)** → also invoke `auth-security-expert`.
- **DBR-HIGH-003 (TenantPlan enum drift)** → REQUIRES `architectural-arbiter` (W5 `add-shared-table` skill BLOCKER-15) if the recommended Tier-1 lookup-table approach is taken.
- **DBR-HIGH-004 (user_permissions cross-schema cleanup)** → invoke `multi-tenant-saas-expert`.
- **DBR-MEDIUM-006 (audit-tables doctrine)** → invoke `architectural-arbiter`.

## Verdict

**BLOCK.**

Three CRITICAL findings open; two of them (CRITICAL-001 audit immutability,
CRITICAL-002 timestamp without time zone on impersonation-session) are
compliance / forensic-evidence regressions that affect the platform's ability
to demonstrate tamper-evident audit trails for SOX / PCI-DSS / GDPR / SOC 2
auditors. CRITICAL-003 (dead migration tree) is lower-stakes operationally
but blocks any clean schema-state audit going forward.

CONDITIONAL clearance is achievable once CRITICAL-001 and CRITICAL-002 land
the migrations + invariant tests; CRITICAL-003 can be tracked as a
follow-up plan-phase deletion if the architectural-arbiter consents to
parallel delivery.

## References

- Layer-1: `.claude/knowledge/layer-1-typeorm.md` — TypeORM 0.3, schema option, JSONB-vs-JSON, NUMERIC + timestamptz discipline
- Layer-2: `.claude/knowledge/layer-2-patterns.md` — tenant isolation, outbox, audit
- Layer-3: `.claude/knowledge/layer-3-adrs.md` — ADR-011 schema ownership, ADR-012 drift, ADR-014/015 RLS posture
- Prior cycle this report supersedes: `docs/reviews/database-reviewer/2026-04-10-full-repo-audit.md`
  - that cycle's CRITICAL-001 (zero-byte canonical SQL) is RESOLVED but reframed by DBR-CRITICAL-003 (the tree is dead-code, not under-construction)
  - that cycle's HIGH-002 (sensor float precision) — out of scope for this scoped review (sensor module excluded)
  - that cycle's HIGH-003 (message_receipts partition key uniqueness) — out of scope (messaging excluded)
- ADRs: `docs/adr/011-schema-ownership-model.md`, `docs/adr/012-schema-drift-prevention.md`
- CLAUDE.md "Tenant row placement (D14)" — auth.tenants is canonical, billing.subscriptions is per-tenant SSoT, shared schema strictly limited to 4 tables
