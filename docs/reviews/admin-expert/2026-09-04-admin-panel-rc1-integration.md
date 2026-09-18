# Admin-panel RC chain — re-slice onto the integration head

**Date:** 2026-09-04 · **Branch:** `claude/admin-panel-rc1-integration` · **Base:**
`claude/branch-evaluation-merge-s5grgw` @ `1b5920bfc` · **Sources:** PR #1034
(`claude/admin-panel-rc1-pagination-envelope` @ `85448f204`) and PR #1021
(`claude/admin-panel-e2e-audit-9b80i5` @ `e6e46717c`, closed unmerged).

## Why this document exists

A wholesale merge of the RC chain is not possible: it is 614 commits behind, conflicts in 23 files,
carries a semantic conflict with main's tenant-provisioning saga, and collides with an existing
admin-api migration on the `1801600000000` prefix. The owner's close comment on #1021 prescribes a
re-slice with a rescue pass, so each roadmap slice is re-derived against what this head actually
carries rather than cherry-picked.

This document records what that pass **did not** land, with an owner, a deadline and a closure
criterion per item, per CLAUDE.md's rule that deferred work is only legitimate when it is tracked.
Registry stubs for every item below are written to `…/scratchpad/r1034/stubs/<ID>.json`; they are
deliberately **not** appended to `docs/reviews/_registry/findings.jsonl` here, because each addition
moves the counts the enterprise-grade-debt-closure plan mirrors and this pass is not permitted to
repin those mirrors (see "Required follow-up" below).

## What landed

| Slice | Commit                                                                       | Source                   |
| ----- | ---------------------------------------------------------------------------- | ------------------------ |
| 1     | `efc60ea29` import the 2026-07-20 audit record                               | #1021 docs (21 files)    |
| 2     | `39359088c` read the rows out of the paginated envelope                      | `4a73ff847`, `cb0bfe130` |
| 6     | `23fbabeba` stop rendering a compliance requirement object as a React child  | `85448f204`              |
| 9     | `caeb141ae` give the impersonation audit surface numbers that mean something | `3948599c4`              |
| 8a    | `3040df8df` stop the response envelope from corrupting every table export    | `4600a256d`              |

## Gaps

Every item below is live on this head; the "evidence" line is the check that proves it, run against
`3040df8df`.

### ADMIN-HIGH-086 — RC-2/3/4/6 request-contract slice not re-derived

**Owner:** admin-expert · **Deadline:** 2026-10-15 · **Severity:** HIGH

