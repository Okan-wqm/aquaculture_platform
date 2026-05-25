# Sens API Gateway Edge v2.0.0-rc4 Evidence Map

## Historical RC Only

This evidence map records the RC4 release attempt and is not production release evidence for tenant downloads. New production evidence must include a signed `edge-release-manifest.json`, exact `agent-v<exact Cargo semver>` tag/Cargo parity, and the release gate artifacts described in `docs/architecture/edge-release-provisioning-ota.md`.

Date: 2026-05-22
Branch: `release/sens-edge-rc4-release-workflow`
Base: `origin/main`

## Decision

Release correction: `agent-v2.0.0-rc2` was pushed, but its workflow failed in `Release ref contract` before enterprise validation, build artifacts, signatures, or GitHub Release creation. `agent-v2.0.0-rc3` then passed the release ref and enterprise validation gates, but the release build failed before artifact packaging because the workflow assumed the wrong Cargo target directory. Neither tag is reused; `agent-v2.0.0-rc4` is the immutable release tag for this corrected release path.

ADR-025 is authoritative for Edge schema ownership. ADR-022 is superseded.
Therefore this PR is release-contract and documentation only; it does not adopt the admin-api-owned Edge schema files found as untracked local work.

## Included Files

This PR stages only the release-contract surface:

- `.github/workflows/edge-agent-release.yml`
- `.github/workflows/sens-api-gateway-ci.yml`
- `.github/workflows/ci-edge.yml`
- `sens-api-gateway/Cargo.toml` and `sens-api-gateway/Cargo.lock`
- RC4 release notes, evidence, and runbooks under `docs/releases/`, `docs/evidence/`, and `docs/runbooks/`
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

## Enterprise Release Profile Evidence

Selected profile: `edge-agent-scada-display`.
Feature tier: `scada-display`.
Gate command: `npm run gates:sens-enterprise-validation -- --release --release-profile=edge-agent-scada-display`.

Blocking claims for this profile:

- `sens-ci-bypass-closed`
- `edge-release-enterprise-gated`
- `cargo-supply-chain-hard-gates`
- `suppression-patterns-rejected`
- `command-permission-burn-down`

Classified as non-blocking and not claimed by this artifact profile:

- `coapproval-rbac-enterprise-closure`
- `runtime-io-safe-state-closure`
- `cloud-edge-command-lifecycle-closure`
- `opcua-s7-physical-write-closure`
- `sx1302-vendor-hal-hil-closure`

## GitHub Actions Evidence

Historical RC4 runs were not promoted to production. Do not use this table as tenant-facing release approval.

| Gate | Run | Status |
|---|---|---|
| SENS API Gateway CI | Historical RC4 attempt | Not production-approved |
| CI - Edge Agent | Historical RC4 attempt | Not production-approved |
| Edge Agent Release | Historical RC4 attempt | Not production-approved |

## Release Artifact Contract
Release feature tier: `scada-display`. Broader GPIO/I2C/SPI/PWM and debug/security preview surfaces are CI/HIL-owned until a dedicated hardware release contract is introduced.

- Archive: `suderra-agent-v2.0.0-rc4-<target>.tar.gz`
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
