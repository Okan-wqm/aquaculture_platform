# Capacity Preflight Budget Finding

Scope: `.github/workflows/deploy-digitalocean.yml`, `scripts/deploy/droplet-capacity.sh`,
`tests/invariants/deploy-ssot-contract.spec.ts`, `docs/runbooks/deploy-capacity-and-image-gc.md`

## INFRA-HIGH-023

`Deploy to DigitalOcean` run `27904364949` reached `capacity-preflight` after all image builds
and manifest verification succeeded, then failed by GitHub Actions job timeout after `10m14s`.
The log showed capacity thresholds had already emitted warning-level free-space evidence, not hard
capacity errors: `/`, `/var/lib/docker`, and `/var/lib/containerd` had about `51.94GB` free against
the `50GiB` warning threshold. The mutating `deploy` job remained skipped.

Root cause: capacity gate control flow bundled expensive top-level `du` diagnostics with the fast
filesystem/inode/projected-pull threshold snapshot. The first `/` diagnostic scan took about
`5m50s`; after warning-triggered safe image GC, the second diagnostic scan was killed by the
workflow's `10m` job timeout before the final verdict could print.

Architectural requirement: diagnostic evidence must be bounded and subordinate to the capacity
decision. The capacity gate must emit fast threshold evidence first, run safe image GC if needed,
then collect bounded diagnostic evidence at most once for the final verdict. Workflow job timeout,
SSH command timeout, and diagnostic timeout must be pinned as one deploy-control-plane contract.
