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

| Secret                     | Meaning                                                                | Runtime mapping                  | Safe example format                            |
| -------------------------- | ---------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------- |
| `DROPLET_HOST`             | Production droplet host name or IP address                             | `appleboy/ssh-action` `host`     | `203.0.113.10` or `prod.example.com`           |
| `DROPLET_USER`             | SSH user on the production droplet                                     | `appleboy/ssh-action` `username` | `deploy`                                       |
| `DROPLET_SSH_KEY`          | Private key matching the droplet user's authorized key                 | `appleboy/ssh-action` `key`      | `-----BEGIN OPENSSH PRIVATE KEY----- ...`      |
| `SPACES_BUCKET`            | DigitalOcean Spaces bucket for backup artifacts                        | remote `SPACES_BUCKET`           | `aqua-pg-backups`                              |
| `SPACES_ENDPOINT`          | Spaces S3-compatible regional endpoint                                 | remote `SPACES_ENDPOINT`         | `https://fra1.digitaloceanspaces.com`          |
| `SPACES_ACCESS_KEY_ID`     | Spaces access key id with write access to the backup prefix            | remote `AWS_ACCESS_KEY_ID`       | `DO00EXAMPLEKEYID`                             |
| `SPACES_SECRET_ACCESS_KEY` | Spaces secret access key                                               | remote `AWS_SECRET_ACCESS_KEY`   | `<DigitalOcean Spaces secret access key>`      |
| `BACKUP_POSTGRES_USER`     | PostgreSQL role used by `pg_dump`                                      | remote `POSTGRES_USER`           | `aquaculture`                                  |
| `BACKUP_POSTGRES_DB`       | PostgreSQL database to dump                                            | remote `POSTGRES_DB`             | `aquaculture`                                  |
| `BACKUP_POSTGRES_PASSWORD` | Password passed to `pg_dump` through `PGPASSWORD` inside `docker exec` | remote `PGPASSWORD`              | `<same value as production POSTGRES_PASSWORD>` |

The source of truth for this contract is
`.github/manifests/backup-secrets.json`; the workflow preflight, SSH runtime
mapping, and this runbook must stay in lockstep with that manifest.

To close a missing-secret incident, a dry-run is not enough. After the
environment secrets are present, run `Backup - Production Postgres` from
`main` with `dry_run: false`, verify the new object under
`pg-backups/YYYY/MM/DD/`, run `head-object` for its byte count and
`Metadata.sha256`, verify its `.verification.json` sidecar binding, restore
that exact object into the isolated Postgres drill container below, then
record the workflow URL, object key, bytes, SHA-256, operator, timestamp,
restore duration, and verification SHA-256 in the drill log.

**Purpose:** verify that the nightly backups produced by
`tools/scripts/database/backup-databases.sh` can actually be restored, end to
end, on a clean Postgres instance. A backup whose restore path has never been
exercised is not a backup — it's optimism. Closes
`docs/reviews/infra-expert/2026-04-14-infrastructure-hardening.md#INFRA-BACKUP-002`.

**Cadence:**

- Once per calendar quarter.
- After any change that touches `tools/scripts/database/backup-databases.sh`,
  `tools/scripts/database/restore-databases.sh`,
  `tools/scripts/database/database-verification.sql`, the `pg_dump`/`pg_restore`
  flags in `apps/admin-api-service/src/database-management/services/backup-restore.service.ts`,
  or the schema ownership model.
- Before any planned PostgreSQL major-version upgrade.

**Owner:** infra on-call. Runs during a business-hours window; nothing touches
production state.

---

## 1. Prerequisites

On the machine running the drill (a local workstation or a spare droplet —
NOT the production droplet):

