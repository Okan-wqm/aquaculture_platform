# Foundation Apps Review

**Date:** 2026-05-30  
**Scope:** `apps/db-migrate`, `apps/event-store-service`, `apps/config-service`, `apps/observability-service`  
**Mode:** Read-only architecture review synthesized from the foundation agent.

## Purpose

Identify foundation-layer defects that can invalidate every higher-level app review: production DDL authority, release-ledger gates, config SSOT, event-store correctness, observability privilege boundaries, and deploy/runbook parity.

## Findings

### FOUNDATION-CRITICAL-001: Observability is not gated by authoritative migration ledger

`observability-service` wires TypeORM but does not register `createSchemaVersionGate('observability')`, while its data-source comments say the gate is wired and `db-migrate` has an observability registry entry.

Evidence:

- `apps/observability-service/src/app.module.ts:39`
- `apps/observability-service/src/database/data-source.ts:9`
- `apps/db-migrate/src/schema-registry.ts:273`

Enterprise remediation:

- Add observability to the same gate-only production contract as other long-running services.
- Add a static/invariant test that every schema in `SCHEMA_REGISTRY` has either a matching app schema gate or a documented no-service exception.
- Boot must fail closed if `platform.release_ledger` does not prove the expected migration head.

### FOUNDATION-CRITICAL-002: Event-store append path depends on missing sequence

`event-store.service.ts` calls `nextval('stored_events_global_position_seq')`, but the baseline migration creates the `globalPosition` column and indexes without creating that sequence.

Evidence:

- `apps/event-store-service/src/event-store/services/event-store.service.ts:99`
- `apps/event-store-service/src/migrations/1800000000000-Baseline.ts:12`

Enterprise remediation:

- Define global-position generation as a schema contract owned by event-store migrations.
- Add a migration or replacement design that is idempotent, ordered, and tested against a fresh database.
- Add an append integration test proving global ordering, tenant separation, and replay behavior.

### FOUNDATION-CRITICAL-003: Single-writer DDL boundary is violated at app startup

`db-migrate` documents itself as the only production schema writer, but config and event-store still use runtime RLS bootstrap; config also uses runtime audit-column bootstrap. These paths are nonfatal on failure.

Evidence:

- `apps/db-migrate/src/main.ts:37`
- `apps/db-migrate/src/schema-registry.ts:49`
- `apps/config-service/src/app.module.ts:155`
- `apps/event-store-service/src/app.module.ts:67`
- `libs/backend-common/src/database/rls/rls-schema-bootstrap.service.ts:119`

Enterprise remediation:

- Move production DDL to migrations or `db-migrate` post-migration hardening hooks.
- Runtime apps may probe and refuse boot, but must not silently mutate DDL in authoritative mode.
- Add a gate that blocks `RlsSchemaBootstrapService` or audit-column bootstrap registration when `DB_MIGRATE_AUTHORITATIVE=true`, unless explicitly allowlisted.

### FOUNDATION-HIGH-001: Config system tenant SSOT is split

The config entity and migration use `tenant_id uuid`; some code uses the zero UUID as the system tenant, while other service paths still use literal `'global'`, including seeding.

Evidence:

- `apps/config-service/src/configuration/entities/configuration.entity.ts:62`
- `apps/config-service/src/configuration/configuration.service.ts:79`
- `apps/config-service/src/configuration/configuration.service.ts:240`
- `apps/config-service/src/configuration/handlers/get-configuration.handler.ts:25`
- `apps/config-service/src/configuration/handlers/get-configurations-by-service.handler.ts:97`

Enterprise remediation:

- Choose one system-tenant identifier: the zero UUID if the column is UUID.
- Define it in a shared constant, use it in all handlers/services/seeds, and reject string sentinels at validation boundaries.
- Add tests for seed defaults, get-by-key, get-by-service, and tenant override precedence.

### FOUNDATION-HIGH-002: Observability violates least privilege

Droplet compose runs observability with `${POSTGRES_USER:-aquaculture}`, while the service performs raw cross-schema reads and does not use the documented `BypassRlsService` path.

