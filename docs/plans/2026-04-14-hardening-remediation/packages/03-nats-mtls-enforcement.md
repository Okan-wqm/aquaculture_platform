# Package 03: nats-mtls-enforcement

## Metadata
Status: IN_PROGRESS
Estimated Tokens: 10K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: no (requires P02)
Prerequisites: 02-nats-per-service-credentials
Closing-Findings: [HIGH-002]
Source-Reviews: /var/aqua-saas/docs/security/2026-04-12-hardening-gap-report.md

## Context
`nats-tls-enabled.conf` ran with `verify: false` — one-way TLS. Any container on the internal network could connect as long as it knew a valid user/pass. This package turns on `verify: true` and distributes a CA-signed client cert so NATS rejects unauthenticated containers at TLS handshake, adding a transport-layer trust gate.

## Findings
**HIGH-002** (hardening-gap-report §Gap 3):
> The checked NATS TLS configuration says… verify: false
> That means: clients verify the server if they are configured correctly; server does not require client certificates. So for the checked Docker production path "mTLS is absent" is accurate.

## Affected Files
- /var/aqua-saas/infrastructure/docker/nats/nats-tls-enabled.conf (flip verify:true)
- /var/aqua-saas/infrastructure/docker/scripts/generate-internal-certs.sh (add client cert generation)
- /var/aqua-saas/libs/backend-common/src/nats/nats-connection.factory.ts (load client cert/key)
- /var/aqua-saas/docker-compose.prod.yml (mount certs, set NATS_TLS_CERT/KEY envs)
- /var/aqua-saas/docker-compose.droplet.yml (extend x-nats-*-env anchors, add mount anchors)

## Atomic Commit Plan

```
security(nats): enforce mTLS, require client certificates for all services

NATS ran with verify:false — one-way TLS only. Any container on aqua-internal
could connect with just a valid user/pass. This commit flips verify:true and
distributes a CA-signed client cert so the broker rejects unauthenticated
containers at the TLS handshake.

- nats-tls-enabled.conf: verify: true (mTLS required)
- generate-internal-certs.sh: new generate_client_cert helper that issues a
  shared client-cert.pem / client-key.pem under certs/nats/ (CN=aqua-services).
  Per-service application identity is unchanged — it still comes from the
  NATS authorization user/pass. The client cert only adds transport trust.
- nats-connection.factory.ts: NATS_TLS_CERT and NATS_TLS_KEY env vars loaded
  alongside NATS_TLS_CA; both must be present when either is (hard-fail on
  partial config to avoid confusing handshake errors). nats.js forwards cert
  and key to tls.connect() via the existing tls options object.
- docker-compose.prod.yml: mount ./certs/nats read-only into every backend
  service; set NATS_TLS_ENABLED, NATS_TLS_CA, NATS_TLS_CERT, NATS_TLS_KEY on
  all 9 services.
- docker-compose.droplet.yml: new x-nats-client-cert-mount and
  x-nats-client-key-mount anchors referenced alongside existing x-nats-ca-mount
  on every backend service. Each x-nats-*-env anchor extended with NATS_TLS_CERT
  and NATS_TLS_KEY paths (shared across services because the CA still
  authenticates the cert, and identity comes from user/pass).

BREAKING CHANGE: NATS broker rejects clients without a CA-signed certificate.
Operators must run infrastructure/docker/scripts/generate-internal-certs.sh
(or regenerate with --force) before redeploying so client-cert.pem /
client-key.pem exist under certs/nats/. Existing deployments without the
client cert will fail to connect to NATS.

Closes: docs/security/2026-04-12-hardening-gap-report.md#HIGH-002
```

## Test Plan
- `docker compose -f docker-compose.prod.yml config` renders
- `docker compose -f docker-compose.droplet.yml config` renders
- scoped type check on `libs/backend-common/src/nats/nats-connection.factory.ts` clean
- `generate-internal-certs.sh` idempotent: re-running skips existing certs

## Verification Command
compose config + scoped tsc + re-run generate-internal-certs.sh

## Rollback Plan
`git revert {commit_hash} --no-edit`
Restores verify:false. Existing deployments continue working without client cert.

## Failure Notes
_(empty at plan creation)_
