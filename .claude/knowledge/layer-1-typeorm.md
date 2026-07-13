# Layer-1 TypeORM — Persistence + migrations

**Audience:** data-expert, database-reviewer, every domain expert writing backend persistence.
**Anchor:** TypeORM 0.3.27 + `@nestjs/typeorm` 11.0.0 + pg 8.16 + TimescaleDB, as of 2026-04-16.

Depends on: `layer-1-core.md`, `layer-1-nestjs.md`. Shared schema + tenant patterns live here; multi-tenant semantics are in `layer-2-patterns.md`.

## DataSource API (0.3.x)

- **`DataSource` not `Connection`** — the legacy `Connection` API is deprecated and fully eradicated from backend code (W1 anti-pattern scan confirms 0 occurrences). Every service owns `apps/<svc>/src/database/data-source.ts` exporting a `DataSource` instance.
- **`@InjectDataSource()` / `@InjectRepository()`** — standard NestJS integration. Prefer `getScopedRepository<T>(ctx)` (tenant-aware) over `InjectRepository` / `getRepository` for tenant-scoped queries. Raw `getRepository()` is banned by ESLint `no-restricted-syntax`.
- **Transaction scope** — use `dataSource.transaction(async manager => …)` for multi-statement atomicity. Within a transaction, always use the `manager` argument — never the outer repositories, which run outside the transaction.

## Entity decoration (ADR-011 schema ownership)

- **`@Entity('table_name', { schema: '<service>' })`** — MANDATORY. 157 entities currently violate this (W1 anti-pattern reconciled count, up from Round-3 assumption of 2). Fix scheduled W2-W3 via mechanical migration (BLOCKER-8 cascade).
- **Column types** — declare explicit types (`@Column('uuid')`, `@Column('timestamptz')`, `@Column({ type: 'jsonb', nullable: false })`). Implicit inference drifts between TypeORM versions.
- **`jsonb` columns** — allowed only at documented boundary (event-store payload, config-service values). Domain code may NOT use `jsonb` as a "dumping ground to avoid typed columns" — banned pattern.
- **Relations** — prefer explicit `@ManyToOne`/`@OneToMany` with cascade options declared rather than inferred. FK constraints land on the child side.
- **Cross-schema FKs** — FORBIDDEN. A `farm` schema entity may NOT have a `@ManyToOne` pointing to an `auth` schema entity. Use eventual consistency via events instead.

## Migration discipline (ADR-012 drift prevention)

- **Generator-driven** — `nx run <svc>:migration:generate --name=<descriptive>`. Never hand-edit checked-in migrations; always generate a new one on top.
- **Reversible `down()`** — every migration implements its inverse. Destructive migrations (DROP COLUMN / DROP TABLE) require a pre-migration `pg_dump` artifact path verified as present (W6 pre-migration-restore-test skill — D12 finding).
- **Blue-green 3-step dance** for NOT NULL on a non-empty table:
  1. Migration A — add column as nullable
  2. Migration B — backfill existing rows
  3. Migration C — `ALTER … SET NOT NULL`
  The `add-entity-field` skill (W5) enforces this — single-step NOT NULL on existing data is banned by `migration-sql-lint.ts` (W5 deliverable).
- **Lock management** — every DDL transaction sets `SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s';` before running. Session-scope `SET search_path` (without `LOCAL`) was the 2026-04-07 pool-contamination incident root cause. Multiple migrations still carry session-scope `search_path` (DATA-HIGH-003 — exact set enumerated there) — W5 fix.
- **Concurrent indexes** — `CREATE INDEX CONCURRENTLY` on tables > 10k rows. Blocks writes otherwise. Detected by `migration-sql-lint.ts`.
- **Volatile defaults** — `ADD COLUMN … DEFAULT now()` / `DEFAULT gen_random_uuid()` triggers a full table rewrite. Use nullable + backfill instead.

## SchemaDriftValidator + MigrationRunner (ADR-011 + ADR-012)

- **`SchemaDriftModule.forRoot({ serviceName })`** — registered in every schema-owning service's `AppModule`. 14 services per `tests/invariants/_constants.ts` (BLOCKER-8). Validator runs `OnApplicationBootstrap` and logs `schema.drift.detected` on divergence. `SCHEMA_DRIFT_FATAL=true` in production hard-fails boot on drift.
- **`createMigrationRunnerService('<schema>')`** — registered as AppModule provider. Production MUST set `DATABASE_MIGRATIONS_RUN=false`; runner owns migration execution. TypeORM's auto-run is disabled via `migrationsRun: false` in TypeOrmModule config.
- **`config-service`** currently has `createMigrationRunnerService('public')` hardcoded at `apps/config-service/src/app.module.ts:24` — direct ADR-011 violation (PLAT-CRITICAL-002). Fix W2-W3.

## Multi-tenant patterns

- **Schema-per-tenant services (7)** — farm, sensor, hr, messaging, hydroponics, alert-engine, ai. Each tenant gets a dedicated schema (e.g., `farm_tenant_abc123`). Defined in `PER_TENANT_SCHEMA_SERVICES` constant (`tests/invariants/_constants.ts`).
- **Shared-schema services (6)** — auth, billing, admin-api, event-store, config, notification. Cross-tenant by nature; tenant scoping enforced at the query layer via `TenantScopedRepository` + RLS policies.
- **Shared tables (4 canonical, per ADR-011 as amended by ADR-042)** — `audit_logs`, `gdpr_data_requests`, `user_consents`, `access_logs` in the `shared` schema (`user_permissions` retired 2026-07-12, ADR-042). Adding a 5th requires ADR + architectural-arbiter approval (`add-shared-table` skill W5 — BLOCKER-15).
- **RLS policies** — currently on 2 of 7 per-tenant services (farm, messaging). Other 5 rely on search_path alone (MT-HIGH-003 defense-in-depth gap). W5-W6 fix via `add-rls-policy` skill template.

## References

- Slice audit: `/var/aqua-saas/docs/reviews/_audit/2026-04-W16-backend-data.md`
- `/var/aqua-saas/docs/reviews/_audit/2026-04-W16-backend-platform.md` — PLAT-CRITICAL-001/002 findings
- `/var/aqua-saas/libs/backend-common/src/database/` — SchemaDriftValidator, TenantScopedRepository, migration runner factory
- ADR-011 (schema ownership), ADR-012 (drift prevention), ADR-006 (event flat pattern for persisted events)
