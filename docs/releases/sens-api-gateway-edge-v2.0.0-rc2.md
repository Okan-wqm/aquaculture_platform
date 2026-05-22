# Sens API Gateway Edge v2.0.0-rc2 Release Notes

Date: 2026-05-22
Target tag: `agent-v2.0.0-rc2`
Cargo package version: `2.0.0-rc.2`

## Scope

This RC is an Edge Agent release-contract hardening release for `sens-api-gateway`.
It intentionally does not ship the broader Edge Platform v2 schema/runtime migration.

Included in this PR:

- Tag-only GitHub release workflow for `agent-v*` tags.
- RC2 Cargo release tier: `scada-display`.
- Versioned Linux artifacts for x86_64, aarch64, and armv7.
- Release evidence artifacts: checksum, cargo metadata SBOM, in-toto provenance, notice file, cosign signature and certificate.
- Operator runbooks for RC2 install, OPC UA posture, and OTA posture.

Not included in this PR:

- ADR-022-style admin-api-owned `edge` schema files.
- Admin tenant provisioning workflow changes.
- Runtime command dispatcher/RBAC rewiring.
- Sensor-service Edge v2 data-model changes.

## Release Contract

- Release workflow runs only from a pushed `agent-v*` tag.
- The tag commit must be reachable from `origin/main`.
- Artifact names include the tag and target slug.
- Cosign certificate identity is pinned to the tag ref, not a branch ref.
- GitHub Actions is the source of build evidence; generated artifacts are not committed.

## Build Profile

The release workflow uses this explicit Cargo feature tier:

```yaml
EDGE_RELEASE_FEATURES: scada-display
```

This tier packages the local SCADA display surface. Broader software coverage remains in the curated CI feature set, and physical GPIO/I2C/SPI/PWM paths stay outside this release tarball unless a dedicated hardware release contract owns them.

## Known Limitations

- OTA remains an operator-controlled install flow for RC2; device-side automatic OTA enforcement is not claimed here.
- OPC UA client security posture remains documented as client-side `SecurityPolicy#None` unless later runtime work closes the security-policy gap.
- Command RBAC and signed envelope types exist, but dispatcher enforcement is a follow-up implementation PR.
- Edge v2 schema ownership follows ADR-025 and must not use the superseded admin-api `edge` schema design.

## Release Procedure

1. Merge this PR to `main` after GitHub Actions is green.
2. Confirm `main` points at the intended release commit.
3. Create `agent-v2.0.0-rc2` on that commit.
4. Push the tag to origin.
5. Wait for `Edge Agent Release` to publish artifacts and signatures.
6. Attach the GitHub Actions run URL to the evidence document.
