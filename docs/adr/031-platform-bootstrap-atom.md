# ADR-031 — Platform Bootstrap Atom

## Status

ACCEPTED (2026-05-18). Supersedes the implicit "init-scripts run schema/role/extension bootstrap" contract that lived in `infrastructure/docker/init-scripts/00-init-schemas.sh`, `05-platform-functions.sql`, `09-hr-outbox.sql`, `10-shared-schema.sql`.

## Context

PostgreSQL's official docker-entrypoint runs files in `/docker-entrypoint-initdb.d/` **once on initdb** — only when PGDATA is empty. After that first initialization the scripts are never re-evaluated, regardless of container restart, schema drop, role drop, or extension drop. This is documented Postgres-image contract and changing it is out-of-scope: the upstream behavior is correct for typical single-tenant deployments.

The aquaculture platform's day-one baseline reset cycle (ADR-030) plus the multi-tenant fan-out architecture pushed the init-scripts contract past its breaking point:

1. **Cutover sequence** (Faz 6 of the day-one reset) requires `DROP SCHEMA ... CASCADE` of every per-service schema, then re-creation. The init-scripts owned that re-creation but didn't fire because PGDATA was non-empty.
2. **Container restart survival** is required for any postgres maintenance window (volume backup, base image upgrade, manual psql operator intervention). Stack restart wipes ephemeral state in app containers but leaves PGDATA intact — so init-scripts never re-evaluate even though app services boot expecting the platform DDL contract.
3. **Role + grant idempotency** — `00-init-schemas.sh` mixed env-aware password generation with schema/grant DDL. The two responsibilities had different lifecycle semantics: roles must always exist with current passwords (deploy-time concern); schemas must exist with correct ownership (one-time-then-immutable). Bundling them produced a 540-line bash file that no single operator could read end-to-end.

Three production failure modes traced to this:

- **2026-05-18 Faz 6 cutover #1:** DROP SCHEMA succeeded; postgres container restart wiped working memory; manual psql init re-run partially completed; service boot found `auth` schema present but `farm` schema absent. Required forensic recovery from vault.
- **2026-04-19 image swap (INFRA-CRITICAL-018):** image-family PGDATA default divergence triggered the same class — new image's docker-entrypoint detected the existing volume as a pre-initialized cluster, skipped init-scripts, and the SHARED_SCHEMA_TABLES that had been freshly added to `10-shared-schema.sql` never landed.
- **2026-04-14 SHARED_SCHEMA_TABLES partial install:** init-scripts ran successfully against empty PGDATA but didn't include `access_logs` in the canonical list at the time. Adding the table later in `10-shared-schema.sql` meant existing environments never picked it up.

## Decision

The platform DDL contract is owned by a dedicated **Platform Bootstrap Atom** that runs as Phase 0 of `aqua-db-migrate` on every invocation. The init-scripts contract is narrowed to "initdb-only operations that are safe to run exactly once": database-level GRANTs and defensive `CREATE EXTENSION IF NOT EXISTS`.

### Architecture

```
postgres (healthy)
   │
   ▼
aqua-db-migrate (one-shot)
   │
   ├─ Phase 0: Platform Bootstrap Atom
   │   ├─ stage 001: CREATE EXTENSION IF NOT EXISTS (×6)
   │   ├─ stage 002: CREATE/ALTER ROLE ... PASSWORD (×15, env-aware)
   │   ├─ stage 003: CREATE SCHEMA IF NOT EXISTS (×16) + AUTHORIZATION
   │   ├─ stage 004: GRANT + ALTER DEFAULT PRIVILEGES (idempotent)
   │   ├─ stage 005: CREATE OR REPLACE FUNCTION public.* (×4)
   │   ├─ stage 006: shared.* tables + RLS + immutability triggers (×5)
   │   └─ stage 007: INSERT ON CONFLICT platform.bootstrap_signal
   │
   ├─ Phase 1: Per-service migration loop (existing contract)
   │
   └─ exit 0  → service_completed_successfully
       │
       ▼
   app services
       │
       ├─ probe platform.bootstrap_signal  ← refuse boot if missing
       ├─ probe <schema>.migrations ← refuse boot if empty
       └─ start
```

