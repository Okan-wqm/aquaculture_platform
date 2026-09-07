# A logout button wired to an empty table — 2026-09-07

Reviewer: zcode. Cycle: `2026-09-05-branch-sweep`. Target: `origin/main` @ `cadba5c14`.

Queued read-only during the branch sweep, re-derived and verified here before any change.

## ADMIN-HIGH-100 — the session endpoints reported success and revoked nothing

**Severity:** HIGH. **Owner:** admin-expert. **State:** IN-PROGRESS.

### Evidence

`admin.user_sessions` (`security.entity.ts:990`) modelled a login session in full — token, device,
geo, request count, termination reason, terminating actor. Exactly one statement in the platform
inserted into it:

- `ActivityLoggingService.createSession` (`activity-logging.service.ts:516`) — **zero callers**.
- `updateSessionActivity` (`:546`) — **zero callers**.
- `terminateSession` (`:562`) — **zero callers**.

The table was therefore empty for its entire life, in every environment. Three surfaces read it, and
all three read nothing:

| Surface                                                     | What it promised                | What it did                                   |
| ----------------------------------------------------------- | ------------------------------- | --------------------------------------------- |
| `GET /security/activities/sessions/user/:userId`            | the user's active sessions      | returned `[]`, always                         |
| `POST /security/activities/sessions/user/:userId/terminate` | revoke them                     | returned `{ terminated: 0 }`, revoked nothing |
| `SecurityMonitoringService.checkSessionHijacking` (`:582`)  | detect an IP change mid-session | returned `false` at its first lookup          |

Both endpoints sat behind the global `PlatformAdminGuard` and on the documented Swagger surface
(`@ApiTags('Security')`, `@Controller('security/activities')`). An hourly `@Cron`
(`cleanupExpiredSessions`, `:884`) swept the empty table forever.

The two lies reinforced each other. An operator responding to a compromised account would read "no
active sessions", terminate anyway, receive HTTP 200, and conclude the account was locked out. Every
refresh token in `auth.refresh_tokens` and every Redis session stayed valid.

### What this is not

`checkSessionHijacking` had **zero callers** too. It was dead code that could never have fired — not
a live control silently switched off. Claiming production ran with hijacking detection disabled
would overstate the evidence; nothing ever invoked it.

And this is not CRITICAL. No operator UI reaches the dead endpoints, because the working path
existed the whole time and is what the admin panel actually calls:

- `UserManagementPage.tsx:235` → `PATCH /users/:id/force-logout` → `users.service.ts:631` → NATS
  `AUTH_ADMIN_COMMAND_SUBJECTS.FORCE_LOGOUT_USER` → auth-service `adminForceLogout`, which revokes
  `auth.refresh_tokens` and the Redis sessions for real.
- `GET /users/:id/sessions` → `users.service.ts:401` → `SELECT … FROM auth.refresh_tokens`.

The dead pair was a second implementation of both, against a store nobody filled. The exposure is a
SUPER_ADMIN-reachable documented API that answers a security question falsely — real, bounded, and
HIGH rather than CRITICAL.

### Rule violated

A security control that reports success while doing nothing is worse than one that is absent,
because the operator stops looking.

### Fix

The tempting repair is to give the table a writer. That is the wrong direction: it would create a
second source of truth for session state and guarantee the two disagree — this one already
disagreed, by being permanently empty.

Session state belongs to auth-service (`auth.refresh_tokens` plus the Redis `SessionManagerService`),
and this repo has already settled the same question once. `users.service.ts` carries the ruling in
its own comment: admin-api's raw-SQL INSERT into `auth.users` was deleted because _"admin-api-service
is NOT the owner of the auth schema"_. Sessions are that case again.

So the duplicate is deleted, not repaired:

- the two endpoints and their DTO,
- the six session methods and the hourly cron on `ActivityLoggingService`,
- `checkSessionHijacking` and the `concurrentSessionLimit` / `sessionHijackingDetection` config pair
  — dead knobs duplicating a limit auth already enforces in `SessionManagerService.enforceSessionLimit`,
- the `UserSession` entity,
- and `admin.user_sessions` itself (`1808500000000-DropDeadAdminUserSessions`).

Removing a documented endpoint is an API break, and it is the right one here: a caller gets a loud
404 with a working replacement one route away, instead of a silent lie on a security action.

- **Tier 1 (impossible).** The table and the entity are gone, so no code can revoke a session by
  writing admin's own copy of session state — there is no copy.
- **Tier 3 (detectable).** `tests/invariants/session-state-single-source.spec.ts` fails if any
  service outside auth-service declares a `user_sessions` table, and pins the surviving admin
  surface to the delegation: `forceLogout` must go through
  `AUTH_ADMIN_COMMAND_SUBJECTS.FORCE_LOGOUT_USER`, `getUserSessions` must read
  `auth.refresh_tokens`, and auth-service must answer that subject so the pin is not vacuous.

### Verification

- `nx test admin-api-service`: 958/958 across 60 suites.
- `contract-validation.spec.ts` caught the route removal on its own — its backend endpoint snapshot
  moved 603 → 601, which is the gate working as designed; the count is updated with the reason.
- **Mutation-verified.** With `admin.user_sessions` restored, the new invariant fails on the
  single-owner case (1 failed, 4 passed); with it removed, 5/5 pass.
- `npm run type-check`: all 41 projects green. eslint clean on every changed file.
- `tests/invariants`: 271/274 suites. The three failures are the known `production-host-*` suites
  that fail only in this sandbox (esbuild's ELF binary parsed as JS) and are green in CI; this diff
  does not touch them.

## What this does not do

It does not implement session-hijacking detection. The capability never existed at runtime — the
method had no callers and read a table with no rows — so deleting it removes nothing that worked.
But the platform should have that control, and dropping the stub without a record would let the gap
disappear quietly. Raised as **ADMIN-MEDIUM-101**, owner `auth-security-expert`, due **2026-10-05**:
implement mid-session IP/device-change detection against the store that actually holds sessions
(`SessionManagerService`), with a caller on the authenticated request path, or record the decision
not to.

`admin.user_sessions` needs no backfill and no data migration: it never held a row.