Six chain commits (`741a5ef77`, `b02cf2871`, `894cbbf5f`, `6cdadfbbe`, `bdcbf98c3`, `182bd2226`)
turn every `@Body`/`@Query` on admin-api into a validated DTO class so the global `ValidationPipe`
engages, declare static routes before their `:param` siblings so shadowed endpoints become
reachable, reconcile the FE↔DTO write contracts, and derive the SUPER_ADMIN sidebar from one route
manifest so ten mounted-but-hidden admin pages become navigable. Together they are ~3,980 inserted
lines across 107 files, and they must be re-derived rather than cherry-picked because main has since
changed the same surface twice: `3cdcfe9ac` allowlisted sort columns and clamped list limits (the
half of RC-2's `sortBy` hardening that IS covered), and `e09ec4e68` routed user-supplied regexes
through the shared `safeRegex` gate.

**Evidence:** the audit's own inventory in
`docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/xc-routing-nav.md` and
`.../system-mgmt.md`; the registered counterpart for the `sortBy` half is `ADMIN-HIGH-005`
(IN-PROGRESS).

**Closure criterion:** every admin-api handler parameter is a DTO class instance (an architecture
spec enumerating `@Body`/`@Query` sites and asserting a class type, as the chain's
`controller-dto-validation.architecture.spec.ts` does), the route-shadowing spec is green, and the
sidebar manifest spec proves every mounted admin route is reachable from the navigation.

### ADMIN-CRITICAL-087 — support silo consolidation not re-derived

**Owner:** admin-expert · **Deadline:** 2026-10-15 · **Severity:** CRITICAL

`apps/admin-api-service/src/support/` still owns `announcement.{controller,service}.ts`,
`ticket.{controller,service}.ts` and `messaging.{controller,service}.ts` alongside the auth-service
modules that hold the same data (`apps/auth-service/src/modules/{announcement,support,messaging}/`).
The chain deleted the admin duplicates and consolidated onto the auth SSoT (`3b8d58b55`,
`c9a40660d`, `933a02656`), granted `auth_service` the `AnnouncementPublished` NATS publish subject
(`b9e22832b`), and carried three copy-then-drop migrations to move the rows. The audit's finding is
that a broadcast written through the admin duplicate never reaches a tenant, because the delivery
path reads the auth table.

**Evidence:** `ls apps/admin-api-service/src/support/services/` returns four services;
`docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/support.md` anchors
`ADMIN-CRITICAL-010`, `ADMIN-CRITICAL-021`, `ADMIN-CRITICAL-022`.

**Closure criterion:** one owner per domain — the admin duplicates are deleted, the admin panel
reads the auth GraphQL operations, the three data-move migrations are renumbered above
`1808300000000` and are forward-only, `infrastructure/nats/services.yaml` grants the publish
subject, and `tests/invariants/domain-table-uniqueness.spec.ts` (chain-added) makes a second table
for one domain a build failure.

### ADMIN-HIGH-088 — admin-api still configures no NATS microservice transport

**Owner:** admin-expert · **Deadline:** 2026-10-01 · **Severity:** HIGH

`apps/admin-api-service/src/main.ts` (36 lines) passes no `natsTransport` to `createServiceApp`, so
`connectMicroservice()` is never called
(`libs/backend-common/src/bootstrap/create-service-app.ts:728`) and every `@EventPattern` consumer
in the service is dead code — including `tenant/handlers/tenant-onboarding-ack.handler.ts`, which
exists and is registered.

This is the one slice whose chain form must NOT be taken. The chain's `78d6d04c0` orders an
onboarding-ack barrier before tenant activation; main's `333df982c` (#1112) and `f1b5953e6` (#1151)
replaced ledger-trust with database verification in the provisioning saga, and those semantics win.
The live defect that survives both designs is narrower: a declared consumer with no transport.

**Evidence:** `grep -n natsTransport apps/admin-api-service/src/main.ts` returns nothing while
`apps/admin-api-service/src/tenant/handlers/tenant-onboarding-ack.handler.ts` exists.

**Closure criterion:** either the transport is wired and the handler proven live, or the handler is
deleted as superseded by the saga's DB verification — and the choice is made unrepeatable by
`tests/invariants/event-consumer-liveness.spec.ts` (chain-added), which fails the build when a
`PLATFORM_EVENT_REGISTRY`-declared consumer has no transport to receive on.

### ADMIN-HIGH-089 — analytics still reports fabricated numbers

**Owner:** admin-expert · **Deadline:** 2026-10-15 · **Severity:** HIGH

`apps/admin-api-service/src/analytics/services/analytics.service.ts:293` computes
`byRegion: { TR: total, EU: 0, US: 0, APAC: 0 }` — every tenant assigned to one region because no
region column exists — and persists it into `admin.analytics_snapshots`. The chain's analytics slice
is 20 commits: it deletes the unsourceable field and purges it from snapshots, makes "not
instrumented" representable so usage metrics stop inventing modules, reports churn as unmeasured
rather than proxying a last-write timestamp, reads the payments report from billing instead of
synthesising it, stops counting refunded invoices as outstanding receivables, retires a report
schedule nothing ever executed, and models PostgreSQL `date` columns as the string the driver
returns. Seven of the chain's ten migrations belong to this slice.

**Evidence:** `grep -n byRegion apps/admin-api-service/src/analytics/services/analytics.service.ts`;
`docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md` anchors
`ADMIN-HIGH-060`..`067`, `073`, `076`, `077` and eight MEDIUMs.

**Closure criterion:** every metric the analytics API returns is either measured or explicitly
`{ status: 'unavailable', reason }`; no fabricated field remains in the entity, the snapshot rows or
the frontend type; the purge migrations are renumbered above `1808300000000`.

### ADMIN-HIGH-090 — DB-explorer mask asymmetry, audit attribution and write capability

**Owner:** admin-expert · **Deadline:** 2026-10-15 · **Severity:** HIGH

The export half of this slice landed (`3040df8df`). Four chain commits did not:

- `531baf532` — the mask is one-way. `maskSensitiveData` replaces a sensitive column with
  `'********'` on read (`explorer.controller.ts:99,118`), and nothing stops that sentinel being
  written back over the real value, nor a real secret being egressed on a write response.
- `92e54156e` — DB-explorer read/export/raw-SQL audit rows are attributed to the literal string
  `'SUPER_ADMIN'` (`explorer.controller.ts`, `performedBy`) rather than the verified JWT actor, so
  the audit trail cannot name who read a table.
- `20e21cba0` — write controls render unconditionally and 403 when used, instead of being derived
  from the server's declared write capability.
- `f13164855` — `web/modules/admin-panel/src/services/types/database.ts` declares fields the backend
  entities do not have, so the pages read phantom values.

**Evidence:**
`grep -n "MASKED_VALUE\|performedBy" apps/admin-api-service/src/database-management/controllers/explorer.controller.ts`.

**Closure criterion:** the mask is symmetric (the sentinel is never persisted and a real secret
never leaves on a write path), every DB-explorer audit row carries the request-bound actor id, the
write controls are rendered from a server-declared capability, and
`tests/invariants/admin-database-types-parity.spec.ts` (chain-added) pins the frontend types to the
entities.

### ADMIN-MEDIUM-091 — the ADMIN registry sequence band 003–085 is claimed by a document, not the ledger

**Owner:** context-manager · **Deadline:** 2026-10-01 · **Severity:** MEDIUM

`finding-registry`'s allocator treats the numeric SEQUENCE as the identity, not the full id string:
`ADMIN-MEDIUM-004` and `ADMIN-HIGH-004` cannot both exist. The imported 2026-07-20 audit anchors 85
findings across sequences 003–085, while main independently allocated `ADMIN-HIGH-004`..`007` for
different findings during the same period. Four of the chain's rows (`ADMIN-MEDIUM-004`,
`ADMIN-MEDIUM-005`, `ADMIN-CRITICAL-006`, `ADMIN-CRITICAL-007`) can therefore never be imported
under their own ids.

