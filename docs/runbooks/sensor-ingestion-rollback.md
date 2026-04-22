# Runbook: sensor-ingestion + ADR-031 Policy Migration Rollback

**Owner:** platform team (DBA + sensor-service + admin-api-service maintainers)
**Related ADRs:** ADR-011 (schema ownership, blue-green safe migrations), ADR-029 (Rust outbox), ADR-030 (RLS parity), ADR-031 (NATS request-reply / policy state)
**Plan reference:** `/root/.claude/plans/snappy-sniffing-pine.md` Kör Nokta 14
**Related orphan findings:** `ORPHAN-020` (db-migrate runner rollback workflow unverified — this runbook covers the manual path until ORPHAN-020's CLI fix lands).

## Purpose

Operate a safe, bidirectional rollback of every database migration the Rust migration delta introduced. Each section lists the migration, its blast radius, the prerequisite service-state you MUST reach before executing the `down()`, the actual SQL the `down()` runs, the post-rollback restore steps, and the tests that prove the roll-forward still works.

This runbook is **destructive** — every section's `down()` drops or reshapes a production table. Operator-buddy review is REQUIRED for every section.

---

## Scope — migrations covered

| Migration | File | Service owner | Risk | Blue-green safe? |
|---|---|---|---|---|
| V016 — sensor.event_outbox | `apps/sensor-service/src/database/migrations/1786000200000-CreateSensorEventOutbox.ts` | sensor-service | HIGH — table drops means pending outbox rows are lost | Yes if dispatcher is drained first |
| V_move — sensor.* RLS enable (embedded) | `apps/sensor-service/src/database/migrations/1786000100000-MovePublicTablesToSensor.ts` | sensor-service | HIGH — RLS disable reopens cross-tenant read paths for the duration | Yes if app.bypass_rls connections are known |
| V018 — admin.ingest_backend_policy_state | `apps/admin-api-service/src/migrations/1787300000000-CreateIngestBackendPolicyState.ts` | admin-api-service | MEDIUM — rollout-decision SoT is lost; Rust sidecar cold-start falls back to TOML config | Yes if snapshot JSON is captured first |

The master TypeORM migration for `CreateSensorMetrics` (`1735900000000-CreateSensorMetrics.ts`, V0015 conceptually) is NOT COVERED HERE — it landed before the Rust migration delta and has no roll-forward counterpart in the delta plan; its rollback (if ever needed) is covered by `docs/runbooks/database-capacity.md`.

---

## Rollback procedure — common prelude

Run these steps BEFORE any section's `down()`:

1. **Silence + acknowledge all alerts.** In Grafana/Alertmanager, silence the sensor-ingest + admin-api alert groups for the change window (typical ~30 min). Leaving alerts firing during a rollback burns operator attention on expected noise.
2. **Announce in the platform channel.** Post: `ROLLBACK window opens — sensor-ingestion migration <id> — owner <name> — buddy <name> — ETA <time>`. The announcement pins a responsibility anchor.
3. **Snapshot the production DB.** `pg_dump --schema-only --schema=sensor --schema=admin > /tmp/pre-rollback-$(date -u +%s).sql`. Data dump is too large for hot use; schema dump is fine for audit.
4. **Confirm the current migration head.** Run `SELECT name FROM migrations ORDER BY timestamp DESC LIMIT 5;` on each affected service's DB connection — you MUST see the migration at the top of the list before you roll it back.

If any of 1–4 cannot complete, abort the rollback.

---

## V018 — admin.ingest_backend_policy_state

**Migration:** `apps/admin-api-service/src/migrations/1787300000000-CreateIngestBackendPolicyState.ts`

**Blast radius:**
- `admin.ingest_backend_policy_state` table + singleton row disappear.
- `IngestBackendPolicyService.getSnapshot()` starts throwing `NotFoundException` on every call.
- Rust sidecar `policy.ingest_backend.snapshot` request-reply returns a `RequestReplyRemoteError{code: "NotFoundException"}` — sidecars hit the fallback chain (disk → TOML default).
- admin-api-service `IngestBackendPolicyService.applyChange` starts throwing too — operator rollout changes are blocked until the restore lands.

### Pre-rollback capture (MANDATORY)

Operator MUST snapshot the current row to reconstruct state post-restore:

```bash
psql "$DATABASE_URL" -c "SELECT row_to_json(r) FROM admin.ingest_backend_policy_state r WHERE key = 'current';" \
  > /tmp/ingest-backend-policy-snapshot-$(date -u +%s).json
```

Capturing the row is load-bearing — without it the restore path has no source of truth and falls back to the default (`{defaultBackend: 'node', overrides: {}}`), which silently reverts every tenant that was enrolled in the Rust sidecar.

### Cold-start guarantee during the rollback window

Before dropping the table, confirm every sensor-ingestion sidecar instance has its `/var/lib/sensor-ingestion/last-known-policy.json` file populated + recent:

```bash
# on each sidecar host
jq .defaultBackend /var/lib/sensor-ingestion/last-known-policy.json
stat -c '%y' /var/lib/sensor-ingestion/last-known-policy.json  # should be < 24h old
```

If the file is missing OR older than 24h, abort. The disk fallback is the secondary source of truth during the outage; a stale file causes wrong routing during restore.

### Down SQL

```sql
DROP TABLE IF EXISTS admin.ingest_backend_policy_state;
```

### Restore (roll-forward)

After up-migration re-applies the schema + safe-default seed:

```bash
# Re-insert the captured snapshot row so tenants keep their prior
# rollout state. Reads the JSON captured in the pre-rollback step.
SNAPSHOT_FILE=/tmp/ingest-backend-policy-snapshot-<timestamp>.json

# Build the UPDATE statement from the captured JSON.
psql "$DATABASE_URL" <<SQL
UPDATE admin.ingest_backend_policy_state
SET
  "defaultBackend" = $$(jq -r .defaultBackend "$SNAPSHOT_FILE")$$,
  overrides = $$(jq -c .overrides "$SNAPSHOT_FILE")$$::jsonb,
  "updatedBy" = $$(jq -r '.updatedBy // ""' "$SNAPSHOT_FILE")$$
WHERE key = 'current';
SQL
```

Republish a single `policy.ingest_backend.changed` event to force every live sidecar to re-apply the restored state — the simplest trigger is to call `IngestBackendPolicyService.applyChange` with a no-op action (e.g. `set_global` with the current default):

```bash
# via admin-api service CLI / test harness — NOT an ops-facing
# surface. Alternative: direct `nats publish` from an ops host
# with the admin-api CN cert.
nats pub policy.ingest_backend.changed \
  "$(jq -c . < /path/to/noop-changed-event.json)"
```

### Verification

```bash
# Sidecar health
curl -sf http://<sidecar>:9091/metrics | grep sensor_ingestion_policy_bootstrap_source
# Expect: sensor_ingestion_policy_bootstrap_source_nats_total to increment
# on every subsequent container start (no more disk fallback).

# Admin-api snapshot reachable
nats req policy.ingest_backend.snapshot '{}' -t 2s
# Expect: a JSON IngestBackendSnapshot reply matching the captured file.
```

---

## V016 — sensor.event_outbox

**Migration:** `apps/sensor-service/src/database/migrations/1786000200000-CreateSensorEventOutbox.ts`

**Blast radius:**
- `sensor.event_outbox` table + its partitioning disappear.
- Every sensor-ingestion sidecar dispatcher instance immediately starts failing on `SELECT … FOR UPDATE SKIP LOCKED` — recoverable by stopping the dispatcher cleanly first (see pre-rollback).
- `PostgresSink::write_tenant_batch` transactions that include an outbox enqueue ROLLBACK, which means MQTT messages that arrive during the rollback window bounce back to the broker (QoS-1 inflight redelivery) — no data loss, but the broker's inflight window fills up.

### Pre-rollback (MANDATORY)

1. Confirm `dispatched_at IS NOT NULL` for every row:
   ```sql
   SELECT COUNT(*) AS pending
   FROM sensor.event_outbox
   WHERE dispatched_at IS NULL;
   ```
   If `pending > 0`, drain the dispatcher before proceeding. Either wait for the dispatcher's next tick batch to clear (250ms tick × N batches) or manually invoke `OutboxDispatcher::run_one_tick` until pending is zero. NEVER drop the table with non-dispatched rows; those events are permanently lost.

2. Send SIGTERM to every sidecar instance. The shutdown path in `main::shutdown_outbox_pipeline` signals the dispatcher + maintenance tasks; both exit at their next tick boundary. Wait for each container to report exit code 0 before proceeding.

### Down SQL

See the migration file's `down()` method. At time of writing:

```sql
DROP TABLE IF EXISTS sensor.event_outbox;
```

### Restore (roll-forward)

1. Run `npm run migrate:up` (which re-applies the TypeORM migrationsRun flow) OR replay the `up()` from the migration file via psql.
2. Restart the sidecars — they'll pick up the re-created table on next boot.
3. Replay the lost window from the MQTT broker: verify the broker's QoS-1 queue backlog metric dropped to zero within the expected redelivery window.

### Verification

```bash
# Sidecar health + outbox depth
curl -sf http://<sidecar>:9091/metrics | grep sensor_ingestion_outbox_pending
# Expect: gauge at zero or near-zero steady state.

# No missing ROWS in sensor.event_outbox sequence
psql -c "SELECT MIN(id), MAX(id), COUNT(*) FROM sensor.event_outbox;"
# Expect: COUNT = MAX - MIN + 1 (no gaps).
```

---

## V_move — RLS enable on sensor.*

**Migration:** `apps/sensor-service/src/database/migrations/1786000100000-MovePublicTablesToSensor.ts`

This migration's `down()` disables `ROW LEVEL SECURITY` on every tenant-scoped `sensor.*` table that it moved from `public`. Disabling RLS reopens cross-tenant read paths for the duration of the rollback window — this is the **highest-risk rollback** in this runbook.

### Pre-rollback (MANDATORY)

1. **Stop every application tenant-scoped query.** Scale `sensor-service`, `sensor-ingestion`, and every other service that issues `sensor.*` queries to zero replicas. During the rollback window, the DB is mutation-only from DBA operations.
2. **Verify zero app.current_tenant settings are active:**
   ```sql
   SELECT pid, application_name, state,
          current_setting('app.current_tenant', true) AS app_tenant
   FROM pg_stat_activity
   WHERE state != 'idle'
     AND current_setting('app.current_tenant', true) IS NOT NULL;
   ```
   Expected: zero rows. If any appear, kill the session before proceeding:
   ```sql
   SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE ...
   ```

### Down SQL

See the migration file's `down()` method. It runs `ALTER TABLE … DISABLE ROW LEVEL SECURITY` + `DROP POLICY` on every table.

### Restore (roll-forward)

Running `up()` re-enables RLS. The runbook `docs/runbooks/schema-drift-response.md` covers the post-restore validation — in short, the `SchemaDriftValidator` fires on every service boot and will report the missing `relrowsecurity = true` if the up-migration misses a table.

### Verification

```bash
# Every sensor.* table MUST have relrowsecurity = true post-restore.
psql -c "
  SELECT schemaname, tablename, rowsecurity
  FROM pg_tables
  WHERE schemaname = 'sensor'
  ORDER BY tablename;
"
# Expect: rowsecurity = t for every row.
```

---

## db-migrate runner rollback workflow (future — ORPHAN-020)

The `apps/db-migrate` runner currently does NOT expose a CLI `--down` subcommand. Every procedure in this runbook uses manual SQL OR psql-connected TypeORM CLI against the service's DataSource — not a platform-owned rollback automation.

ORPHAN-020 tracks adding:
- `apps/db-migrate run --down N` CLI subcommand driven by TypeORM DataSource.revertMigration().
- An integration test that runs `up → down → up` round-trip against a testcontainers Postgres.
- A CI workflow that invokes `db-migrate run --down` on deploy failure.

This runbook will be updated with the automated path once ORPHAN-020 lands. Until then, the procedures here are the authoritative rollback path.

---

## Acceptance

This runbook is complete when:

- [x] Every delta-plan migration has a rollback section with pre-condition, SQL, restore, and verification.
- [x] The highest-risk rollback (RLS disable) has the strictest pre-condition (zero app.current_tenant sessions).
- [x] The relationship between this runbook and ORPHAN-020 is pinned so the automation path is tracked.
- [ ] Every section is exercised in a staging rollback drill (operational scope — separate PR, runs against staging).

The first three are satisfied by this commit landing. The fourth is an operational rehearsal whose schedule is owned by the SRE team, not this runbook.
