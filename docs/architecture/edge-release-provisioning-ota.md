# Edge Release, Provisioning, and Signed OTA Architecture

Date: 2026-05-24 (release contract updated 2026-10-20 for ADR-048 P0)
Status: active architecture baseline

## Decision

Production edge devices must not select firmware from live GitHub release ordering, branch artifacts, or a `latest` alias. The only production-consumable release identity is `agent-v<exact Cargo semver>`, where the tag suffix equals `sens-api-gateway/Cargo.toml` package version exactly.

The tenant panel may generate installer links, but those links must resolve to an explicit release chosen by the control plane. Firmware rollout uses a signed release manifest and the `apply_signed_manifest` command path. The legacy `update_firmware` GitHub tarball command remains disabled by default and is only available when a non-production operator explicitly enables the compatibility gate.

## Components

- `EdgeReleaseRegistryService`: stores approved release manifests, artifact digests, SBOM pointers, provenance, cosign certificate identity, rollout channel, and promotion state.
- `EdgeRolloutService`: selects tenant/site/device cohorts, enforces rollout windows, tracks command lifecycle, and dispatches signed manifest apply commands.
- `ProvisioningCredentialService`: mints short-lived install credentials, hashes activation secrets at rest, rate-limits redemption, and binds an installer response to tenant, device code, release tag, and expiry.
- `InstallerScriptService`: renders only explicit-version installers. It rejects empty or `latest` agent versions before emitting shell.
- Edge Agent `apply_signed_manifest`: verifies signed manifests, requires A/B partition mounts before apply, streams files to standby, sets the next boot slot, and reports terminal status.

## Release Contract

The release workflow (`.github/workflows/edge-agent-release.yml`) owns the build and evidence contract (ADR-048 DEC-3, DEC-8.5, DEC-20, DEC-28):

1. It runs only from a pushed tag matching `agent-v<exact Cargo semver>`.
2. It verifies the tag commit is reachable from `origin/main`.
3. It verifies the tag suffix equals the Cargo package version exactly, including prerelease punctuation such as `2.0.0-rc.4`.
4. It takes every build row from `scripts/edge/edge_release.py plan`, which derives them from `contracts/suderra-edge/v1` (boards.json, artifact-naming.json) and `sens-api-gateway/release/edge-release.toml`. Before it builds, it runs the gateway CI (`sens-api-gateway-ci.yml`) and the profile CI (`ci-edge.yml`: every planned feature set linted and tested, every row cross-built) on the tag's commit. Release builds use no cache and `--locked`.
5. Suderra OS channel: one `suderra-agent-os-<version>-<board_profile>-<arch>.tar.gz` per buildable boards.json board, holding exactly `suderra-agent`, with `<artifact>.release.dsse.json` beside it. That file is an Ed25519 DSSE `suderra.edge-release.v1` statement over the archive and binary digests, the provenance digest, `security_version`, `min_os_version`, `agent_abi` and the board's required kernel config. The separate job `sign-release-statement`, in the environment `edge-release`, signs it with the edge-release key. Suderra OS installs an agent only through a signed provisioning manifest that names the statement, and devices trust only the statement. A board the release facts mark unbuildable gets no artifact, and the release body names it and why. Known defect EDGE-HIGH-128: the statement's `cargo_features` omit the `health` feature every build adds.
6. Generic-Linux channel (frozen, DEC-28): `suderra-agent-<version>-<slug>.tar.gz` for `x86_64-linux`, `aarch64-linux` and `armv7-linux`, holding `edge-agent`, built with the `health,scada-display` tier. The cloud's installer and update scripts fetch it.
7. Every binary passes the ELF check (machine, program interpreter, NEEDED libraries, glibc symbol-version ceiling per channel), and every archive is deterministic: one root-owned 0755 member at the commit time.
8. The signing job states the in-toto provenance of every artifact from the downloaded bytes. The publish job verifies every statement before anything is published, with verify_strict semantics and a payload that must be byte for byte the statement of those bytes.
9. It publishes archive, checksum, cargo metadata SBOM, in-toto provenance, notice, release statement, cosign signature and cosign certificate. Cosign keyless signatures are provenance evidence for the cloud's release admission only (DEC-3.8).
10. It publishes and signs `edge-release-manifest.json` as the machine-readable manifest consumed by the registry.