### Tier 1 architectural properties

This decision sits at Tier 1 of the architectural-solution hierarchy:

- **Make it impossible**: schema DDL outside the bootstrap atom is rejected at CI time by `tests/invariants/init-scripts-no-schema-ddl.spec.ts`. The invariant scans every file under `infrastructure/docker/init-scripts/*.{sh,sql}` and fails on `CREATE SCHEMA`, `CREATE ROLE`, `CREATE TABLE`, `CREATE FUNCTION`, `CREATE POLICY`, `GRANT ... ON SCHEMA`, `ALTER SCHEMA`, `ALTER DEFAULT PRIVILEGES`, or `ALTER TABLE`. The forbidden-pattern list mirrors the responsibilities that MOVED to the atom.
- **Make it automatic**: every stack restart invokes aqua-db-migrate which re-applies the bootstrap atom idempotently. `CREATE EXTENSION IF NOT EXISTS`, `CREATE SCHEMA IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, and re-issued GRANTs are all no-ops when the artifact already exists in the desired shape.
- **Make it detectable**: `SchemaVersionGate.probePlatformBootstrap()` reads `platform.bootstrap_signal` at every service boot. Missing table / missing row / partial-apply counts all produce a precise refuse-to-boot error pointing at the aqua-db-migrate container's logs.

### Why not "fix" init-scripts to re-run

We considered patching the postgres docker-entrypoint to re-evaluate `/docker-entrypoint-initdb.d/` on every container start. Rejected because:

1. **Fork-and-maintain cost**: the upstream postgres image's entrypoint behavior is load-bearing for the wider ecosystem. Forking it makes us responsible for tracking every upstream entrypoint change.
2. **Wrong contract anyway**: init-scripts are bash + raw SQL. The platform's bootstrap concerns — env-aware passwords, structured logging, advisory lock, post-condition verification, boot signal — belong in TypeScript with the same observability surface as the rest of the migration runner. Moving SchemaDriftValidator-grade observability into bash scripts would replicate the same drift surface we're trying to eliminate.
3. **Single boot signal**: with the bootstrap atom owning the entire DDL contract, the deploy pipeline gets one cross-service synchronisation point (`db_migrate_complete` boot signal) instead of two (init-scripts implicit success + aqua-db-migrate exit code). One signal is one less drift surface.

### Why not split into a separate "db-init-v2" container

The previous `db-init` container (compose definition) ran role password sync but didn't own schema bootstrap. Splitting into:
- `db-init` (roles + passwords)
- `db-init-schema` (schemas + grants + functions)
- `db-init-shared` (shared.* tables)
- `db-migrate` (per-service migrations)

was discussed. Rejected because:

1. Three additional containers each running short SQL workloads multiply orchestration surface (depends_on graph, restart policies, log aggregation) without buying isolation we actually need — every step here runs as the postgres superuser, against the same database, with the same trust boundary.
2. The advisory lock has to coordinate across containers, requiring shared lock-key conventions and timeout coordination — exactly the cross-container synchronisation pain `aqua-db-migrate` was created to consolidate (ADR-016 Phase E).
3. The TypeScript runner re-uses the same connection pool, structured logger, env-resolution discipline, and post-condition verifier as the existing migration loop. Splitting forces re-implementation across containers.

### Migration path

The bootstrap atom is idempotent against any prior state:

- **Fresh PGDATA**: init-scripts' `01-init-databases.sql` runs once (database create + extension defensive install). aqua-db-migrate then applies Phase 0 against an empty cluster; every IF NOT EXISTS / OR REPLACE statement creates from zero.
- **Existing PGDATA with pre-ADR-031 init scripts already applied**: Phase 0 observes existing schemas/roles/functions and is a near-no-op. ALTER ROLE re-applies env passwords (correcting any drift). Stage 007 writes the first bootstrap_signal row.
- **Day-one reset**: operator drops every per-service schema → next aqua-db-migrate invocation runs Phase 0 which re-applies the contract → Phase 1 applies baseline migrations → services boot.

Operator hand-runs (`psql -f infrastructure/docker/init-scripts/00-init-schemas.sh`) are no longer required as a recovery path. They were the manual workaround that the bootstrap atom eliminates.

## Consequences

### Positive

- Postgres container restart survives without manual psql intervention.
- DROP SCHEMA CASCADE + redeploy is fully automatic (next aqua-db-migrate Phase 0 rebuilds the schema contract).
- Single SSoT for platform DDL — `apps/db-migrate/src/sql/platform-bootstrap/` + the TypeScript runner.
- Env-aware role passwords use the same TypeScript secret-management discipline as the rest of the platform.
- `platform.bootstrap_signal` table gives operators forensic visibility (last run time, schema/function/shared-table count, bootstrap version label).
- Init-scripts surface narrowed from 540 lines of bash + 4 SQL files to a single 60-line documented SQL file (`01-init-databases.sql`).

### Negative

- aqua-db-migrate's responsibility grows. Its image now carries the bootstrap SQL files (~20 KB) and TypeScript runner (~300 LOC). The added runtime is ~1-3s in steady state.
- The previous `db-init` container is removed from compose; operators who scripted around `aqua-db-init` exit signals must switch to `aqua-db-migrate`. The wider compose-level depends_on graph already pointed at `db-migrate: service_completed_successfully`, so the operator-facing contract is unchanged.
- A bug in the bootstrap atom blocks every service boot. Mitigation: post-condition probes inside the atom (every stage verifies its own DDL applied) + structured JSON logs + the new `platform-bootstrap.spec.ts` integration test runs the atom twice in a testcontainer to assert idempotency before merge.

## Implementation

- `apps/db-migrate/src/sql/platform-bootstrap/001-extensions.sql`
- `apps/db-migrate/src/sql/platform-bootstrap/003-schemas.sql`
- `apps/db-migrate/src/sql/platform-bootstrap/004-schema-grants.sql`
- `apps/db-migrate/src/sql/platform-bootstrap/005-platform-functions.sql`
- `apps/db-migrate/src/sql/platform-bootstrap/006-shared-schema-tables.sql`
- `apps/db-migrate/src/sql/platform-bootstrap/007-bootstrap-signal.sql`
- `apps/db-migrate/src/platform-bootstrap.service.ts`
- `apps/db-migrate/src/main.ts` (Phase 0 wiring)
- `infrastructure/docker/Dockerfile.db-migrate` (COPY SQL dir)
- `infrastructure/docker/init-scripts/.archive/*` (forensic copies of pre-ADR-031 files)
- `docker-compose.droplet.yml` (db-init removed; db-migrate carries service-role passwords)
- `libs/backend-common/src/database/schema-version-gate.service.ts` (`probePlatformBootstrap`)
- `tests/invariants/init-scripts-no-schema-ddl.spec.ts`
- `docs/runbooks/platform-bootstrap.md`

## References

- ADR-011 — Schema Ownership Model
- ADR-012 — Schema Drift Prevention
- ADR-016 — `aqua-db-migrate` one-shot orchestrator (Phase E)
- ADR-021 — `db-migrate` authoritative ledger writer
- ADR-030 — Day-One Baseline Reset
- `docs/runbooks/platform-bootstrap.md` — operator how-to
- `docs/runbooks/schema-drift-response.md` — drift incident response
- 2026-05-18 incident log — Faz 6 cutover #1 (`/root/.claude/plans/peppy-crafting-waterfall.md` STATUS LOG)
