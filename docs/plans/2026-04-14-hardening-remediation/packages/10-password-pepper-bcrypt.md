# Package 10: password-pepper-bcrypt

## Metadata
Status: DONE (commit TBD)
Estimated Tokens: 8K
Priority: MEDIUM
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: P07 (bootstrapSecrets adoption — PASSWORD_PEPPER flows through the file-mount path)
Closing-Findings: [HIGH-006]  (upgraded from MEDIUM-004 in merged plan — pepper is a high-value control)
Source-Reviews: /var/aqua-saas/docs/security/2026-04-12-hardening-gap-report.md (2026-04-14 gap scan #10)

## Context
bcrypt alone protects against offline brute-force if the DB is stolen, but at a fixed cost factor (12). A server-side pepper (HMAC key held in a separate secret store) makes offline attacks infeasible unless the attacker also exfiltrates the pepper. This package adds HMAC-peppered bcrypt as the platform default AND migrates existing legacy hashes lazily at login time — no forced password reset.

## Findings
**HIGH-006** (2026-04-14 gap scan #10): No password pepper on bcrypt.

## Affected Files
- NEW: /var/aqua-saas/libs/backend-common/src/auth/password.util.ts
- /var/aqua-saas/libs/backend-common/src/index.ts (export hashPassword/verifyPassword)
- /var/aqua-saas/apps/auth-service/src/modules/authentication/entities/user.entity.ts (replace raw bcrypt with platform helper + add verifyPasswordAndSignalMigration)
- /var/aqua-saas/apps/auth-service/src/modules/authentication/services/authentication.service.ts (lazy migrate on successful legacy match)
- /var/aqua-saas/apps/auth-service/src/database/seed.service.ts (SUPER_ADMIN uses hashPassword)
- /var/aqua-saas/docker-compose.prod.yml (PASSWORD_PEPPER injected into auth-service)
- /var/aqua-saas/infrastructure/helm/aquaculture/templates/{secrets.yaml,backend-services.yaml} (Helm secret + env wiring)
- /var/aqua-saas/infrastructure/helm/aquaculture/values.yaml (`secrets.passwordPepper` field)
- /var/aqua-saas/libs/backend-common/src/bootstrap/create-service-app.ts (PASSWORD_PEPPER in PLATFORM_SECRET_ENV_VARS)

## Atomic Commit Plan

```
security(auth): HMAC-peppered bcrypt with lazy legacy-hash migration

New platform utility hashPassword / verifyPassword wraps bcrypt with an
HMAC-SHA256 pepper. Storage format is versioned:
  Legacy:     $2[aby]?$12$...                        (raw bcrypt)
  Peppered:   p1:$2[aby]?$12$...                     (HMAC-then-bcrypt)

verifyPassword detects the prefix at call time and routes to the correct
path. When a legacy hash matches AND PASSWORD_PEPPER is configured, the
result returns shouldMigrate=true so the caller re-hashes and persists —
users transparently migrate on their next successful login. No forced
password reset, no migration SQL, no feature flag.

- password.util.ts (NEW): hashPassword, verifyPassword, PEPPERED_PREFIX_V1.
  In production PASSWORD_PEPPER is required; in dev a null pepper falls
  back to plain bcrypt so existing dev fixtures keep working.
- User entity BeforeInsert/BeforeUpdate hook: delegates to hashPassword.
- User.validatePassword: unchanged signature; returns boolean.
- User.verifyPasswordAndSignalMigration: new method exposing
  shouldMigrate for the login path.
- authentication.service.ts login flow: persist rehashed password on
  successful legacy match (after MFA/lockout/tenant-status checks).
- seed.service.ts SUPER_ADMIN: use hashPassword (in production yields a
  p1: hash; in dev stays plain bcrypt for backward compat).
- Secret supply chain: PASSWORD_PEPPER added to PLATFORM_SECRET_ENV_VARS
  so file-mount delivery works; injected into auth-service container in
  docker-compose.prod.yml and via Helm secret + passwordPepper env.

BREAKING CHANGE: PASSWORD_PEPPER env var is REQUIRED on auth-service in
production. Generate with: openssl rand -base64 48. Rotating the pepper
forces a password reset for every user (hashes become unverifiable) —
treat rotation as a security incident response, not routine ops.

Closes: docs/security/2026-04-12-hardening-gap-report.md#HIGH-006
```

## Test Plan
- scoped tsc clean on password.util.ts
- Compose renders
- Integration: login with a legacy hash succeeds once and the stored hash becomes `p1:...` — second login verifies via the peppered path

## Verification Command
scoped tsc + compose render

## Rollback Plan
`git revert {commit_hash} --no-edit`
Callsites fall back to raw bcrypt; legacy hashes still work; peppered `p1:` hashes become unverifiable — users on the new format would need password reset. Plan the revert only as a break-glass action.

## Failure Notes
_(empty)_