## Provisioning Flow

1. Tenant admin creates or selects an edge device in the tenant panel.
2. Control plane selects an approved release from `EdgeReleaseRegistryService`.
3. `ProvisioningCredentialService` creates a short-lived credential and stores only a hash.
4. Tenant panel shows a download command bound to tenant, device code, credential, and explicit release tag.
5. Installer downloads `suderra-agent-<version>-<target>.tar.gz` (generic-Linux channel) from the release tag selected by the control plane. A Suderra OS device instead receives a signed provisioning manifest that names the `suderra-agent-os-…` artifact and its release statement (ADR-048).
6. Installer verifies the checksum and writes config with `firmware_update.mode: disabled` unless a signed OTA rollout has been explicitly provisioned.
7. Agent activates with tenant-scoped credentials and connects to the tenant panel through the normal MQTT/API lifecycle.

## Signed OTA Flow

1. Operator promotes a signed manifest in `EdgeReleaseRegistryService`.
2. `EdgeRolloutService` creates durable rollout commands for the target cohort.
3. Command payload uses `apply_signed_manifest`; it never uses `update_firmware` or `latest`.
4. Edge Agent verifies manifest signature, tenant binding, monotonic version, validity window, file digests, and target architecture.
5. Edge Agent requires configured A/B partition mounts before apply. Missing mounts reject with `gate=ab_partitions_required`.
6. Edge Agent streams files to standby, sets next boot, reports applied or rejected, and rollback remains tied to boot confirmation.

## Production Deny List

These patterns are not production-consumable:

- `latest` or implicit newest release resolution.
- GitHub Releases API ordering as a rollout source of truth.
- Tenant installer scripts that fetch `agent-v*` with `grep` and `head`.
- Cloud commands that send `update_firmware` with `github_repo`.
- `apply_signed_manifest` state-only apply without A/B mount paths.
- RC artifacts whose evidence file still has pending/TBD links.

## RC4 Status

`agent-v2.0.0-rc4` is Historical RC Only. It documents the earlier release-contract hardening attempt and must not be presented to tenants as an approved production edge download. A new release can be issued only after the release workflow, signed manifest, provisioning default, OTA deny-by-default behavior, and enterprise gate are green on `main`.

## Operational Requirements

- Promotion evidence must include GitHub Actions run URL, release URL, `edge-release-manifest.json` digest, cosign certificate identity, and all artifact digests.
- Tenant-facing download links must expire and must be redeemable once unless explicitly renewed.
- Secrets shown to a device during activation must not be persisted in plaintext after redemption.
- Rollout state must be durable and auditable before a signed OTA can be enabled for production tenants.

## Affected Files

- `.github/workflows/edge-agent-release.yml`
- `.github/workflows/ci-edge.yml`
- `.github/workflows/sens-api-gateway-ci.yml`
- `scripts/edge/edge_release.py`
- `sens-api-gateway/release/edge-release.toml`
- `contracts/suderra-edge/v1/` (boards.json, artifact-naming.json, statements.json, schemas/edge-release.schema.json)
- `tests/invariants/edge-release-pipeline.spec.ts`
- `tools/gates/sens-enterprise-validation.ts`
- `tools/gates/sens-enterprise-claims.json`
- `apps/sensor-service/src/edge-device/installer-script.service.ts`
- `apps/sensor-service/src/edge-device/edge-device.service.ts`
- `apps/sensor-service/src/edge-device/edge-device.resolver.ts`
- `sens-api-gateway/src/commands/apply_signed_manifest.rs`
- `docs/releases/sens-api-gateway-edge-v2.0.0-rc4.md`
- `docs/runbooks/edge-gateway-rc4-operator.md`
- `docs/runbooks/edge-gateway-ota.md`
