# Edge release signing uses cosign flags that cosign 3 ignores

**Owner agent:** claude · **Cycle:** 2026-10-28-edge-release-cosign-bundle · **Branch:**
`claude/edge-release-cosign-bundle`

Tag `agent-v2.0.0-rc.7` (`7a6320973`, run 40685042259) built all three targets, then failed
`Create GitHub Release` in `Sign release artifacts with cosign`: `create bundle file: open :
no such file or directory`. No release was created.

## Findings

### PROC-HIGH-068 — the release signs with flags the installed cosign ignores

- **Where:**
  - `.github/workflows/edge-agent-release.yml:365` — `cosign sign-blob --output-certificate
    ... --output-signature ...`. `sigstore/cosign-installer` v4.1.2 installs cosign 3.0.6 by
    default; cosign 3 writes a single Sigstore bundle, prints `--output-signature is deprecated
    when using --new-bundle-format and will be ignored`, and exits 1 without `--bundle`.
  - `.github/workflows/edge-agent-release.yml:411` — the release manifest requires the `.sig` and
    `.pem` of every signed artifact; cosign 3 never writes them.
  - `.github/workflows/edge-agent-release.yml:529` — the release uploads `artifacts/*.sig` and
    `artifacts/*.pem`.
  - `.github/workflows/backup-ssh-broker-release.yml:737` — the repository's other signing
    workflows already use `cosign sign-blob --bundle <file>.sigstore.json` with the same installer.
- **Effect:** the last successful edge release (`agent-v2.0.0-rc4`, 2026-05-24) signed with
  cosign 2; the installer bump of 2026-10-21 changed the default major. rc.5 and rc.6 stopped
  earlier (release gate, cross build), so rc.7 was the first tag to reach the signing step. No
  pull-request job signs anything, so the break showed only on a tag.
- **Rule:** the signing flags of a release workflow match the cosign major its installer provides,
  every signed artifact is published with its bundle, and a pull-request check fails when a legacy
  flag returns.

## Fix

- **Make it correct by construction:** every `cosign sign-blob` writes
  `<artifact>.sigstore.json` (artifacts and the release manifest). The release manifest becomes
  `schema_version` 2 and lists one `bundle` per signed artifact in place of `signature` and
  `certificate`. The release notes and `docs/runbooks/edge-gateway-ota.md` verify with
  `cosign verify-blob --bundle`. The release uploads `artifacts/*.sigstore.json`.
- **Make it detectable:** `tests/invariants/edge-release-cosign-bundle.spec.ts` fails when a
  `cosign sign-blob` of the release workflow lacks `--bundle` or uses the legacy flags, when the
  manifest stops requiring the bundle of a signed artifact, or when the bundles are not uploaded.
  Three of its nine tests fail on the previous workflow.
- **Dry run:** the real signing loop, manifest generator and upload globs run against a cosign 3
  stand-in that requires `--bundle`: 29 files, all matched by the upload globs. The keyless signing
  itself needs the GitHub OIDC token and runs only on a tag.
- **Release path:** the version moves to `2.0.0-rc.8`; the release workflow builds the commit a tag
  points at, and the earlier tags stay where they are.

## Not changed

`docs/runbooks/edge-gateway-rc4-operator.md` and the RC4 evidence documents keep the `.sig`/`.pem`
commands: they describe a release withdrawn from public access and are retained as history.
