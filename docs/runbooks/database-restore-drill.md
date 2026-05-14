# Database Restore Drill

## Backup Workflow Missing-Secret Repair

The production backup workflow resolves its credentials from the
`production-backup` GitHub Environment, not from generic repository secrets.
Create it before seeding credentials:

1. Go to `Settings -> Environments -> New environment`.
2. Name it `production-backup`.
3. Restrict deployment branches to `main`.
4. Do not configure required reviewers or a wait timer. The scheduled backup
   must not wait for human approval at 03:00 UTC.
5. Add the following values under
   `Settings -> Environments -> production-backup -> Environment secrets`.

| Secret | Meaning | Runtime mapping | Safe example format |
|---|---|---|---|
| `DROPLET_HOST` | Production droplet host name or IP address | `appleboy/ssh-action` `host` | `203.0.113.10` or `prod.example.com` |
| `DROPLET_USER` | SSH user on the production droplet | `appleboy/ssh-action` `username` | `deploy` |
| `DROPLET_SSH_KEY` | Private key matching the droplet user's authorized key | `appleboy/ssh-action` `key` | `-----BEGIN OPENSSH PRIVATE KEY----- ...` |
| `SPACES_BUCKET` | DigitalOcean Spaces bucket for backup artifacts | remote `SPACES_BUCKET` | `aqua-pg-backups` |
| `SPACES_ENDPOINT` | Spaces S3-compatible regional endpoint | remote `SPACES_ENDPOINT` | `https://fra1.digitaloceanspaces.com` |
| `SPACES_ACCESS_KEY_ID` | Spaces access key id with write access to the backup prefix | remote `AWS_ACCESS_KEY_ID` | `DO00EXAMPLEKEYID` |
| `SPACES_SECRET_ACCESS_KEY` | Spaces secret access key | remote `AWS_SECRET_ACCESS_KEY` | `<DigitalOcean Spaces secret access key>` |
| `BACKUP_POSTGRES_USER` | PostgreSQL role used by `pg_dump` | remote `POSTGRES_USER` | `aquaculture` |
| `BACKUP_POSTGRES_DB` | PostgreSQL database to dump | remote `POSTGRES_DB` | `aquaculture` |
| `BACKUP_POSTGRES_PASSWORD` | Password passed to `pg_dump` through `PGPASSWORD` inside `docker exec` | remote `PGPASSWORD` | `<same value as production POSTGRES_PASSWORD>` |

The source of truth for this contract is
`.github/manifests/backup-secrets.json`; the workflow preflight, SSH runtime
mapping, and this runbook must stay in lockstep with that manifest.

To close a missing-secret incident, a dry-run is not enough. After the
environment secrets are present, run `Backup - Production Postgres` from
`main` with `dry_run: false`, verify the new object under
`pg-backups/YYYY/MM/DD/`, run `head-object` for its byte count and
`Metadata.sha256`, restore that exact object into the ephemeral Postgres
drill container below, then record the workflow URL, object key, bytes,
SHA-256, operator, timestamp, restore duration, and sanity-check output in
the drill log.

**Purpose:** verify that the nightly backups produced by
`tools/scripts/database/backup-databases.sh` can actually be restored, end to
end, on a clean Postgres instance. A backup whose restore path has never been
exercised is not a backup — it's optimism. Closes
`docs/reviews/infra-expert/2026-04-14-infrastructure-hardening.md#INFRA-BACKUP-002`.

**Cadence:**
- Once per calendar quarter.
- After any change that touches `tools/scripts/database/backup-databases.sh`,
  `tools/scripts/database/restore-databases.sh`, the `pg_dump`/`pg_restore`
  flags in `apps/admin-api-service/src/database-management/services/backup-restore.service.ts`,
  or the schema ownership model.
- Before any planned PostgreSQL major-version upgrade.

**Owner:** infra on-call. Runs during a business-hours window; nothing touches
production state.

---

## 1. Prerequisites

On the machine running the drill (a local workstation or a spare droplet —
NOT the production droplet):

| Tool | Minimum version | Install |
|---|---|---|
| Docker | 24.0 | [docs.docker.com](https://docs.docker.com/engine/install/) |
| AWS CLI | v2 | `snap install aws-cli --classic` or distribution package |
| `gpg` | 2.2 | only required if backups are GPG-encrypted |

Export the Spaces credentials used by the nightly workflow (or a read-only
subset from `production-backup`):

```bash
export AWS_ACCESS_KEY_ID=…
export AWS_SECRET_ACCESS_KEY=…
export SPACES_BUCKET=aqua-pg-backups
export SPACES_ENDPOINT=https://fra1.digitaloceanspaces.com
```

## 2. Identify the backup to restore

Pick the most recent daily dump by convention; for a post-incident drill,
pick the dump immediately preceding the incident window.

```bash
aws s3 ls "s3://${SPACES_BUCKET}/pg-backups/$(date -u +%Y/%m/%d)/" \
  --endpoint-url "${SPACES_ENDPOINT}" \
  --recursive
```

Copy the full object key — example:

```
pg-backups/2026/04/14/aquaculture-20260414T030000Z.dump
```

Record the object's SHA-256 metadata (populated by `backup-databases.sh`
under the `x-amz-meta-sha256` header) and the byte length:

