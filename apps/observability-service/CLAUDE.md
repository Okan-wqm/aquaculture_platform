# observability-service — CLAUDE.md (domain context)

> Root rules in `/CLAUDE.md` already apply (always loaded). This file adds ONLY the observability facts that CONTRADICT a correct reading of those rules.

Prometheus scrape targets, tracing, security events, migration telemetry. Schema: `observability` (platform-level).

## All four entities are `infrastructureTables`; `tables` is empty

<!-- infra-tables:observability -->`migrations`, `emergency_overrides`, `migration_backfill_progress`, `migration_events`, `schema_object_history`<!-- /infra-tables -->

`tables: []`. config-service does the opposite — it puts its entity tables in `tables` — and both are correct: `tables` drives per-tenant fan-out for tenant-scoped modules and is merely a registry surface for platform-level ones. Do not "align" the two services.

This is also the only module whose `infrastructureTables` omits the erasure-proof ledger spread, because observability is deliberately not a tenant-erasure target (DSAR export IS wired). Proven against `MODULE_SCHEMAS` by `tests/invariants/nested-steering-parity.spec.ts` — edit the registry, never this copy.

## `excludeTables: []` is a documented exemption, not an oversight

`RlsModule.forPoolService` here sets `autoApply: false` with an empty `excludeTables`, and `apps/observability-service/src/app.module.ts` is one of exactly two files allowlisted as `EXEMPT_LITERAL` in `tests/invariants/rls-exclude-tables-ssot.spec.ts`. Replacing it with `getRlsExcludeTablesForService()` would fight that exemption.

## Enforcement

Boot: `SchemaDriftValidator` (registered for the `schema_drift_clean` signal required by `infrastructure/deploy/required-signals.yaml`), `createSchemaVersionGate('observability', { tenantAware: false })`. CI: `tests/invariants/rls-exclude-tables-ssot.spec.ts`, `platform-entity-registry-parity.spec.ts`.
