# Deploy Capacity and Image GC Runbook

Production deploys are owned by GitHub Actions. The droplet must not build
images locally or deploy mutable `latest` tags.

## When Capacity Preflight Fails

1. Treat the failed run as zero-state-change if it failed before image pull,
   migration, or restart. The release ledger records
   `rollback_skipped_reason=no_state_changed`.
2. Inspect the failed `deploy / capacity-preflight` GitHub Actions job log.
   The canonical report includes filesystem thresholds, Docker system summary,
   bounded same-filesystem top-level usage, and image inventory. The deploy
   gate uses `CAPACITY_DISK_USAGE_MODE=summary` by default so diagnostics do
   not scan nested runtime paths before the capacity thresholds execute. The
   gate prints the fast threshold snapshot before running expensive
   diagnostics, then runs bounded `du` evidence at most once for the final
   verdict. Use that evidence before deciding whether the fix is image GC,
   non-data log maintenance, or droplet capacity growth.
3. If a separate report or cleanup pass is needed, run the
   `Deploy Capacity Maintenance` workflow from GitHub Actions. Use `report`
   for inspection, `safe-image-gc` for image-only cleanup, or `gate` to run the
   same capacity gate with the safe GC pass enabled.
4. Re-run the failed GitHub Actions deploy job after capacity is above the hard
   reserve.

Operators must not SSH into the droplet to run capacity scripts manually.
GitHub Actions is the deploy remediation control plane and provides the audit
trail for report, image-only GC, gate, and deploy reruns.

For deeper disk attribution through the same audited control plane, run the
maintenance workflow in report mode with `CAPACITY_DISK_USAGE_MODE=deep`. Deep
mode performs one root-filesystem traversal at depth 3, excluding Docker and
containerd (their bytes come from `docker system df`). That depth exposes
direct `/tmp` artifact directories and the `/var/aqua-saas/target` tree without
starting nested `/var`, `/var/lib`, repository, and `/tmp` traversals or listing
individual files. The complete walk has one `CAPACITY_DU_TIMEOUT_SECONDS`
budget (default and hard maximum 120 seconds); values outside 1–120 produce
explicit unavailable evidence without invoking `du`. A timed-out scan emits a
visible `disk_usage_unavailable reason=timeout` line. Diagnostic collection is
evidence only: capacity pass/fail still comes from the canonical filesystem,
inode, projected-pull, and safe-image-GC gates.

The `safe-image-gc` maintenance operation captures its pre-state with disk-usage
walking disabled, runs image-only GC, and then performs one deep post-GC gate.
This keeps the final verdict and attribution inside the 12-minute SSH command
budget while preserving pre/post Docker and filesystem threshold evidence.
The invariant reserves at least 300 seconds of that outer SSH window as
non-`du` headroom for checkout, Docker work, threshold evaluation, and teardown;
the headroom is not a second executable timeout.

If capacity-preflight fails by GitHub Actions timeout instead of an explicit
capacity threshold, do not lower hard reserves or bypass the gate. Treat it as a
deploy-control-plane defect: the workflow job timeout must exceed the SSH
command timeout, and the SSH command timeout must exceed the bounded diagnostic
budget. The invariant suite pins that relationship.

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