Evidence:

- `docker-compose.droplet.yml:1263`
- `apps/observability-service/src/app.module.ts:72`
- `apps/observability-service/src/metrics/metrics-aggregator.service.ts:172`

Enterprise remediation:

- Run observability as `observability_service`, not a superuser.
- Replace ad hoc cross-schema reads with explicit read-only grants, read models, or audited bypass semantics.
- Add a startup test/probe proving observability can boot and aggregate without superuser privileges.

### FOUNDATION-HIGH-003: Event-store tenant isolation is inconsistent

The unique aggregate/version index omits `tenantId`, RLS excludes `stored_events`, and the RLS exclusion list references singular `projection_checkpoint` instead of the actual plural table name.

Evidence:

- `apps/event-store-service/src/event-store/entities/stored-event.entity.ts:15`
- `apps/event-store-service/src/event-store/entities/stored-event.entity.ts:94`
- `apps/event-store-service/src/app.module.ts:67`

Enterprise remediation:

- Define whether event-store is globally shared with tenant-scoped columns or schema-per-tenant.
- Make uniqueness, RLS, append query, projection checkpoints, and replay APIs match that model.
- Add tests for same aggregate/version across two tenants, RLS enforcement, and projection checkpoint isolation.

### FOUNDATION-HIGH-004: Event-store projection registry keys are inconsistent

Registration stores projections by `tenantId:name`, but start/reset/process paths look up by `name`, making registered projections unreachable.

Evidence:

- `apps/event-store-service/src/projections/projections.service.ts:42`
- `apps/event-store-service/src/projections/projections.service.ts:123`
- `apps/event-store-service/src/projections/projections.service.ts:297`

Enterprise remediation:

- Define a canonical projection identity type and use it across register/start/reset/process.
- Add tests for tenant-scoped and global projection lifecycle.

### FOUNDATION-HIGH-005: Migration audit docs do not match actual `db-migrate` path

Observability comments describe durable migration events via a local CQRS sink, but the sink only covers observability's own runner. `db-migrate` currently writes release-ledger and boot signal directly.

Evidence:

- `apps/observability-service/src/migration-audit/migration-audit.module.ts:14`
- `apps/observability-service/src/migration-audit/sinks/cqrs-migration-event-sink.ts:23`
- `apps/observability-service/src/migration-audit/consumers/schema-migration-events.consumer.ts:60`
- `apps/db-migrate/src/main.ts:991`

Enterprise remediation:

- Decide the canonical migration audit source: `platform.release_ledger`, `observability.migration_events`, or explicit `db-migrate` event publication.
- Implement one source of truth and make docs, consumers, and boot checks agree.

### FOUNDATION-MEDIUM-001: Deploy/runbook parity is stale

Runbooks reference `event-store-service`, compose does not define it in the same way, prod compose gives observability legacy `DB_*` envs while the app expects `DATABASE_*`, and some services omit explicit production migration envs.

Evidence:

- `docs/runbooks/faz-6-cutover-window.md:74`
- `docker-compose.prod.yml:617`
- `docker-compose.droplet.yml:1326`

Enterprise remediation:

- Align compose, runbooks, required signals, and app env names.
- Add a deploy parity check for service presence, health URL, DB env shape, and migration mode.

### FOUNDATION-MEDIUM-002: Foundation service docs are missing or stale

Config, event-store, and observability READMEs are empty or stale; `db-migrate` has no README found; Dockerfile comments describe an older migration phase.

Evidence:

- `infrastructure/docker/Dockerfile.db-migrate:6`

Enterprise remediation:

- Each foundation app README must state owner schema, production mode, migration mode, health checks, required env, and failure behavior.

## Recommended Fix Order

1. Settle migration authority: observability gate, no runtime DDL in authoritative mode.
2. Repair event-store append and tenant isolation.
3. Normalize config system tenant SSOT.
4. Replace observability superuser access with least-privilege read models/grants.
5. Decide and implement canonical migration audit source.
6. Align compose/runbooks/required signals.
7. Backfill READMEs and add preflight checks.
