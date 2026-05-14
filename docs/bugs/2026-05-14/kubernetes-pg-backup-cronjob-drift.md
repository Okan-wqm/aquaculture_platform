# 2026-05-14 - Kubernetes PG Backup CronJob Drift

## Affected Area
- `infrastructure/kubernetes/base/jobs/pg-backup-cronjob.yaml`
- `tools/scripts/database/backup-databases.sh`

## Observed Issue
The active production backup path is the GitHub Actions droplet workflow
(`.github/workflows/backup-production.yml`). The Kubernetes CronJob is marked
shelf-ready for the future managed Postgres/RDS path, but it invokes the same
`backup-databases.sh` script even though that script currently depends on
`docker exec` against the droplet-local `aqua-postgres` container.

## Why It Is Tracked Separately
This patch intentionally repairs and hardens the active droplet workflow only.
Changing the Kubernetes CronJob requires a separate design for non-docker
`pg_dump` connectivity, credential sourcing, and restore evidence in the EKS
path. Folding that into the missing-secret repair would mix inactive migration
work with the live backup incident.

## Required Follow-Up
- Split or parameterize the backup script so the K8s path can dump through a
  host/port connection instead of `docker exec`.
- Wire the CronJob credential contract to the future managed Postgres secret
  source and object-store identity.
- Add a K8s restore drill proving an object produced by the CronJob can be
  downloaded, SHA-verified, and restored.

## Status
Open. Split from the 2026-05-14 production backup secret repair.
