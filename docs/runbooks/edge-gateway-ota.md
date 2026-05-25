# Edge Gateway OTA RC4 Runbook

Audience: fleet operator evaluating update paths for `agent-v2.0.0-rc4`.

## RC4 Position

RC4 does not claim fully automatic device-side OTA enforcement.
RC4 is Historical RC Only and is not an approved production tenant download.
New releases follow `docs/architecture/edge-release-provisioning-ota.md`:
the control plane selects an explicit `agent-v<exact Cargo semver>` release,
publishes a signed `edge-release-manifest.json`, and devices apply with `apply_signed_manifest`.
The release workflow signs published artifacts, but installation remains operator-controlled.

Allowed for RC4:

- Manual download from GitHub Release.
- Checksum verification.
- Cosign verification against the tag-scoped workflow identity.
- In-place systemd replacement with `.prev` rollback.

Not allowed to claim for RC4:

- Autonomous fleet OTA.
- A/B partition swap.
- Device-side Rekor enforcement.
- Unsigned or branch-built update artifact.
- Rollback to a version that violates local anti-rollback policy.

## Verification

```bash
TAG=agent-v2.0.0-rc4
VERSION=${TAG#agent-}
ARCH=aarch64-linux
BASE=suderra-agent-${VERSION}-${ARCH}

sha256sum -c ${BASE}.tar.gz.sha256
cosign verify-blob \
  --certificate ${BASE}.tar.gz.pem \
  --signature ${BASE}.tar.gz.sig \
  --certificate-identity "https://github.com/Okan-wqm/aquaculture_platform/.github/workflows/edge-agent-release.yml@refs/tags/${TAG}" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  ${BASE}.tar.gz
```

The certificate identity must contain `@refs/tags/${TAG}`.

## Install and Rollback

Use `docs/runbooks/edge-gateway-rc4-operator.md` for the install steps.
Keep `/usr/local/bin/suderra-agent.prev` until the soak window passes.

## Stop Conditions

- Missing `.sig`, `.pem`, `.sha256`, SBOM, provenance, or notice artifact.
- Cosign issuer is not `https://token.actions.githubusercontent.com`.
- Cosign identity is not the tag-scoped `edge-agent-release.yml` ref.
- Health endpoint fails after restart.
- Journal shows new actuator, MQTT, config, or persistence errors.

## Follow-Up Needed for Automatic OTA
