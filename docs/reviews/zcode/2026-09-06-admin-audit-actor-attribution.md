# An audit row that names nobody — 2026-09-06

Reviewer: zcode. Cycle: `2026-09-05-branch-sweep`. Target: `origin/main` @ `778f04ed5`.

Re-derived from `claude/admin-panel-e2e-audit-9b80i5` (APA-247). That branch differs in kind from
the four evaluated before it: main already carries its audit and its remediation roadmap from
PR #1021, and the roadmap states outright that "no source is changed by adding it — actual
remediation lands in later per-phase agent workflows". So main holds the plan and the branch holds
the execution, 91 commits of it. It still cannot be merged: 1001 commits behind main, 95
conflicting files, 137 of the 241 shared files touched later by main. This is its first slice,
chosen because the defect was verified still live on main today.

## ADMIN-HIGH-097 — nine audit writes named a literal instead of the operator

**Severity:** HIGH. **Owner:** audit-trail-completeness-auditor. **State:** IN-PROGRESS.

**Evidence.** Every admin-api route sits behind the SUPER_ADMIN guard, so a controller always has a
verified operator on the request. Nine writes declined to use it:

| Site                                    | What it recorded                                                  |
| --------------------------------------- | ----------------------------------------------------------------- |
| `audit-trail.controller.ts:504`         | `createdBy: 'admin', // Would come from auth context`             |
| `audit-trail.controller.ts:516`         | `updateRetentionPolicy(id, dto, 'admin')`                         |
| `security-monitoring.controller.ts:543` | `'admin'` / `'Admin User'` on the incident timeline               |
| `ticket.controller.ts:269`              | `createdBy: 'tenant-user-id'` — a literal that is not an id       |
| `explorer.controller.ts` ×3             | `performedBy: 'SUPER_ADMIN'` — the role, not the person           |
| `explorer.controller.ts:339`            | `performedBy: user?.id \|\| 'SUPER_ADMIN'` — degrades to the role |
| `audit.controller.ts:28`                | `performedBy: user?.id \|\| 'unknown'`                            |
| `global-settings.controller.ts:690`     | `updatedBy: user?.email \|\| user?.id \|\| 'admin'`               |

Three of these were named by APA-247. The other six the sweep for the invariant found, and the
sharpest is the database explorer. Its own comment calls cross-tenant SUPER_ADMIN reads "the
highest-criticality audit class" and deliberately awaits the log so a failure surfaces as a 500
rather than a half-recorded access — and then records the role. The row proves someone holding
SUPER_ADMIN read a tenant's data; it cannot say which operator did. `audit.controller.ts` is the
same shape: a meta-audit that exists so an insider reading audit data leaves a trace, recording
that trace as `'unknown'`.

The `user?.id || '…'` form is the one worth naming separately. It reads as defensive and is the
mechanism: whenever the guard stops populating the request, attribution silently degrades to a
constant instead of failing.

**Rule violated.** An audit write from a controller names the authenticated operator, and refuses
rather than substitutes when none is present.

**Fix.** `requireAuthUserId` / `requireAuthUserName` join the existing `getAuthUser*` readers in
`apps/admin-api-service/src/shared/authenticated-request.ts`. The readers return `undefined`, which
is right for an optional read and wrong for an attribution: a caller forced to handle `undefined`
eventually substitutes something, and did. The new pair returns the identity or throws, so the
substituting branch has nowhere to live. All nine sites use them; `getPublicTableData` now carries
the request into the audited read it delegates to.

`tests/invariants/admin-audit-actor-attribution.spec.ts` closes both shapes — a literal in an
attribution field, and the `?.id || '…'` degrade — scoped to `*.controller.ts`. Services are
deliberately out of scope: a service can run from cron with no operator at all, and
`performedBy: 'system:cron'` is the honest value there. The rule is about the surface that has an
identity and declined to use it.

**Closure criterion.** Verified in both directions: reverting `ticket.controller.ts` to
`'tenant-user-id'` fails the literal case naming that `file:line`, and reverting
`audit.controller.ts` to `user?.id || 'unknown'` fails the fallback case. `npm run type-check`
green across 41 projects. admin-api-service 60 suites / 955 tests pass.

**Three specs changed, and why that is not a weakening.** `explorer-security`,
`explorer-sql-security` and `explorer-export-streamable` drove the controller with no `req.user` at
all — a request shape production never produces, since the guard runs first. They now attach the
operator at the edge. The `PlatformAdminGuard` double in two of them returns `true` without
populating the request, which is why overriding it was not enough; the middleware is applied
regardless of which guard the controller resolves.

**Not in this slice.** The branch carries 91 commits against 94 APA findings. This one was picked
because it is security-relevant, self-contained, and verified live. The rest are unassessed against
current main — 137 of the 241 shared files have moved since, so each needs the same
"is it still true?" check before anything is ported.
