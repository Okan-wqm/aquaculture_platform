# Edge Gateway RC3 Operator Runbook

Audience: plant IT, fleet operator, and field engineer.
Release: `agent-v2.0.0-rc3`.
Do not install artifacts from `agent-v2.0.0-rc2`; that tag did not publish a GitHub Release.

## Preconditions

- GitHub Release was created by `Edge Agent Release` from an `agent-v*` tag.
- The tag commit is reachable from `origin/main`.
- Downloaded files include archive, checksum, SBOM, provenance, notices, `.sig`, and `.pem`.
- Maintenance window is approved for the target pond/site.
- Physical override or manual safe-state procedure is available for actuator-bearing deployments.

## Download and Verify

```bash
TAG=agent-v2.0.0-rc3
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

Stop if checksum or cosign verification fails.

## Install

```bash
sudo systemctl stop suderra-agent
sudo install -d -m 0750 -o suderra -g suderra /var/lib/suderra/releases/${TAG}
sudo cp ${BASE}.* /var/lib/suderra/releases/${TAG}/
sudo tar --no-same-owner -xzf /var/lib/suderra/releases/${TAG}/${BASE}.tar.gz -C /var/lib/suderra/releases/${TAG}/

sudo install -m 0755 /usr/local/bin/suderra-agent /usr/local/bin/suderra-agent.prev
sudo install -m 0755 /var/lib/suderra/releases/${TAG}/edge-agent /usr/local/bin/suderra-agent
sudo systemctl start suderra-agent
```

## Health Check

```bash
systemctl is-active suderra-agent
curl -sf http://localhost:6526/health
journalctl -u suderra-agent --since "5 min ago" -p warning --no-pager
```

Expected result: service active, health endpoint returns success, no new startup errors.

## Rollback

```bash
sudo systemctl stop suderra-agent
sudo install -m 0755 /usr/local/bin/suderra-agent.prev /usr/local/bin/suderra-agent
sudo systemctl start suderra-agent
```

Rollback must use a previous signed release artifact when `.prev` is not present.

## Evidence to Record

- GitHub Release URL.
- GitHub Actions run URL.
- Target device id, site, architecture, and operator id.
- Checksum verification output.
- Cosign verification output.
- Health-check timestamp.
