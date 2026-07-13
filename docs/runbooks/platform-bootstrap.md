# Runbook — Platform Bootstrap Atom

> ADR reference: [ADR-031](../adr/031-platform-bootstrap-atom.md)
> Audience: operator / on-call engineer
> Trigger: any cluster start, restart, migration deploy, or day-one reset

## TL;DR

The bootstrap atom is Phase 0 of `aqua-db-migrate`. It runs on every invocation. It is idempotent. If it fails, every service refuses to start with a precise error. To re-run, restart the compose service `db-migrate`:

```bash
docker compose -f docker-compose.droplet.yml up --abort-on-container-exit --exit-code-from db-migrate db-migrate
docker logs -f aqua-db-migrate
```

Success looks like one JSON log line with `"message":"Platform bootstrap complete"` followed by per-schema migration lines.

## What the atom does

| Stage | File | Purpose |
|-------|------|---------|
| 001 | `001-extensions.sql` | `CREATE EXTENSION IF NOT EXISTS` × 6 (timescaledb, uuid-ossp, pg_trgm, btree_gist, pgcrypto, vector) |
| 002 | (synthesised) | `CREATE/ALTER ROLE … PASSWORD` × 15 service roles. Passwords from `*_SERVICE_DB_PASS` env vars. Missing or empty values are a hard stop. |
| 003 | `003-schemas.sql` | `CREATE SCHEMA IF NOT EXISTS` × 16 + idempotent ownership transfer |
| 004 | `004-schema-grants.sql` | GRANT + ALTER DEFAULT PRIVILEGES, idempotent re-issue every run |
| 005 | `005-platform-functions.sql` | `CREATE OR REPLACE FUNCTION` × 4 (`current_tenant_id`, `set_tenant_id`, `update_updated_at_column`, `audit_immutability_guard`) |
| 006 | `006-shared-schema-tables.sql` | SHARED_SCHEMA_TABLES (4): `audit_logs`, `gdpr_data_requests`, `user_consents`, `access_logs` (`user_permissions` retired per ADR-042). Includes RLS install + immutability triggers. |
| 007 | `007-bootstrap-signal.sql` | `INSERT ON CONFLICT` `platform.bootstrap_signal` (singleton row) |

## When the atom runs

- On every `aqua-db-migrate` container start.
- Before Phase 1 per-service migrations.
- Coordinated via Postgres advisory lock `hashtext('aqua-db-migrate:platform-bootstrap')` so two simultaneous invocations cannot interleave.
- Aborts the deploy if Phase 0 returns non-zero (no per-service migrations run, no app services start).

## Operator commands

### Quick health check

```bash
docker exec aqua-postgres psql -U aquaculture -d aquaculture -c "
SELECT
  to_char(last_run_at, 'YYYY-MM-DD HH24:MI:SS') AS last_run,
  schema_count,
  function_count,
  shared_table_count,
  bootstrap_version
FROM platform.bootstrap_signal
WHERE id = 1;
"
```

Expected output:

```
       last_run        | schema_count | function_count | shared_table_count | bootstrap_version
-----------------------+--------------+----------------+--------------------+-------------------
 2026-05-18 14:32:17   |           16 |              4 |                  5 | <git-sha>
```

Any of:
- `last_run` older than the most recent deploy
- `schema_count < 16`
- `function_count < 4`
- `shared_table_count < 5`

→ Phase 0 was partial or never ran since the last DROP. Re-run aqua-db-migrate.

### Re-run the bootstrap (no deploy required)

```bash
docker compose -f docker-compose.droplet.yml up --abort-on-container-exit --exit-code-from db-migrate db-migrate
docker logs -f aqua-db-migrate
# Wait for: "Platform bootstrap complete"
docker logs -f aqua-db-migrate 2>&1 | grep "Platform bootstrap complete"
```

### Inspect the platform DDL contract

```bash
# Schemas (expect 16: auth, farm, sensor, hr, messaging, hydroponics, alert,
#                    billing, notification, ai, admin, observability,
#                    event_store, config, gateway, shared)
docker exec aqua-postgres psql -U aquaculture -d aquaculture -c "
SELECT nspname AS schema, pg_catalog.pg_get_userbyid(nspowner) AS owner
FROM pg_namespace
WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('information_schema', 'public', 'platform')
ORDER BY nspname;
"

# Platform functions (expect 4 in `public`)
docker exec aqua-postgres psql -U aquaculture -d aquaculture -c "
SELECT proname FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND proname IN ('current_tenant_id','set_tenant_id','update_updated_at_column','audit_immutability_guard')
ORDER BY proname;
"

# Shared schema tables (expect 5)
docker exec aqua-postgres psql -U aquaculture -d aquaculture -c "
SELECT tablename FROM pg_tables WHERE schemaname = 'shared' ORDER BY tablename;
"
```

