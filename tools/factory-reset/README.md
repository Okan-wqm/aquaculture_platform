# factory-reset

One-shot operator CLI to reset the live droplet's data state to "ilk gun" (day-one).

This is **not** a routine task. It is the architectural answer to "we need to rebuild the platform's data state from zero without re-deploying the stack." Every other recovery shape (per-tenant purge, per-table truncate, schema-by-schema `db-migrate revert`) belongs in a different tool.

---

## When to use this tool

- The droplet's data state is corrupted beyond per-table repair (cross-schema drift, ghost tenants, broken RLS bootstrap, pre-launch bad seed).
- The platform owner has decided to discard ALL existing tenants/users in exchange for a clean re-bootstrap.
- The reset will run on the droplet host (or a host with `docker` access to the same daemon).

If the goal is anything narrower (single tenant cleanup, single migration revert, dump-and-restore), STOP and use the appropriate per-domain tool instead. This CLI does not have a smaller granularity.

## What it destroys (irreversibly)

- All 6 named docker-compose volumes:
  - `postgres_data` — every tenant's data (5 tenants), all `tenant_<uuid>` schemas, all 7 users (including by-okan)
  - `redis_data` — sessions, cache, BullMQ queues
  - `nats_data` — JetStream streams + consumers + persisted messages
  - `minio_data` — uploaded files, GDPR exports, attachments
  - `mosquitto_data` + `mosquitto_log` — MQTT retained messages, broker state
- The running stack containers (replaced fresh on `up -d`).

## What it does NOT destroy

- Git commit history (the CLI never touches the working tree).
- Secrets, env vars, or `.env` files (these live on the host, not in volumes).
- Container images (cached via the registry; `up` re-uses them).
- The by-okan SUPER_ADMIN row — it is **re-seeded** by `auth-service`'s `SeedService` from `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` env vars on first boot of the new auth container.

## Prerequisites

1. Run on the droplet host (or a host with `docker` access to the droplet daemon).
2. `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` must be set on the auth-service container env. The CLI will warn during preflight if it cannot detect them, but the seed itself runs inside the new container based on its own env block in the compose file.
3. Node 22+ on the host (for `--experimental-strip-types`).
4. The `docker-compose.droplet.yml` file in the repo root (read by the CLI).

## Rollback

**Not possible without a prior `pg_dump` snapshot.** This tool is destructive by design. If you might want to undo, snapshot first:

```bash
# Before running --execute, on the droplet:
docker exec aqua-postgres pg_dumpall -U aquaculture > /var/backups/aquaculture-pre-reset-$(date +%F).sql
```

The CLI does NOT take this snapshot automatically — operator-driven backup is the architectural choice (the CLI must not be the SSoT for backup retention policy).

## Safety guards (three concurrent — all must pass)

`--execute` mode requires all three:

| Guard | Purpose |
|-------|---------|
| `--execute` flag | Default mode is `--dry-run`; you must opt in explicitly |
| `FACTORY_RESET_ALLOWED=1` env | Blocks accidental CI/automation runs |
| stdin literal `FACTORY RESET` | Prevents fat-finger: the CLI prompts and only proceeds on an exact-string match |

Any guard failing aborts with exit code `3`.

## Phase pipeline

The CLI runs these 7 phases in order. Each emits structured JSON on stdout. A failure aborts the rest with exit code `1`.

| # | Phase           | What it does |
|---|-----------------|--------------|
| 1 | `preflight`     | Verifies docker is reachable, the compose file exists, and the auth-service env declares `SUPER_ADMIN_EMAIL` + `SUPER_ADMIN_PASSWORD` |
| 2 | `compose-down`  | `docker compose -f docker-compose.droplet.yml down -v --remove-orphans` (28 services + 6 volumes gone) |
| 3 | `volume-prep`   | Re-creates `<project>_postgres_data` and chowns it to `1000:1000` via a one-shot busybox container (the postgres SSL entrypoint requires this UID) |
| 4 | `compose-up`    | Brings the stack back online MINUS `sensor-ingestion` (no published image yet) |
| 5 | `wait-healthy`  | Polls `aqua-postgres` (60s) then `aqua-auth` (120s — needs migration + seed) |
| 6 | `verify-seed`   | Asserts `auth.users` has exactly one row: `email='by-okan@live.com'`, `role='SUPER_ADMIN'`, `tenantId IS NULL` |
| 7 | `audit-emit`    | Inserts `PLATFORM_FACTORY_RESET` row in `shared.audit_logs` with before/after counts + git SHA |

## Usage

### Dry-run (default)

```bash
node --experimental-strip-types tools/factory-reset/factory-reset.ts
```

Or via npm:

```bash
npm run factory:reset:dry
```

The CLI prints what each phase WOULD do, executes ZERO destructive actions, and exits `0`.

### Real execution

```bash
FACTORY_RESET_ALLOWED=1 \
  node --experimental-strip-types tools/factory-reset/factory-reset.ts --execute
```

Or via npm:

```bash
npm run factory:reset:execute
```

The CLI prompts for the `FACTORY RESET` confirmation. On match, the 7-phase pipeline runs against the live droplet daemon.

### Single-phase debug

There is intentionally no `--phase=N` flag. The phases are sequenced for a reason — running them out of order leaves the data state worse than before. If you need to debug a single phase:

1. Read the source of the phase under `lib/<phase>.ts`.
2. Replicate the docker / psql commands directly on the host.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success (or successful dry-run) |
| 1 | Failure during execution (see logs for the offending phase) |
| 2 | Usage error (unknown flag, missing arg) |
| 3 | Guard violation (`FACTORY_RESET_ALLOWED` unset, stdin mismatch, etc.) |

## Logs

Every line on stdout/stderr is one JSON object. Pipe to `jq` for human reading:

```bash
node --experimental-strip-types tools/factory-reset/factory-reset.ts | jq -c '.'
```

The audit row written by phase 7 captures the full reset envelope. Query it after the fact:

```bash
docker exec aqua-postgres psql -U aquaculture -d aquaculture -c \
  "SELECT \"createdAt\", action, metadata FROM shared.audit_logs WHERE action='PLATFORM_FACTORY_RESET' ORDER BY \"createdAt\" DESC LIMIT 1;"
```
