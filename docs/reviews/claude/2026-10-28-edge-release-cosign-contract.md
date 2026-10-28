# Edge release signing broke when the cosign installer moved to cosign v3

**Owner agent:** claude · **Cycle:** 2026-10-28-edge-release-cosign-contract · **Branch:**
`fix/edge-release-cosign-v2-pin`

Tag `agent-v2.0.0-rc.7` (`7a6320973`) passed the release ref contract, the Sens enterprise validation
and all three `Build` jobs (the cross fix of PROC-HIGH-067 works), then failed in `Create GitHub
Release`, step `Sign release artifacts with cosign`. Nothing was published.

## Findings

### PROC-HIGH-069 — cosign v3 ignores the legacy signature outputs the release writes

- **Where:**
  - `.github/workflows/edge-agent-release.yml:352` — the cosign installer step. Before this change
    it passed no `cosign-release`, so the installer default applied. Dependency bump #284
    (2026-06-10, `8355066ac`) moved the installer from 3.7.0 to 4.1.2, whose default is cosign
    v3.0.6.
  - `.github/workflows/edge-agent-release.yml:374-377` and `:473-476` — `cosign sign-blob` with
    `--output-certificate` and `--output-signature`. cosign v3 writes a Sigstore bundle by default and
    ignores both flags, then fails with `create bundle file: open : no such file or directory`.
  - `tools/gates/sens-enterprise-validation.ts:719-720` and `docs/runbooks/edge-gateway-ota.md:39-40`
    — the release gate and the operator runbook consume the `.sig` and `.pem` files, so they are the
    contract.
- **Effect:** run 40685042259 failed in the signing step after the three archives were built. No
  pull-request job signs anything, so the break was latent from the bump to the first tag that reached
  the signing step.
- **Rule:** a tool a release depends on is pinned to the line whose output contract the release
  consumes, and an update of the action that installs it does not move the tool's major version
  unnoticed.

### PROC-MEDIUM-068 — the edge release signs in a format the other workflows have left

- **Where:** `.github/workflows/backup-production.yml:500` and three more workflows sign with
  `--bundle`. The edge release (`:374-377`), the Sens release gate (`:719-720`) and the runbooks
  (`edge-gateway-ota.md:39-40`, `edge-gateway-rc4-operator.md:29-30`) use the legacy files.
- **Effect:** the release is held on the cosign v2 line, which stops receiving updates of the signing
  tool.
- **Rule:** one signing format across the repository's releases, and a deprecated one has an owner and
  a date.
- **Not done here:** moving the edge release to the bundle format changes the signature contract the
  field devices and operators verify against, so it needs the operator's decision and a release that
  exercises it. The close condition lists every place that changes together.

## What changed

- `.github/workflows/edge-agent-release.yml`: the installer step pins `cosign-release: v2.6.5`, the
  last v2 line, which writes the `.sig` and `.pem` files. The installer action (v4.1.2) accepts it.
- `tests/invariants/edge-release-cosign-contract.spec.ts`: while the workflow signs with the legacy
  outputs, the spec fails unless the installer step pins a v2 release. The checks are tested on fixture
  strings, and both a removed pin and a v3 pin fail it.
- Version `2.0.0-rc.8` in `sens-api-gateway/Cargo.toml`, both lockfiles and the pin in
  `sens-api-gateway-ci.yml`: the tag must equal the Cargo version and a pushed tag is never moved, so
  the fix ships as a new tag.

Closes: docs/reviews/claude/2026-10-28-edge-release-cosign-contract.md#PROC-HIGH-069
