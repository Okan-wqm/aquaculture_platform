# Admin Billing Runtime Contract Fix - 2026-05-21

## Scope

This record covers the live runtime failure on the platform-admin billing pages:

- `/admin/billing`
- `/admin/billing/subscriptions`
- `/admin/billing/invoices`
- `/admin/billing/payments`

## Live Findings

- `GET /api/billing/invoices?...` and `GET /api/billing/subscriptions?...` returned HTTP 500 in production.
- `aqua-admin-api` logs showed PostgreSQL `operator does not exist: text = uuid`.
- The failing read-model joins cast `auth.tenants.id` to `text` while production `billing.invoices.tenant_id` and `billing.subscriptions.tenant_id` are UUID.
- `aqua-billing` logs showed NATS subscription permission violations for `request.billing.admin.*`, so the intended billing-service write boundary could not receive admin mutation commands.

## Architectural Decision

Tenant identity remains UUID across auth and billing schemas. Admin-api may expose platform-admin REST read/facade endpoints, but it must not force billing tenant IDs through text joins. Billing-service owns billing mutations, and admin-api must enter writes through the audited billing admin command subjects.

## Fix

- Replaced admin billing tenant joins with UUID-native joins: `auth.tenants.id = billing.<table>.tenant_id`.
- Cast tenant and invoice filter bind parameters to `::uuid` where admin-api accepts string route/query input.
- Added `request.billing.admin.>` to the billing-service NATS subscribe ACL in the SSoT.
- Regenerated `infrastructure/docker/nats/nats.conf` from `infrastructure/nats/services.yaml`.
- Added an invariant test that fails on text-cast tenant joins and on missing billing admin command NATS ACLs.

## Post-Deploy Correction - 2026-05-21

The first live rollout proved the subject existed in the NATS SSoT, but it was on the wrong side of the billing-service ACL. `request.billing.admin.>` must be in `billing_service.subscribe`, not `billing_service.publish`, because billing-service is the command owner and subscribes to those request subjects.

The follow-up fix moved the subject to the subscribe allow-list, regenerated `nats.conf`, and tightened the invariant so it verifies ACL direction instead of only checking subject presence.

## RLS/Audit Hardening Correction - 2026-05-21

After the NATS ACL correction was loaded on the droplet, `aqua-billing` restarted cleanly but logged:

- `rls.bootstrap.failed service="billing" ... must be owner of table invoices`
- `audit_columns.bootstrap.failed service="billing" ... must be owner of table invoices`

Live database inspection showed most `billing.*` financial tables were owned by the authoritative migration role, not by the least-privilege `billing_service` runtime role, and RLS policies were absent on the billing schema. That is an architectural ownership mismatch, not a frontend or API handler bug.

The architectural decision is that `aqua-db-migrate` remains the only production schema writer when `DB_MIGRATE_AUTHORITATIVE=true`. Billing-service must not attempt table-level DDL at startup in that mode. Instead:

- `apps/db-migrate/src/schema-registry.ts` declares billing `postMigrationHardening` for tenant RLS and audit-column conversion.
- `apps/db-migrate/src/main.ts` runs `applyTenantRlsToSchema` and `convertAuditColumnsToTimestamptz` after billing migrations.
- `apps/billing-service/src/app.module.ts` keeps RLS connection/GUC wiring but disables runtime RLS auto-apply and audit-column bootstrap when db-migrate is authoritative.
- `tests/invariants/admin-billing-runtime-contract.spec.ts` now guards the db-migrate ownership contract.

Live remediation on 2026-05-21 used a rebuilt `aqua-db-migrate` one-shot image from this branch. The run completed with `db_migrate_complete`, enabled/forced billing RLS on 8 tenant-scoped tables, installed 8 `tenant_isolation_policy` policies, and converted billing audit columns to `timestamp with time zone`.

## Runtime DDL Gate Correction - 2026-05-21

Post-deploy live logs showed `aqua-db-migrate` completed the hardening successfully, but `aqua-billing` still registered the runtime RLS/audit DDL bootstraps because the AppModule import-time gate only checked a literal `process.env.DB_MIGRATE_AUTHORITATIVE=true`. The live container did not carry that env var even though the production schema-version gate correctly defaulted to db-migrate ownership.

The correction aligns the billing-service import-time resolver with the production/staging default used by the schema-version gate and makes the compose contract explicit:

- `apps/billing-service/src/app.module.ts` treats `NODE_ENV=production`, `AQUA_ENV=production`, and `AQUA_ENV=staging` as db-migrate-owned schema modes unless explicitly overridden.
- `docker-compose.droplet.yml` and `docker-compose.prod.yml` pass `DB_MIGRATE_AUTHORITATIVE=true` and `DATABASE_MIGRATIONS_RUN=false` directly to `billing-service`.
- `tests/invariants/admin-billing-runtime-contract.spec.ts` now guards both the resolver behavior and the compose env contract.

This keeps billing-service responsible for runtime RLS connection/GUC wiring while preventing least-privilege service containers from attempting table-level DDL in production.

## Validation

Local validation run before PR:

- `npx jest --config tests/invariants/jest.config.ts --runTestsByPath tests/invariants/admin-billing-runtime-contract.spec.ts --runInBand`
- `npx tsc --noEmit -p apps/billing-service/tsconfig.app.json`
- `npx eslint apps/billing-service/src/app.module.ts tests/invariants/admin-billing-runtime-contract.spec.ts`
