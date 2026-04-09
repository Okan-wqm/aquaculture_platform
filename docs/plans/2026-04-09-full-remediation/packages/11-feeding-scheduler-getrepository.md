# Package 11: feeding-scheduler-getrepository

## Metadata
Status: PENDING
Estimated Tokens: 20K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none

## Context
The feeding-scheduler.service.ts in farm-service has 9 raw `getRepository()` calls in cron job code. While auth-security-expert confirmed these are FALSE POSITIVE for tenant bypass (they explicitly set search_path and include tenantId in WHERE clauses), they violate the CLAUDE.md `getRepository()` ban. In aquaculture, incorrect feeding schedules are a life-safety concern. Migrating to `getScopedRepository()` adds an additional safety layer.

## Findings

**MEDIUM-008 [farm-expert]: feeding-scheduler.service.ts has 9 raw getRepository() calls**
- File: `apps/farm-service/src/scheduler/feeding-scheduler.service.ts`
- Lines: 1158, 1215, 1299, 1303, 1355, 1411, 1442, 1483, 1487
- All within cron job code with explicit `SET search_path` before calls
- auth-security-expert verdict: "FALSE POSITIVE — Architecturally correct cron-job pattern with manual search_path management"
- Still violates CLAUDE.md code style rule: `getRepository()` YASAK -> `getScopedRepository()` kullan

Closing-Findings: [MEDIUM-008]
Source-Reviews:
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md
- docs/reviews/auth-security-expert/2026-04-09-getrepository-bypass-validation.md

## Affected Files
- `/var/aqua-saas/apps/farm-service/src/scheduler/feeding-scheduler.service.ts`

## Dependencies
None. The existing cron-job pattern works correctly; this is a code style migration to the canonical `getScopedRepository()` API.

Note: This file is 55925 bytes (~16K tokens). The package is near the 20K source token bound. Executor should focus narrowly on the 9 call sites and avoid loading the entire file if possible.

## Atomic Commit Plan
```
refactor(farm): migrate feeding-scheduler getRepository to getScopedRepository

Replace 9 bare getRepository() calls with getScopedRepository() in
cron job code. The existing manual SET search_path + tenantId WHERE
pattern is functionally correct (confirmed by auth-security-expert),
but violates CLAUDE.md repository access rules. getScopedRepository()
provides identical tenant scoping with less boilerplate and defense-
in-depth.

Plan: docs/plans/2026-04-09-full-remediation/packages/11-feeding-scheduler-getrepository.md

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-008
```

## Test Plan
- Verify compilation: `npx tsc --noEmit -p apps/farm-service/tsconfig.json`
- Run feeding-scheduler tests: `npx jest --testPathPattern="apps/farm-service/src/scheduler"`
- Grep to confirm no bare `getRepository()` remains in the file

## Verification Command
`npx tsc --noEmit -p apps/farm-service/tsconfig.json && npx jest --testPathPattern="apps/farm-service/src/scheduler" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