## Failure modes

### "Platform bootstrap probe FAILED" at service boot

A service refused to start with:

```
[SchemaVersionGate:auth] Platform bootstrap probe FAILED: ...
```

→ `platform.bootstrap_signal` is missing or unreachable. Run quick health check above. If the table is missing entirely, aqua-db-migrate Phase 0 never completed. Re-run aqua-db-migrate.

### "platform.bootstrap_signal indicates a partial bootstrap"

→ One of `schema_count` / `function_count` / `shared_table_count` is below the expected minimum. Most likely cause: a stage failed mid-run after writing the bootstrap_signal row in a previous run with old counts. Re-run aqua-db-migrate; the post-condition verifier in `platform-bootstrap.service.ts` recomputes counts every run.

### Stage post-condition failure

aqua-db-migrate exits non-zero with one of:

```
[platform-bootstrap] Post-condition: expected 16 platform schemas, observed N.
[platform-bootstrap] Post-condition: expected 4 platform functions in public schema, observed N.
[platform-bootstrap] Post-condition: expected 5 shared schema tables, observed N.
```

Workflow:

1. Read the stage log lines preceding the failure to identify which stage actually completed.
2. Run quick health check — compare to expected counts.
3. Inspect the specific stage's SQL: `apps/db-migrate/src/sql/platform-bootstrap/00X-*.sql`.
4. Common cause: a missing privilege. Check the connecting user is the cluster superuser (`POSTGRES_USER` env in `docker-compose.droplet.yml` should be `aquaculture`, NOT a `*_service` role).
5. Re-run aqua-db-migrate after correcting the privilege grant.

### Missing `*_SERVICE_DB_PASS`

`db-migrate` exits non-zero with a message like:

```
[platform-bootstrap] Phase 0 abort: N/15 service-role password env vars are missing or empty
```

This is intentional. The bootstrap atom no longer generates random passwords
that services cannot know. Seed the missing values in `/var/aqua-saas/.env`
using `scripts/deploy/droplet-bootstrap-env.sh` or the deploy workflow, then
re-run the `db-migrate` compose service.

### Advisory lock contention

```
Waiting for platform-bootstrap advisory lock
```

→ A previous aqua-db-migrate container is still running or crashed without releasing the lock. Default timeout is 300 s. To force release:

```bash
# Identify the session holding the lock
docker exec aqua-postgres psql -U aquaculture -d aquaculture -c "
SELECT a.pid, a.application_name, a.state, a.query_start
FROM pg_locks l JOIN pg_stat_activity a USING (pid)
WHERE l.locktype = 'advisory'
  AND a.application_name LIKE 'aqua-db-migrate%';
"

# If genuinely stuck, terminate
docker exec aqua-postgres psql -U aquaculture -d aquaculture -c "SELECT pg_terminate_backend(<PID>);"
```

## Day-one reset interaction

After a `DROP SCHEMA … CASCADE` cycle (ADR-030 baseline reset):

1. Drop schemas via psql or compose-orchestrated workflow.
2. Restart aqua-db-migrate. Phase 0 idempotently rebuilds every schema, role, function, shared table.
3. Phase 1 per-service migrations apply baseline.
4. `SUPER_ADMIN` restored from `auth-service` SeedService on next boot (env vars: `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD`).

The pre-ADR-031 manual `psql -f infrastructure/docker/init-scripts/00-init-schemas.sh` step is **not** required and is the bug ADR-031 closes.

## Forensic archive

The pre-ADR-031 init scripts are preserved at `infrastructure/docker/init-scripts/.archive/`:

- `00-init-schemas.sh.archived-2026-05-18`
- `05-platform-functions.sql.archived-2026-05-18`
- `09-hr-outbox.sql.archived-2026-05-18`
- `10-shared-schema.sql.archived-2026-05-18`

These files document the pre-cutover contract for audit reference. Do not copy code from them into production paths — they are historical artifacts only.
