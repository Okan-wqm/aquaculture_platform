# Package 01: jwt-deployment-contract

## Metadata
Status: IN_PROGRESS
Estimated Tokens: 14K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: no (ship first)
Prerequisites: none
Closing-Findings: [CRITICAL-001]
Source-Reviews: /var/aqua-saas/docs/security/2026-04-12-hardening-gap-report.md

## Context
The JWT verification code was migrated to RS256 in commits `7c076361` and `4e5469ba`, but the deployment contracts (`docker-compose.prod.yml` and the Helm chart) still pass the obsolete `JWT_SECRET` env var to every service and do NOT pass `JWT_PUBLIC_KEY` / `JWT_PRIVATE_KEY`. Consumer services require `JWT_PUBLIC_KEY` (or `_PATH`) to start in production; auth-service requires both. Without this fix, services fail to boot in production.

## Findings
**CRITICAL-001** (from hardening-gap-report §Gap 1):
> Root production compose injects `JWT_SECRET` into gateway and backend services… Helm … the checked Helm secret model still centers on `jwtSecret`, while the shared helper comments say non-auth services should use `JWT_PUBLIC_KEY` or auth-service introspection. The checked Helm templates do not show an equally explicit public-key distribution path for consumers.

Evidence:
- `docker-compose.prod.yml:126, 167, 193, 219, 244, 269, 296, 324, 360` — 9 services receive `JWT_SECRET`, none receive `JWT_PUBLIC_KEY` or `JWT_PRIVATE_KEY`.
- `infrastructure/helm/aquaculture/templates/secrets.yaml:18, 44-46` — only `jwtSecret` exists.
- `infrastructure/helm/aquaculture/templates/_helpers.tpl:104-122` — `backendEnv` helper injects no JWT-related env.
- `infrastructure/helm/aquaculture/templates/backend-services.yaml:40-44` — auth-service alone receives `JWT_SECRET`.

## Affected Files
- `/var/aqua-saas/docker-compose.prod.yml`
- `/var/aqua-saas/infrastructure/helm/aquaculture/templates/_helpers.tpl`
- `/var/aqua-saas/infrastructure/helm/aquaculture/templates/secrets.yaml`
- `/var/aqua-saas/infrastructure/helm/aquaculture/templates/backend-services.yaml`
- `/var/aqua-saas/infrastructure/helm/aquaculture/values.yaml`
- `/var/aqua-saas/infrastructure/helm/aquaculture/values-production.yaml`
- NEW: `/var/aqua-saas/infrastructure/docker/scripts/generate-jwt-keypair.sh`
- `/var/aqua-saas/.env.example` (if present; else skip)

## Dependencies
none

## Atomic Commit Plan

```
security(deploy): distribute RS256 keypair to services, drop JWT_SECRET

Code migrated to RS256 in 7c076361 + 4e5469ba but deployment contracts still
pass the obsolete JWT_SECRET and do not distribute JWT_PUBLIC_KEY. In production,
services refuse to start without the asymmetric key pair. This package closes
the drift between code and deployment.

- docker-compose.prod.yml: mount ./certs/jwt as /var/run/jwt in every service
  that verifies tokens; set JWT_PUBLIC_KEY_PATH on consumers; set both
  JWT_PRIVATE_KEY_PATH and JWT_PUBLIC_KEY_PATH on auth-service; remove
  JWT_SECRET from consumer services (obsolete).
- Helm: add jwtPrivateKey + jwtPublicKey to secrets.yaml (inline and ExternalSecret
  paths); inject JWT_PUBLIC_KEY via backendEnv helper into every consumer;
  inject JWT_PRIVATE_KEY into auth-service only.
- generate-jwt-keypair.sh: create ./certs/jwt/{private,public}.pem idempotently
  (skip if files exist; 4096-bit RSA, mode 0400).
- values.yaml + values-production.yaml: declare new required secret fields.

BREAKING CHANGE: JWT_SECRET env var removed from non-auth services; services
require JWT_PUBLIC_KEY_PATH (compose) or JWT_PUBLIC_KEY secret ref (Helm) at
boot. Operators must run `infrastructure/docker/scripts/generate-jwt-keypair.sh`
before first deploy, or provide the keys via the secret store.

Closes: docs/security/2026-04-12-hardening-gap-report.md#CRITICAL-001
```

## Test Plan
- Docker: run `docker compose -f docker-compose.prod.yml config` — must render with no errors after `JWT_PRIVATE_KEY_PATH` / `JWT_PUBLIC_KEY_PATH` substitution.
- Helm: run `helm template infrastructure/helm/aquaculture --set secrets.jwtPrivateKey=<test> --set secrets.jwtPublicKey=<test>` — must render with the new env vars present on every backend service.
- Boot-smoke: locally spin up auth-service with only `JWT_PRIVATE_KEY_PATH`/`JWT_PUBLIC_KEY_PATH` (no `JWT_SECRET`) and verify the JwtModule factory accepts it.

## Verification Command
```
cd /var/aqua-saas && docker compose -f docker-compose.prod.yml config > /dev/null && helm template infrastructure/helm/aquaculture --set secrets.databaseUrl=test --set secrets.redisUrl=test --set secrets.natsUrl=test --set secrets.jwtPrivateKey=test --set secrets.jwtPublicKey=test --set secrets.jwtSecret=test > /dev/null && echo PASS
```
Dispatch: security-reviewer
Dispatch: test-runner

## Rollback Plan
```
git revert {commit_hash} --no-edit
```
Rollback restores the obsolete `JWT_SECRET` injection. Services will fail to start in production until the revert is itself reverted or RS256 keys are provisioned by another path.

## Failure Notes
_(empty at plan creation; executor appends on failure)_
