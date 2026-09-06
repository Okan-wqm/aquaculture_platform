# Action-link origin — second branch sweep, 2026-09-06

Reviewer: zcode. Cycle: `2026-09-05-branch-sweep`. Target: `origin/main` @ `5cf4757b9`.

Recovered from `claude/faz-2c-auth-recovery-0jj9jg` while evaluating what the remaining branches
still add to main. The branch is 26 commits and 34 conflicts behind, so this slice was re-derived
against main rather than merged.

## DEPLOY-HIGH-016 — every e-mailed invitation and reset link pointed at localhost

**Severity:** HIGH. **Owner:** infra-expert. **State:** IN-PROGRESS.

**Evidence.** `apps/auth-service/src/modules/authentication/controllers/internal-auth.controller.ts`
mints the URLs notification-service puts in e-mail — `/accept-invitation/<token>` and
`/reset-password/<token>` — from `configService.get('FRONTEND_URL', 'http://localhost:8080')`.
No deployment set that key on auth-service:

- `docker-compose.droplet.yml` (production) provisioned `FRONTEND_URL` to **admin-api-service**, and
  `git grep FRONTEND_URL -- apps/admin-api-service` returns nothing — that service never reads it.
- `docker-compose.prod.yml` did not set it at all, on any service.
- `docker-compose.staging.yml` repeated the droplet's mistake against the staging domain.
- The auth-service block already carried the two other origin-shaped keys, `CORS_ORIGINS` and
  `WEBAUTHN_RP_ID`, which is exactly why the omission read as deliberate.

So in production the fallback applied: notification-service asked auth-service for an action link
and was handed `http://localhost:8080/accept-invitation/…`. Nothing failed — no exception, no log —
because both halves of the mistake are individually plausible. A user could not accept an invitation
or reset a password from the e-mail.

**Rule violated.** A default that is correct only in development must be refused outside it, and an
environment key belongs to the service that reads it. Provisioning it to a service that does not is
worse than not provisioning it: it makes the key look present to anyone who greps the compose file.

**Fix.**

- `apps/auth-service/src/config/frontend-url.ts` — `parseFrontendUrl` is the single reader. It keeps
  the development default where it is correct and refuses it everywhere else: in production and
  staging the key is required, must be `https`, and must not be a loopback host; a query, fragment
  or credentials are rejected in every environment. The controller resolves it **in its constructor**,
  so a misconfigured deployment fails to start instead of surfacing in somebody's inbox.
- The three deployed compose files provision `FRONTEND_URL` to auth-service (`app.suderra.com` for
  production, `staging.suderra.com` for staging), and the two dead admin-api-service entries are
  removed.
- `tests/invariants/action-link-origin-deployment-contract.spec.ts` derives the consumer set from
  source — a service consumes a key when its own non-test files read it — and asserts both
  directions on every deployed compose: a consumer without the key fails, and a non-consumer with it
  fails. Verified against the regression: deleting the key from `docker-compose.prod.yml` fails the
  spec with the exact sentence describing the defect, and restoring it passes.
- `apps/auth-service/src/config/__tests__/frontend-url.spec.ts` pins both halves of the default —
  returned in development, refused in production.

**Local-development compose files are deliberately out of scope.** There the development default is
the correct value, and the parser refuses it outside development anyway.

**Closure criterion.** auth-service's suite is green (64 suites, 736 tests); the deployment-contract
invariant passes and fails on the regression; `FRONTEND_URL` appears in the three deployed compose
files under auth-service and nowhere else.
