# Package 08: cert-manager-internal-issuer

## Metadata
Status: DONE (commit TBD)
Estimated Tokens: 4K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: no (logically follows P03)
Prerequisites: 03-nats-mtls-enforcement (shares the cert model)
Closing-Findings: [MEDIUM-002]
Source-Reviews: /var/aqua-saas/docs/security/2026-04-12-hardening-gap-report.md

## Context
`generate-internal-certs.sh` produces the internal CA + server + client certs correctly but requires manual re-invocation every 365 days. cert-manager automates issuance and renewal in Kubernetes — adding the Issuer + Certificate CRDs replaces the manual flow without any workload changes (secrets are produced in the same PEM-bundle shape).

## Findings
**MEDIUM-002** (hardening-gap-report §Gap 4):
> automatic issuance / automatic renewal / cert-manager integration for internal transport certs / server-side mTLS rollout [missing]

## Affected Files
- NEW: /var/aqua-saas/infrastructure/helm/aquaculture/templates/cert-manager-issuer.yaml
- NEW: /var/aqua-saas/infrastructure/helm/aquaculture/templates/internal-certificates.yaml
- /var/aqua-saas/infrastructure/helm/aquaculture/values.yaml (new `certManager.internal` section)

## Atomic Commit Plan

```
feat(infra): add cert-manager Issuer and Certificate CRDs for internal transport

Automates the internal PKI lifecycle. Two-stage bootstrap:
  SelfSigned issuer  → root CA Certificate (10y, renew at 3mo)
  CA issuer          → leaf Certificates for NATS/Redis/Postgres servers
                       and the shared mTLS client (1y, renew at 30d)

Each Certificate produces a Secret with tls.crt/tls.key/ca.crt — exactly
the shape the connection factories already consume. No workload changes
needed; callsites will mount the cert-manager-issued secret in place of
the manual ./certs/* volumes when deployed to Kubernetes.

Gated behind certManager.internal.enabled (default false) so clusters
without cert-manager installed are not forced to install it.

Closes: docs/security/2026-04-12-hardening-gap-report.md#MEDIUM-002
```

## Test Plan
- `helm template` with `certManager.internal.enabled=true` renders all 4 Certificates + 2 Issuers without error
- YAML parses cleanly

## Verification Command
YAML parse + optional `helm template --set certManager.internal.enabled=true`

## Rollback Plan
`git revert {commit_hash} --no-edit`

## Failure Notes
_(empty)_
