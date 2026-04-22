# Package 02: jwt-asymmetric-signing

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 22K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Sprint: 0

## Closing-Findings
Closing-Findings: [security-reviewer/CRITICAL-001]

## Source-Reviews
- /var/aqua-saas/docs/reviews/security-reviewer/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
Platform JWTs use HS256 with a shared secret distributed to multiple services. Any compromised service can forge valid tokens for every other service in the platform. The auth-service must become the sole token issuer using asymmetric signing (RS256), with consumers verifying via a public key or JWKS endpoint.

## Findings
`CRITICAL-001` (security-reviewer): Platform JWTs are still HS256/shared-secret across multiple services. `getJwtVerifyOptions()` hard-codes `algorithms: ['HS256']`, and several services load the same `JWT_SECRET`. Auth-service signs tokens with HS256. Files: `libs/backend-common/src/auth/jwt-verification.utils.ts:104,109`, `apps/auth-service/src/app.module.ts:127,187`, `apps/ai-service/src/app.module.ts:178`, `apps/farm-service/src/app.module.ts:323`, `apps/messaging-service/src/app.module.ts:281`.

## Affected Files
- /var/aqua-saas/libs/backend-common/src/auth/jwt-verification.utils.ts
- /var/aqua-saas/apps/auth-service/src/app.module.ts
- /var/aqua-saas/apps/ai-service/src/app.module.ts
- /var/aqua-saas/apps/farm-service/src/app.module.ts
- /var/aqua-saas/apps/messaging-service/src/app.module.ts
- /var/aqua-saas/apps/gateway-api/src/app.module.ts
- /var/aqua-saas/apps/hr-service/src/app.module.ts
- /var/aqua-saas/apps/sensor-service/src/app.module.ts
- /var/aqua-saas/apps/billing-service/src/app.module.ts
- /var/aqua-saas/apps/admin-api-service/src/app.module.ts

## Dependencies
None.

## Atomic Commit Plan
```
security(auth): migrate JWT signing from HS256 to RS256 asymmetric keys

All platform services shared the same JWT_SECRET for HS256 signing and
verification. Any compromised service could forge valid tokens for the
entire platform. This moves token signing to auth-service only using
RS256 with a private key, and switches all consumer services to
public-key/JWKS verification.

BREAKING CHANGE: JWT_SECRET is no longer accepted for access token
verification. Services must configure JWT_PUBLIC_KEY or JWKS_URI.
Auth-service requires JWT_PRIVATE_KEY for signing.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/02-jwt-asymmetric-signing.md
Closes: docs/reviews/security-reviewer/2026-04-10-full-repo-audit.md#CRITICAL-001
```

## Test Plan
- Unit tests for auth-service token signing with RS256 private key.
- Unit tests for consumer services verifying tokens with RS256 public key.
- Integration test: token signed by auth-service is accepted by gateway-api.
- Negative test: HS256-signed token is rejected by all consumers.
- Negative test: services without JWT_PUBLIC_KEY fail to start (fail-closed).

## Verification Command
`npx tsc --noEmit -p apps/auth-service/tsconfig.json && npx jest --testPathPattern="apps/auth-service/src" --coverage=false && npx tsc --noEmit -p libs/backend-common/tsconfig.json`

Dispatch: security-reviewer
Dispatch: test-runner

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