| Tool    | Minimum version | Install                                                    |
| ------- | --------------- | ---------------------------------------------------------- |
| Docker  | 24.0            | [docs.docker.com](https://docs.docker.com/engine/install/) |
| AWS CLI | v2              | `snap install aws-cli --classic` or distribution package   |
| `gpg`   | 2.2             | only required if backups are GPG-encrypted                 |

Export the Spaces credentials used by the nightly workflow (or a read-only
subset from `production-backup`):

```bash
export AWS_ACCESS_KEY_ID=…
export AWS_SECRET_ACCESS_KEY=…
export SPACES_BUCKET=aqua-pg-backups
export SPACES_ENDPOINT=https://fra1.digitaloceanspaces.com
```

## 2. Identify the backup to restore

Pick the most recent dump object by convention; ignore keys ending in
`.verification.json`. For a post-incident drill, pick the dump immediately
preceding the incident window.

```bash
aws s3 ls "s3://${SPACES_BUCKET}/pg-backups/$(date -u +%Y/%m/%d)/" \
  --endpoint-url "${SPACES_ENDPOINT}" \
  --recursive
```

Copy the full object key — example:

```
pg-backups/2026/04/14/aquaculture-20260414T030000Z.dump
```

Record the dump's SHA-256, byte length, and verification-sidecar binding.
`restore-databases.sh` refuses objects that lack these fields or whose
reciprocal sidecar metadata disagrees:

```bash
aws s3api head-object \
  --bucket "${SPACES_BUCKET}" \
  --key    "pg-backups/2026/04/14/aquaculture-20260414T030000Z.dump" \
  --endpoint-url "${SPACES_ENDPOINT}" \
  --query '{bytes:ContentLength,sha256:Metadata.sha256,verificationKey:Metadata.verification_key,verificationSha256:Metadata.verification_sha256}'
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
  --label com.aqua-saas.restore.role=isolated-drill \
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
export PGPASSWORD=drillpass
export BACKUP_KEY="pg-backups/2026/04/14/aquaculture-20260414T030000Z.dump"
export MAX_RESTORE_SECONDS=3600
# BACKUP_GPG_KEY=… only if the object key ends in .gpg

set -o pipefail
time bash tools/scripts/database/restore-databases.sh 2>&1 | tee drill-$(date -u +%Y%m%dT%H%M%SZ).log
```

Expected terminal output ends with a `RESTORE_VERIFIED` record followed by
`Done`. The command requires the exact isolated-drill container label, prepares
and finalizes TimescaleDB restore mode around `pg_restore`, and exits non-zero
if verification or the 60-minute RTO fails. `MAX_RESTORE_SECONDS` may tighten
the limit but cannot exceed 3,600 seconds.

## 5. Machine-enforced acceptance

The backup command and `pg_dump` share one exported PostgreSQL snapshot. The
backup uploads the collector's deterministic JSON as
`<dump-key>.verification.json`; the restore command runs the same collector
against the isolated database and requires byte-for-byte parity. No manual row
count can replace this gate.

Acceptance proves all of the following in one repeatable-read view:

- all 17 schemas from `bootstrapCreatedSchemas()` exist;
- every schema beginning with `tenant_` matches the canonical 16-hex tenant
  schema grammar; the physical set exactly matches non-deleted
  `admin.tenant_schemas` ledger rows, and every ledger mapping agrees with the
  tenant UUID-derived canonical schema name;
- all 14 source migration ledgers match the latest DB-complete release ledger;
- all seven tenant migration ledgers match their recorded tenant head, or the
  source head for tenants onboarded after that release;
- the global and per-tenant sentinel relation counts and order-independent row
  checksums exactly match the backup snapshot; zero rows are valid only when
  both sides prove the same zero-row checksum;
- the full download, restore, and verification completes within 3,600 seconds.

On any failure, preserve the command log and drill container and escalate to
`#aqua-incidents`. Do not label the object restorable.

## 6. Tear down

```bash
docker rm -f aqua-postgres-drill
docker network rm drill-net
```

## 7. Log the result

Append a row to the drill log (`docs/runbooks/_logs/database-restore-drills.md`
— create if it does not exist) with the following fields. This row is the
evidence we passed the drill.

| Date (UTC) | Operator | Workflow URL | Dump key | Dump bytes | Dump sha256 | Verification sha256 | Restore wall-clock | RTO ≤ 60m? | `RESTORE_VERIFIED` log line | Notes |
| ---------- | -------- | ------------ | -------- | ---------- | ----------- | ------------------- | ------------------ | ---------- | --------------------------- | ----- |

Commit the updated log in the same PR that fixes any issue the drill
surfaced; if the drill was clean, commit the log entry on its own.

## 8. Failure modes and next steps

| Symptom                                                | Likely cause                                                               | Next step                                                                                                                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pg_restore: error: could not read from input file`    | dump truncated during upload                                               | re-run `backup-databases.sh`; compare `head-object` bytes and `Metadata.sha256` against the workflow log                                                    |
| `pg_restore: error: role "xxx_service" does not exist` | dump was produced WITHOUT `--no-owner`                                     | patch `backup-databases.sh`; re-run                                                                                                                         |
| backup object is missing verification binding metadata | object predates the snapshot-bound proof contract or upload was incomplete | run a new non-dry backup; do not certify the legacy object                                                                                                  |
| restored database failed structural verification       | schema, tenant, sentinel relation, or migration head is missing/drifted    | preserve the drill container and inspect the prefixed `verification` error                                                                                  |
| count/checksum evidence differs                        | restored rows do not match the exact snapshot used by `pg_dump`            | preserve both object keys and the drill container; open an incident                                                                                         |
| verified restore exceeded RTO                          | end-to-end restore took more than 3,600 seconds                            | capture timings and storage/CPU/IO telemetry; production remains locked                                                                                     |
| `aws: error: An error occurred (403)`                  | Spaces key lost its ListObject/GetObject permission                        | rotate the Spaces key, update `production-backup` environment secrets                                                                                       |
| GPG decryption fails                                   | decryption-capable private key is absent from the isolated drill keyring   | load the private key only onto the isolated drill host under the approved key-handling procedure; remove it after the drill and never copy it to production |
