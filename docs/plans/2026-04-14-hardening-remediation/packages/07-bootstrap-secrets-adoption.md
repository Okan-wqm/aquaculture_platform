# Package 07: bootstrap-secrets-adoption

## Metadata
Status: DONE (commit TBD)
Estimated Tokens: 6K
Priority: MEDIUM
Security-Sensitive: yes
Parallelizable: yes (tier 1 after P01)
Prerequisites: 01-jwt-deployment-contract
Closing-Findings: [MEDIUM-001]
Source-Reviews: /var/aqua-saas/docs/security/2026-04-12-hardening-gap-report.md

## Context
`libs/backend-common/src/config/secrets.provider.ts` has `readSecret()` / `bootstrapSecrets()` that resolve Docker Secrets / Kubernetes file-mount conventions (`VAR_FILE=/run/secrets/var`) into `process.env.VAR`. The hardening report noted the helper had **zero call sites** in `apps/`, so the file-mount path of the secret supply chain was unreachable even though Helm ExternalSecrets and Terraform Secrets Manager could deliver via files.

This package wires `bootstrapSecrets()` into the shared `createServiceApp` bootstrap so every service that uses `bootstrapService(AppModule, {...})` automatically resolves the platform's standard secrets at boot. Services can extend the list with service-specific secrets via the new `secrets: [...]` option.

## Findings
**MEDIUM-001** (hardening-gap-report §Gap 6 & closing paragraph):
> the local `readSecret()` / `bootstrapSecrets()` helper appears unused in checked application code

## Affected Files
- /var/aqua-saas/libs/backend-common/src/bootstrap/create-service-app.ts (import + call bootstrapSecrets)
- /var/aqua-saas/libs/backend-common/src/index.ts (export readSecret/bootstrapSecrets)

## Atomic Commit Plan

```
feat(bootstrap): wire bootstrapSecrets into shared createServiceApp

readSecret / bootstrapSecrets existed in libs/backend-common but had no
call sites anywhere in apps/, so the Docker Secrets / Kubernetes file-
mount secret supply chain (*_FILE=/run/secrets/...) was unreachable.
Services only read from env vars, bypassing the file-mount path that
ExternalSecrets and Terraform Secrets Manager can deliver.

Centralising the helper call in createServiceApp means every service
picks it up at once — no edits to 15 main.ts files.

- secrets.provider.ts: exported readSecret/bootstrapSecrets from index.ts.
- create-service-app.ts: new PLATFORM_SECRET_ENV_VARS list covers JWT keys,
  DB/Redis/NATS per-service passwords, INTERNAL_SERVICE_SECRET,
  ENCRYPTION_KEY, MFA_ENCRYPTION_KEY, Stripe + SMTP secrets. Invokes
  bootstrapSecrets([...list]) BEFORE the DATABASE_SYNC guard, so the
  value is available to every downstream ConfigService.get() call.
- ServiceBootstrapOptions gains an optional secrets?: readonly string[]
  field for service-specific extensions (e.g. STRIPE_SIGNING_SECRET).
  Main.ts files do not need to change unless they want additional vars.

Closes: docs/security/2026-04-12-hardening-gap-report.md#MEDIUM-001
```

## Test Plan
- scoped tsc clean on create-service-app.ts
- existing bootstrapService() callers remain backwards compatible (new option is optional)
- runtime: container with DB_PASSWORD_FILE=/run/secrets/db_pwd should now populate process.env.DB_PASSWORD from the file contents

## Verification Command
scoped tsc

## Rollback Plan
`git revert {commit_hash} --no-edit`

## Failure Notes
_(empty at plan creation)_