```bash
aws s3api head-object \
  --bucket "${SPACES_BUCKET}" \
  --key    "pg-backups/2026/04/14/aquaculture-20260414T030000Z.dump" \
  --endpoint-url "${SPACES_ENDPOINT}" \
  --query '{bytes:ContentLength,sha256:Metadata.sha256}'
```

## 3. Spin an ephemeral Postgres

Use the **same** `postgres` image and major version that runs on the
droplet. The droplet's image is pinned in `docker-compose.droplet.yml`; the
example below is derived from that file and must be updated if the compose
image changes.

```bash
docker network create drill-net 2>/dev/null || true
docker run -d \
  --name aqua-postgres-drill \
  --network drill-net \
  -e POSTGRES_USER=aquaculture \
  -e POSTGRES_PASSWORD=drillpass \
  -e POSTGRES_DB=postgres \
  timescale/timescaledb-ha:pg16@sha256:b3d038d0a0757df8a5ec0a94ba68d9ad57b0e16100a024cf4b370c77ad5645f7

# Wait for readiness (≤30s typical)
until docker exec aqua-postgres-drill pg_isready -U aquaculture; do sleep 1; done
```

## 4. Restore

```bash
export TARGET_CONTAINER=aqua-postgres-drill
export TARGET_USER=aquaculture
export TARGET_DB=aquaculture_drill
export BACKUP_KEY="pg-backups/2026/04/14/aquaculture-20260414T030000Z.dump"
# BACKUP_GPG_KEY=… only if the object key ends in .gpg

time bash tools/scripts/database/restore-databases.sh 2>&1 | tee drill-$(date -u +%Y%m%dT%H%M%SZ).log
```

Expected terminal output ends with the list of schemas (12 entries plus
`_timescaledb_*` internals) and `Done`.

## 5. Sanity checks

Run these inside the drill container. Each check MUST return a row count
greater than zero for a non-empty production database; a healthy drill pins
each count and compares it to the previous drill's numbers (checked in as a
comment on this file during history-keeping — see §7).

```bash
docker exec -i aqua-postgres-drill psql -U aquaculture -d aquaculture_drill <<'SQL'
SELECT 'auth.tenants'       AS tbl, COUNT(*) FROM auth.tenants
UNION ALL
SELECT 'auth.users',              COUNT(*) FROM auth.users
UNION ALL
SELECT 'farm.farms',              COUNT(*) FROM farm.farms
UNION ALL
SELECT 'farm.batches',            COUNT(*) FROM farm.batches
UNION ALL
SELECT 'sensor.sensors',          COUNT(*) FROM sensor.sensors
UNION ALL
SELECT 'sensor.readings',         COUNT(*) FROM sensor.readings
UNION ALL
SELECT 'alert.alert_rules',       COUNT(*) FROM alert.alert_rules
UNION ALL
SELECT 'billing.subscriptions',   COUNT(*) FROM billing.subscriptions
UNION ALL
SELECT 'hr.employees',            COUNT(*) FROM hr.employees
UNION ALL
SELECT 'messaging.channels',      COUNT(*) FROM messaging.channels
ORDER BY 1;
SQL
```

If any count is zero for a table that should contain data in production,
STOP — either the backup is broken or `pg_dump` was run before the schema
was populated. Capture the log, preserve the drill container, and escalate
to `#aqua-incidents`.

## 6. Tear down

```bash
docker rm -f aqua-postgres-drill
docker network rm drill-net
```

## 7. Log the result

Append a row to the drill log (`docs/runbooks/_logs/database-restore-drills.md`
— create if it does not exist) with the following fields. This row is the
evidence we passed the drill.

| Date (UTC) | Operator | Workflow URL | Dump key | Dump bytes | Dump sha256 | Restore wall-clock | Sanity-check output | All counts non-zero? | Deltas from previous drill | Notes |
|---|---|---|---|---|---|---|---|---|---|---|

Commit the updated log in the same PR that fixes any issue the drill
surfaced; if the drill was clean, commit the log entry on its own.

## 8. Failure modes and next steps

| Symptom | Likely cause | Next step |
|---|---|---|
| `pg_restore: error: could not read from input file` | dump truncated during upload | re-run `backup-databases.sh`; compare `head-object` bytes and `Metadata.sha256` against the workflow log |
| `pg_restore: error: role "xxx_service" does not exist` | dump was produced WITHOUT `--no-owner` | patch `backup-databases.sh`; re-run |
| All schema counts zero | `pg_dump` ran against empty DB or pointed at wrong container | confirm `POSTGRES_CONTAINER`/`POSTGRES_DB` in the workflow env |
| `aws: error: An error occurred (403)` | Spaces key lost its ListObject/GetObject permission | rotate the Spaces key, update `production-backup` environment secrets |
| GPG decryption fails | archive key not imported into local keyring | import the public key; keep the private half OFFLINE |
