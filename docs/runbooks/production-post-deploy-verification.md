# Production Post-Deploy Verification

Production deploy success is not just a green deploy job. A release is accepted
only when GitHub Actions proves the deployed Git SHA, release ledger, image
digest manifest, service health gate, readiness sweep, and gateway health smoke
for the same target SHA.

## Control Plane

Use the `Production Post-Deploy Verify` GitHub Actions workflow. Do not SSH to
the droplet manually for this verification path.

The normal path is automatic: `CI - Affected` calls this workflow after the
`deploy` job succeeds on `main`, passing the exact `${{ github.sha }}` that was
deployed. Manual `workflow_dispatch` is only for operator re-verification.

Inputs:

- `target_sha`: optional for manual dispatch. Leave blank to verify `origin/main`.

The workflow first checks that `deployed/production` points at the target SHA,
then connects to the production droplet and runs
`scripts/deploy/post-deploy-verify.sh` from the checked-out release source.

## Acceptance

The workflow must upload `production-post-deploy-evidence-<sha>` and the JSON
evidence must show:

- `status: ok`
- `target_sha` equals `droplet_head`
- `release_status: promoted`
- `release_ledger_heads_match: true`
- `image_digest_manifest_sha256` equals the SHA-256 of the release
  `image-digests.tsv`
- `criticality_health_gate: passed`
- gateway `/health/live` and `/health/ready` passed

If any check fails, treat the production release as not fully accepted even if
the deploy job itself was green.

## Related Follow-Ups

- Run `Backup - Production Postgres` after the production-backup environment
  secrets are complete.
- Run `ARIA Operational Proof` after production post-deploy verification and
  backup recovery are green.
- Use `Deploy Capacity Maintenance` for scheduled report, safe image-only GC,
  or deploy-equivalent capacity gate operations.
