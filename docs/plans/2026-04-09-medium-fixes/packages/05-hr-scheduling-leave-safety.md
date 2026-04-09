# Package 05: hr-scheduling-leave-safety

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 20K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none

## Closing-Findings
Closing-Findings: [HR-MEDIUM-002, HR-MEDIUM-003, HR-MEDIUM-004, HR-MEDIUM-005, HR-MEDIUM-006]

## Source-Reviews
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Context
Five HR findings cover scheduling/leave domain integrity gaps: leave overlap detection is app-level only (no DB constraint), shift times lack timezone, state machine transitions have no guard map, STCW BST is not modeled, and schema name interpolation risks SQL injection. Grouped by shared domain (HR scheduling/leave) and file locality.

## Findings

**HR-MEDIUM-002 — Leave overlap detection is application-level only**
`submit-leave-request.handler.ts` checks for overlapping leave dates in TypeScript before insert. Without a database exclusion constraint (`EXCLUDE USING gist`), two concurrent requests can both pass the check and create overlapping leaves. Add a DB-level date range exclusion constraint.

**HR-MEDIUM-003 — Shift time type has no timezone**
`weekly-plan-entry.entity.ts` stores shift start/end as `time` without time zone. When employees move between sites in different timezones, shift boundaries are ambiguous. Use `timetz` or store as `timestamptz` with the work site's timezone.

**HR-MEDIUM-004 — No state machine enum map for leave/rotation transitions**
Leave request and rotation state transitions are handled by `if/else` chains in handlers. There is no centralized transition map (e.g., `PENDING -> APPROVED | REJECTED`, `APPROVED -> CANCELLED`). Invalid transitions are caught only by accident. Add a `StateTransitionMap` with `canTransition(from, to): boolean`.

**HR-MEDIUM-005 — STCW Basic Safety Training not modeled**
Maritime crew must hold STCW BST certification. The training module has generic `CertificationType` but no specific STCW BST entity or validation. Aquaculture operations on marine sites require this. Model as a `CertificationType` seed with `isSTCW: true` flag and validation in crew assignment.

**HR-MEDIUM-006 — Schema name interpolation in dynamic query**
`schema-migration.service.ts` (or tenant provisioning) interpolates the tenant schema name directly into SQL: `` `CREATE SCHEMA ${schemaName}` ``. If `schemaName` contains special characters, this is SQL injection. Use parameterized DDL or strict alphanumeric validation on schema names.

## Affected Files
- apps/hr-service/src/leave/handlers/submit-leave-request.handler.ts
- apps/hr-service/src/leave/entities/leave-request.entity.ts
- apps/hr-service/src/scheduling/entities/weekly-plan-entry.entity.ts
- apps/hr-service/src/leave/leave-state-machine.ts (new file or inline in existing)
- apps/hr-service/src/training/entities/certification-type.entity.ts
- apps/hr-service/src/aquaculture/handlers/ (crew assignment validation)
- apps/admin-api-service/src/modules/tenant-management/services/schema-migration.service.ts

## Dependencies
None. HR service is self-contained; admin-api-service schema-migration is an isolated fix.

## Atomic Commit Plan
```
fix(hr): add leave overlap exclusion constraint, shift tz, state machine map, STCW BST model, schema name validation

Leave overlap was app-level only — add EXCLUDE USING gist on (employee_id, daterange).
Shift times lacked timezone — migrate to timestamptz.
State transitions were ad-hoc if/else — add StateTransitionMap with explicit valid transitions.
STCW BST not modeled — add isSTCW flag to CertificationType and validate on crew assignment.
Schema name interpolation risked SQL injection — add strict /^[a-z][a-z0-9_]{0,62}$/ validation.

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-MEDIUM-002
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-MEDIUM-003
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-MEDIUM-004
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-MEDIUM-005
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-MEDIUM-006
Plan: docs/plans/2026-04-09-medium-fixes/packages/05-hr-scheduling-leave-safety.md
```

## Test Plan
- Unit test: two overlapping leave requests — second fails at DB constraint level
- Unit test: StateTransitionMap rejects invalid transition (e.g., REJECTED -> APPROVED)
- Unit test: schema name with special characters is rejected
- Migration test: weekly_plan_entry.shift_start/shift_end columns are timestamptz
- Integration test: crew assignment to marine site requires STCW BST certification

## Verification Command
`npx tsc --noEmit -p apps/hr-service/tsconfig.json && npx jest --testPathPattern="apps/hr-service/src/(leave|scheduling|training|aquaculture)" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
