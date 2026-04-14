# Package 02: nats-per-service-credentials

## Metadata
Status: DONE (commit d7ecb9d6)
Estimated Tokens: 12K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes (tier 0 with 01)
Prerequisites: none
Closing-Findings: [HIGH-001]
Source-Reviews: /var/aqua-saas/docs/security/2026-04-12-hardening-gap-report.md

## Context
`nats.conf` defines per-service NATS users with subject-level ACLs (committed in `4ba2a0c0`), but deployment contracts pass only a shared `NATS_AUTH_USER`/`NATS_AUTH_PASS` to every service. Services therefore log in as the shared account and the per-service ACL design has no runtime effect. This package wires per-service credentials end-to-end: docker-compose.prod.yml, docker-compose.droplet.yml, Helm secrets + env injection.

## Findings
**HIGH-001** (hardening-gap-report §Gap 2):
> checked deployment artifacts do not prove full use of that design… service containers mostly receive `NATS_AUTH_USER` / `NATS_AUTH_PASS` … the config file also expects many other service-specific variables such as `NATS_FARM_USER`, `NATS_SENSOR_USER`, `NATS_BILLING_USER`, etc.

## Affected Files
- /var/aqua-saas/docker-compose.prod.yml
- /var/aqua-saas/docker-compose.droplet.yml
- /var/aqua-saas/infrastructure/helm/aquaculture/values.yaml
- /var/aqua-saas/infrastructure/helm/aquaculture/templates/secrets.yaml
- /var/aqua-saas/infrastructure/helm/aquaculture/templates/_helpers.tpl
- /var/aqua-saas/infrastructure/helm/aquaculture/templates/backend-services.yaml
- /var/aqua-saas/infrastructure/helm/aquaculture/templates/gateway-api.yaml

## Atomic Commit Plan

```
security(nats): provision per-service NATS credentials in compose and helm

nats.conf defines per-service users with subject-level ACLs (4ba2a0c0) but
deployment still injected only a shared NATS_AUTH_USER/PASS into every
service. The ACL design had no runtime effect — all services shared one
account. This commit wires per-service credentials end-to-end.

- docker-compose.prod.yml: NATS container gets all 10 per-service user/pass
  pairs; each service gets its own NATS_AUTH_USER/NATS_AUTH_PASS (required,
  no fallback). admin-api-service shares the gateway account per nats.conf
  comment.
- docker-compose.droplet.yml: unify the x-nats-*-env anchor naming on
  NATS_<SERVICE>_USER/PASS (remove NATS_*_SVC_* variants and the silent
  fallback to shared account). NATS container receives the same 10 pairs.
- Helm: secrets.yaml gains natsAuthUser/Pass…natsHydroponicsUser/Pass
  (inline Secret path and ExternalSecret path). _helpers.tpl defines
  aquaculture.natsServiceEnv (list ctx "Name") which injects the right
  per-service NATS_AUTH_USER/PASS from secretKeyRef. backend-services.yaml
  and gateway-api.yaml call the helper per service.

Per nats.conf runtime isolation is now active: a compromised service can
only publish/subscribe within its ACL scope.

Closes: docs/security/2026-04-12-hardening-gap-report.md#HIGH-001
```

## Test Plan
- `docker compose -f docker-compose.prod.yml config` renders with all NATS_* vars per service
- `docker compose -f docker-compose.droplet.yml config` renders
- `helm template infrastructure/helm/aquaculture --set ...` (requires helm CLI — not available in sandbox; YAML parse on values files OK)

## Verification Command
Two-step: compose rendering + YAML parse on Helm values.

## Rollback Plan
`git revert {commit_hash} --no-edit`

## Failure Notes
_(empty at plan creation)_
