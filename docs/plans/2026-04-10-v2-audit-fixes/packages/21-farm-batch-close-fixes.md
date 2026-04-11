# Package 21: farm-batch-close-fixes

## Metadata
Status: PENDING
Estimated Tokens: 14K
Priority: HIGH
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none
Sprint: 1

## Closing-Findings
Closing-Findings: [farm-expert/HIGH-001, farm-expert/HIGH-002]

## Source-Reviews
- /var/aqua-saas/docs/reviews/farm-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
Two related defects in the batch close flow: (1) `closeBatch` allows premature closure via `BatchCloseReason.OTHER` from any non-closed status, bypassing the lifecycle invariant; (2) the resolver passes `CloseBatchCommand` constructor arguments in the wrong order, storing `user.sub` as `notes` and notes as `closedBy`, corrupting the audit trail. These share the same file locality (batch resolver, command, handler).

## Findings
`HIGH-001` (farm-expert): `closeBatch` still allows premature closure via `OTHER`. Files: `apps/farm-service/src/batch/resolvers/batch.resolver.ts:335`, `apps/farm-service/src/batch/commands/close-batch.command.ts:11`, `apps/farm-service/src/batch/entities/batch.entity.ts:423`, `apps/farm-service/src/batch/handlers/close-batch.handler.ts:71`. An ACTIVE batch can be forced directly to CLOSED without the strict lifecycle path.

`HIGH-002` (farm-expert): `CloseBatchCommand` arguments are passed in the wrong order. Files: `apps/farm-service/src/batch/resolvers/batch.resolver.ts:337`, `apps/farm-service/src/batch/commands/close-batch.command.ts:19`, `apps/farm-service/src/batch/handlers/close-batch.handler.ts:46`. `user.sub` is stored as `notes`, and the free-text notes are stored as `closedBy`.

## Affected Files
- /var/aqua-saas/apps/farm-service/src/batch/resolvers/batch.resolver.ts
- /var/aqua-saas/apps/farm-service/src/batch/commands/close-batch.command.ts
- /var/aqua-saas/apps/farm-service/src/batch/handlers/close-batch.handler.ts
- /var/aqua-saas/apps/farm-service/src/batch/entities/batch.entity.ts

## Dependencies
None. Package 22 (farm-tank-capacity-enforcement) depends on this package.

## Atomic Commit Plan
```
fix(farm): restrict closeBatch OTHER reason and fix argument ordering

closeBatch allowed premature closure via BatchCloseReason.OTHER from any
status, bypassing the lifecycle invariant. The resolver also passed
CloseBatchCommand arguments in the wrong order, storing user.sub as
notes and notes as closedBy, corrupting the batch audit trail.

This restricts OTHER to an admin-only override path, enforces the entity
transition contract in the handler, and replaces positional construction
with a typed options object to prevent future argument transposition.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/21-farm-batch-close-fixes.md
Closes: docs/reviews/farm-expert/2026-04-10-full-repo-audit.md#HIGH-001
Closes: docs/reviews/farm-expert/2026-04-10-full-repo-audit.md#HIGH-002
```

## Test Plan
- Unit test: MODULE_USER cannot close an ACTIVE batch with reason OTHER.
- Unit test: ADMIN can close with reason OTHER via the override path.
- Unit test: closedBy field contains user.sub, not notes text.
- Unit test: statusReason field contains notes text, not user.sub.
- Regression test: full lifecycle close (harvest) still works.

## Verification Command
`npx tsc --noEmit -p apps/farm-service/tsconfig.json && npx jest --testPathPattern="apps/farm-service/src/batch" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

