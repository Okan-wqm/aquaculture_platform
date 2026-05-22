# Sens API Gateway Edge v2.0.0-rc2 Evidence Map

Date: 2026-05-22
Branch: `release/sens-edge-rc2-contract-2026-05-22`
Base: `origin/main`

## Decision

ADR-025 is authoritative for Edge schema ownership. ADR-022 is superseded.
Therefore this PR is release-contract and documentation only; it does not adopt the admin-api-owned Edge schema files found as untracked local work.

## Included Files

This PR stages only the release-contract surface:

- `.github/workflows/edge-agent-release.yml`
- `.github/workflows/sens-api-gateway-ci.yml`
- `.github/workflows/ci-edge.yml`
- `sens-api-gateway/Cargo.toml` and `sens-api-gateway/Cargo.lock`
- RC2 release notes, evidence, and runbooks under `docs/releases/`, `docs/evidence/`, and `docs/runbooks/`
- Small cross-links in existing `sens-api-gateway` docs

## Explicit Exclusions

- Excluded: `apps/admin-api-service/src/edge/**`
- Excluded: `apps/admin-api-service/src/migrations/edge/**`
- Excluded: `tests/invariants/edge-v2-plan-contract.spec.ts`
- Excluded: `docs/plans/2026-05-12-sens-api-gateway-edge-platform-v2-revision.md`
- Excluded: admin tenant provisioning workflow files and modified tenant/admin-panel files
- Excluded: `aria-tools/**`, `artifacts/**`, and generated discovery/audit output

## Why These Exclusions Matter

The excluded admin-api Edge schema files follow the superseded ADR-022 placement model.
Including them in this release PR would mix release mechanics with a platform data-ownership decision and could create migration/runtime drift.

## GitHub Actions Evidence

Fill these links after the PR is opened and CI has run.

| Gate | Run | Status |
|---|---|---|
| SENS API Gateway CI | TBD | Pending |
| CI - Edge Agent | TBD | Pending |
| Edge Agent Release | Runs only after `agent-v2.0.0-rc2` tag | Pending |

## Release Artifact Contract

- Archive: `suderra-agent-v2.0.0-rc2-<target>.tar.gz`
- Checksum: `.tar.gz.sha256`
- SBOM: `.cargo-metadata.sbom.json`
- Provenance: `.intoto.jsonl`
- Notices: `.NOTICE.md`
- Signature material: `.sig` and `.pem` for each signed release material

## Follow-up PR B

The implementation PR must align to ADR-025 and cover sensor-service/per-tenant ownership, signed command ingress, RBAC dispatcher enforcement, replay protection, PLC write safety, provisioning bundle fields, OTA verification, and systemd hardening evidence.

## Rollback

- PR A rollback: revert the release workflow/docs commit before tagging.
- Release rollback: delete the failed RC GitHub Release and tag only if no device consumed it.
- Runtime rollback: use the operator runbook and prior signed artifact; do not use an unsigned local binary.