This pass registered only the two rows its commits needed — `ADMIN-MEDIUM-084` and `ADMIN-HIGH-036`,
both anchored in the imported documents and both on free sequences — rather than importing the
chain's 85-row ledger fork. The full extracted set is at `…/scratchpad/r1034/branch-findings.jsonl`
(85 rows).

**Closure criterion:** a decision recorded on the ADMIN band — either the four colliding audit
findings are renumbered in the imported document and the remaining 81 rows imported, or the band is
declared document-only and the audit's anchors are annotated as such. Until then, allocate new ADMIN
findings at 086 or above.

### ADMIN-MEDIUM-092 — none of the chain's ten admin-api migrations are ported

**Owner:** admin-expert · **Deadline:** with the slice that needs it · **Severity:** MEDIUM

Every one of the chain's migrations belongs to a slice this pass did not land, so none was ported
and none was renumbered. They are recorded here so the next pass does not rediscover the collision.

| Chain file                                                     | Owning slice | Disposition                                                                                        |
| -------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `1801600000000-DropImpersonationSessionsWriteGuard`            | APA-288      | **Prefix collision** with this head's `1801600000000-HardenTenantSchemaIdentityMapping`; renumber. |
| `1801700000000-MigrateAnnouncementsToAuth`                     | GAP-02       | Copy-then-drop; forward-only; needs admin-api INSERT on `auth.*`.                                  |
| `1801800000000-MigrateSupportTicketsToAuth`                    | GAP-02       | Copy-then-drop; forward-only; needs admin-api INSERT on `auth.*`.                                  |
| `1801900000000-MigrateSupportMessagingToAuth`                  | GAP-02       | Copy-then-drop; forward-only; needs admin-api INSERT on `auth.*`.                                  |
| `1802000000000-PurgeFabricatedByRegionFromAnalyticsSnapshots`  | GAP-04       | Purge; target column still present on this head.                                                   |
| `1802100000000-PurgeFabricatedUsageMapsFromAnalyticsSnapshots` | GAP-04       | Purge; target column still present on this head.                                                   |
| `1802200000000-PurgeChurnProxyFromAnalyticsSnapshots`          | GAP-04       | Purge; target column still present on this head.                                                   |
| `1802300000000-RetireUnexecutedReportSchedule`                 | GAP-04       | Drop; the schedule surface still exists on this head.                                              |
| `1802400000000-AddReportExecutionUnavailableReason`            | GAP-04       | Additive column.                                                                                   |
| `1802500000000-AddReportExecutionPreviewRows`                  | GAP-04       | Additive column.                                                                                   |

**Closure criterion:** each migration lands with its slice, renumbered above this head's newest
admin-api migration (`1808300000000` as of `3040df8df`), never by editing an existing file.

## Required follow-up before this branch is green

`docs/plans/2026-06-18-enterprise-grade-debt-closure/{manifest.json,README.md,finding-truth-table.md}`
mirror five numbers out of the registry, and
`tests/invariants/enterprise-grade-debt-plan-contract.spec.ts` asserts they agree. This pass added
two registry rows, so that spec is red on the tip hash. This pass is not permitted to edit the
mirrors, and the repin is one idempotent command that only rewrites the mirrored values:

```bash
npm run gates:debt-plan:repin
npx jest --config tests/invariants/jest.config.ts \
  --runTestsByPath tests/invariants/enterprise-grade-debt-plan-contract.spec.ts
```

Registry state after this pass: 1615 entries, tip
`473d7634cb00a4e0baaae3f0dd401b4d5623e6e1b48326949c03e89470dc1eed`, active CRITICAL count unchanged
(both new rows are HIGH and MEDIUM), so the repin tool's CRITICAL-change refusal does not fire.
