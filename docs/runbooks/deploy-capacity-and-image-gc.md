# Deploy Capacity and Image GC Runbook

Production deploys are owned by GitHub Actions. The droplet must not build
images locally or deploy mutable `latest` tags.

## When Capacity Preflight Fails

1. Treat the failed run as zero-state-change if it failed before image pull,
   migration, or restart. The release ledger records
   `rollback_skipped_reason=no_state_changed`.
2. Inspect the Actions capacity summary and the droplet output from:
   `scripts/deploy/droplet-capacity.sh report`.
3. Run image-only cleanup only:
   `scripts/deploy/droplet-capacity.sh gc`.
4. Re-run the same GitHub Actions deploy SHA after capacity is above the hard
   reserve.

## Forbidden Cleanup

Do not run these as part of deploy recovery:

- `docker volume prune`
- `docker system prune --volumes`
- direct deletion under `/var/lib/docker/volumes`
- direct deletion under NATS JetStream, MinIO, Postgres, Redis, or Mosquitto
  data volumes

Data-bearing cleanup requires a backup/export and a maintenance-window recovery
procedure.

## Capacity Gates

Full deploy blocks below 35 GiB free, below 20 percent free, below 5 percent
free inodes, or below the projected 20 GiB post-pull reserve.

Selective deploy blocks below 15 GiB free, below 10 percent free, below 5
percent free inodes, or below the projected 10 GiB post-pull reserve.
