---
name: provision-tenant
description: Provision a new tenant via the 7-step saga with advisory locks, module-schema loop, reference-data copy, RLS apply, compensation handlers. BLOCKER-14 class.
type: skill
version: 1
blocker: BLOCKER-14
owners: multi-tenant-saas-expert, auth-security-expert, data-expert
---

# Skill — Provision Tenant (BLOCKER-14)

## ADR Gate

Tenant provisioning is a distributed saga touching 7+ services (auth, farm, sensor, hr, messaging, ai, hydroponics, alert, billing, notification). The saga sequence + compensation handlers + idempotency keys are architecturally gated — changing the step order or removing a compensation handler requires ADR + architectural-arbiter approval.

- ADR: `docs/adr/provisional — tenant-lifecycle-saga.md` (if not yet an ADR, treat the `multi-tenant-saas-expert.md` "Provisioning saga + compensation" section as the canonical spec until a formal ADR lands).
- Invariant enforcement: `tests/invariants/provisioning-saga.spec.ts` (Phase 13 deliverable) asserts the step set + compensation set + idempotency-key coverage.

## When to invoke

Admin workflow: a new customer signs up → SUPER_ADMIN triggers tenant provisioning. User-triggered self-service onboarding is also a valid invocation path once the flow is productised.

## Prerequisites

- Requestor is SUPER_ADMIN OR self-service-onboarding feature flag enabled for the plan tier.
- Plan tier chosen (determines which modules to assign).
- Billing customer record exists OR free-tier flag set (no billing-subscription step for free tier).
- `MODULE_SCHEMAS` registry at `libs/backend-common/src/database/constants.ts` is up-to-date — the provisioning loop copies this structure for every new tenant.

## Cascade

### Step 1 — Create tenant row + claim advisory lock

**Affected files:** `apps/auth-service/src/tenants/commands/create-tenant.handler.ts`.

**Mechanism:**
```ts
async run(command: CreateTenantCommand) {
  return this.dataSource.transaction(async (em) => {
    const tenant = await em.save(new Tenant({ ...command, status: 'PROVISIONING' }));
    await em.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`tenant:${tenant.id}`]
    );
    return tenant;
  });
}
```

Advisory lock key uses `hashtextextended(string, 0)` for stable 64-bit hashing of the tenant ID. Transaction-scoped (`_xact_`) so the lock auto-releases on COMMIT/ROLLBACK.

**Why:** prevents double-provisioning under concurrent signups. Per data-expert's split-brain incident lesson (2026-04-07), session-scoped locks leak across pool checkouts — transaction-scoped is the only safe shape. Status `PROVISIONING` is the semantic lock other services honor until saga terminates.

**Verification:** `auth.tenants` row exists with `status = 'PROVISIONING'`; advisory lock visible in `pg_locks` for the duration of the transaction.

**Cross-domain notifications:** `auth-security-expert` primary; `data-expert` on connection pool discipline.

### Step 2 — Create per-tenant schema (`tenant_{16hex}`)

**Affected files:** `libs/backend-common/src/database/schema-manager.service.ts` (uses existing `createTenantSchema`).

**Mechanism:** `SchemaManagerService.createTenantSchema(tenantId)` does the following, in order:

1. Validate schema name against `TENANT_SCHEMA_REGEX` (`/^tenant_[a-f0-9]{16}$/`) — raw schema name interpolation without this check = CRITICAL (SQL injection).
2. Acquire advisory lock on the hashed tenant key (inherits from Step 1's transaction if same-tx, else claims a new one).
3. `CREATE SCHEMA IF NOT EXISTS tenant_<hex>;`
4. For each `module` in `MODULE_SCHEMAS`:
   - For each `table` in `MODULE_SCHEMAS[module].tables`: `CREATE TABLE tenant_<hex>.<table> (LIKE <source-schema>.<table> INCLUDING ALL);`
   - For each `ref_table` in `MODULE_SCHEMAS[module].referenceDataTables`: `CREATE TABLE tenant_<hex>.<ref_table> (LIKE <source-schema>.<ref_table> INCLUDING ALL); INSERT INTO tenant_<hex>.<ref_table> SELECT * FROM <source-schema>.<ref_table>;` — reference tables MUST NOT carry a `tenant_id` column (INSERT SELECT would copy foreign tenant rows = CRITICAL cross-tenant leak).
5. For TimescaleDB hypertables (`sensor_metrics` etc.): apply `SELECT create_hypertable(...)` on the tenant's copy.
6. Apply RLS policies via `apply-tenant-rls.helper` for every RLS-enabled table (see `add-rls-policy` skill Step 6 — RLS policies are NOT copied by `CREATE TABLE LIKE ... INCLUDING ALL`).
7. Populate `SchemaLRUCache` with the new schema.

**Why:** schema-per-tenant is the PRIMARY isolation model per ADR-011. Every step above traces to a data-expert invariant (`createTenantSchema` advisory-lock sequence documented there).

**Verification:** `SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'tenant_<hex>';` returns 1 row. Per-module table count matches `MODULE_SCHEMAS[module].tables.length + referenceDataTables.length`. RLS policies present per `pg_policies`.

**Cross-domain notifications:** `data-expert` (primary on schema bootstrap); `database-reviewer` (state-health); `multi-tenant-saas-expert` (saga step owner).

### Step 3 — Seed initial data

**Affected files:** `apps/<svc>/src/seed/seed-tenant.service.ts` for each service that needs initial data.

**Mechanism:** minimal seed — e.g. default farm / default sensor profile / default HR role set / default messaging channel. Seeds are idempotent: `INSERT ... ON CONFLICT DO NOTHING` or check-before-insert. No tenant-specific business data at this step.

**Why:** a new tenant needs enough state to use the UI — empty reference data leaves the product unusable. Seed discipline is separate from test fixtures (which are scoped to tests).

**Verification:** integration test creates tenant → logs in as initial admin → UI dashboard renders without empty-state errors.

**Cross-domain notifications:** respective domain experts (farm / sensor / hr / messaging).

### Step 4 — Assign modules per plan tier

**Affected files:** `apps/admin-api-service/src/tenant-modules/commands/assign-module.handler.ts`.

**Mechanism:** for each module in the plan-tier's `enabledModules` list, insert a `tenant_modules` row marking the module as active. Module gating at the API layer reads this table.

**Why:** plan-tier enforcement per `multi-tenant-saas-expert` invariants — module access must be a data-driven check, not a hardcoded role check. Plan downgrade must validate the module dependency graph (see `admin-expert.md` billing rule).

**Verification:** `tenant_modules` rows match the plan's enabled set; API middleware rejects requests for disabled modules with 403.

**Cross-domain notifications:** `billing-expert` on plan-tier linkage; `multi-tenant-saas-expert` on gating correctness.

### Step 5 — Create initial admin user

**Affected files:** `apps/auth-service/src/users/commands/create-initial-admin.handler.ts`.

**Mechanism:** first user for the tenant is TENANT_ADMIN role. Password = generated one-time token; user receives email to set permanent password. MFA enrolment MANDATORY on first login per ASVS V9 + auth-security-expert invariant.

**Why:** a tenant without an admin is unusable; an admin without MFA is a compliance failure. The one-time token limits exposure of the initial password.

**Verification:** `auth.users` row with `role = 'TENANT_ADMIN'` and `mfa_enrolled_at IS NULL` (will be set on first login); email queued via notification-service outbox.

**Cross-domain notifications:** `auth-security-expert` (primary on user creation); `notification-service` for email dispatch.

### Step 6 — Billing subscription (PIVOT transaction)

**Affected files:** `apps/billing-service/src/subscriptions/commands/create-subscription.handler.ts`.

**Mechanism:** this is the saga's PIVOT step — the Stripe API call that creates the subscription. Uses `Idempotency-Key` header keyed to `tenant:${tenantId}:provision` to prevent double-charge on retry. On success, write `billing.subscriptions` row with `tenant_id` foreign key. On Stripe API failure, saga enters COMPENSATION mode (Step C).

**Why:** pivot transactions in sagas are the point of no return — once Stripe charges the card, the downstream side-effects must all complete or be explicitly compensated. Billing compensation MUST void the Stripe subscription + verify void succeeded before marking the saga failed.

**Verification:** Stripe subscription ID persisted; webhook handler processes `customer.subscription.created` event and confirms the tenant binding.

**Cross-domain notifications:** `billing-expert` (primary); `admin-expert` (admin UI reflects status).

### Step 7 — Notification fan-out + final status transition

**Affected files:** `apps/notification-service/src/dispatch/handlers/tenant-provisioned.handler.ts`.

**Mechanism:** outbox-emitted `TenantProvisioned` event. Consumers (messaging-service welcome channel, notification-service welcome email, observability-service per-tenant metric onboarding, ai-service agent-config seeding) react to their downstream concerns. Auth-service sets `tenants.status = 'ACTIVE'` as the FINAL step of the saga (atomic — after every downstream confirmation).

**Why:** status `ACTIVE` unlocks tenant-scoped operations for other services. Without the outbox fan-out, each consumer would need direct DB access to tenant state = tight coupling.

**Verification:** `tenants.status = 'ACTIVE'`; at least one outbox row for `TenantProvisioned` delivered to NATS; consumer subscriptions confirmed.

**Cross-domain notifications:** `data-expert` on outbox discipline; every consumer service acknowledges receipt.

### Step C — Compensation (ANY step failure)

**Affected files:** one compensation handler per compensable step — `compensate-<step>.handler.ts`.

**Mechanism:** on step failure, invoke compensation handlers in REVERSE order of completion:

1. Compensate Step 7 — emit `TenantProvisioningFailed` outbox event; consumers roll back welcome/onboarding.
2. Compensate Step 6 — void Stripe subscription via `stripe.subscriptions.cancel(id, { prorate: false })`, verify 200 response, delete `billing.subscriptions` row.
3. Compensate Step 5 — delete `auth.users` row + cancel any in-flight welcome email.
4. Compensate Step 4 — delete `tenant_modules` rows.
5. Compensate Step 3 — `DELETE FROM tenant_<hex>.<seed_table> WHERE <seed-marker>`.
6. Compensate Step 2 — `DROP SCHEMA tenant_<hex> CASCADE`. Marked `-- DESTRUCTIVE: tenant rollback, no downstream retention` per migration-sql-lint R1.
7. Compensate Step 1 — update `tenants.status = 'FAILED'` + `tenants.failure_reason = <reason>`; DO NOT delete the row (preserves audit trail).

Compensation failures MUST retry with exponential backoff; after retry exhaustion enqueue `RequiresManualReconciliation` alert visible in the admin dashboard per admin-expert tenant-lifecycle invariant.

**Why:** silent intermediate states are HIGH findings per admin-expert. Partial-provisioning tenants MUST be visibly flagged — the `FAILED` status + preserved row is the flag.

**Verification:** integration test injecting failure at each step asserts the correct reverse-compensation order + final state.

**Cross-domain notifications:** `admin-expert` dashboard visibility; `architectural-arbiter` for 3+ consecutive compensation failures (pattern).

## Validation checklist

- [ ] Step 1 advisory lock is transaction-scoped (`pg_advisory_xact_lock`), not session-scoped.
- [ ] Step 2 schema name passes `TENANT_SCHEMA_REGEX` before any interpolation.
- [ ] Step 2 RLS policies applied via `apply-tenant-rls.helper` (not inherited from LIKE INCLUDING ALL).
- [ ] Step 2 reference tables have NO `tenant_id` column (otherwise INSERT SELECT = cross-tenant leak).
- [ ] Step 4 module assignments match plan-tier registry.
- [ ] Step 5 initial admin row created with MFA not-yet-enrolled; one-time password token in email queue.
- [ ] Step 6 Stripe call uses `Idempotency-Key`; webhook confirms binding.
- [ ] Step 7 saga completes with `status = 'ACTIVE'`; outbox rows delivered.
- [ ] Every step classified COMPENSABLE / PIVOT / RETRYABLE (Step 6 = PIVOT; others = COMPENSABLE).
- [ ] Each compensable step has an idempotent compensation handler.
- [ ] Compensation-failure alerts wired to admin dashboard.

## Examples

- `libs/backend-common/src/database/schema-manager.service.ts` — Step 2 canonical implementation.
- `apps/admin-api-service/src/tenants/tenant-status.service.ts` — status-transition state machine (see admin-expert lifecycle rule).

## Cross-references

- ADR-011 — schema ownership (Step 2).
- ADR-006 — event contract flat-pattern (Step 7 outbox event).
- `.claude/agents-enterprise-v2/multi-tenant-saas-expert.md` — saga architecture primary owner.
- `.claude/agents-enterprise-v2/admin-expert.md` — tenant-lifecycle UI surface + saga rules.
- `.claude/agents-enterprise-v2/billing-expert.md` — Stripe PIVOT mechanics.
- `.claude/agents-enterprise-v2/data-expert.md` — advisory-lock + `CREATE TABLE LIKE` discipline.

## Changelog

- v1 (2026-04-17) — initial landing, Phase 3 deliverable, BLOCKER-14 class.
