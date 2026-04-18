# Package 10: hr-outbox-migration

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 18K
Priority: CRITICAL
Security-Sensitive: no
Parallelizable: no
Prerequisites: 09-hr-audit-log-coverage
Sprint: 0

## Closing-Findings
Closing-Findings: [hr-expert/CRITICAL-002]

## Source-Reviews
- /var/aqua-saas/docs/reviews/hr-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
The HR service registers `OutboxModule.forFeature(HrOutbox)` but all active handlers still call `eventBus.publish()` directly after commit. If the process dies between commit and publish, downstream consumers never receive the event. This undermines the outbox contract and leaves the HR domain with at-most-once event delivery instead of the intended at-least-once guarantee.

## Findings
`CRITICAL-002` (hr-expert): HR events still bypass the transactional outbox. Files: `apps/hr-service/src/app.module.ts:280-284`, `apps/hr-service/src/hr/handlers/create-employee.handler.ts:80-87`, `apps/hr-service/src/hr/handlers/update-employee.handler.ts:102-132`, `apps/hr-service/src/hr/handlers/approve-payroll.handler.ts:68-98`, `apps/hr-service/src/leave/handlers/submit-leave-request.handler.ts:76-79`, `apps/hr-service/src/attendance/handlers/clock-in.handler.ts:289-292`.

## Affected Files
- /var/aqua-saas/apps/hr-service/src/hr/handlers/create-employee.handler.ts
- /var/aqua-saas/apps/hr-service/src/hr/handlers/update-employee.handler.ts
- /var/aqua-saas/apps/hr-service/src/hr/handlers/approve-payroll.handler.ts
- /var/aqua-saas/apps/hr-service/src/leave/handlers/submit-leave-request.handler.ts
- /var/aqua-saas/apps/hr-service/src/attendance/handlers/clock-in.handler.ts

## Dependencies
09-hr-audit-log-coverage -- both packages modify the same HR handler files. Audit log decorators must be in place before refactoring the event publishing path to avoid merge conflicts and to ensure audit coverage is not lost during the outbox migration.

## Atomic Commit Plan
```
fix(hr): migrate event publishing from fire-and-forget to transactional outbox

HR mutation handlers called eventBus.publish() directly after commit,
bypassing the registered OutboxModule. If the process died between
commit and publish, downstream consumers never received the event. This
replaces all direct publish calls with outbox.enqueue() inside the same
DB transaction as the domain write, ensuring at-least-once delivery.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/10-hr-outbox-migration.md
Closes: docs/reviews/hr-expert/2026-04-10-full-repo-audit.md#CRITICAL-002
```

## Test Plan
- Unit test per handler: verify `eventBus.publish()` is not called directly.
- Unit test per handler: verify outbox.enqueue() is called within the same transaction.
- Integration test: committed domain write survives a simulated worker restart.
- Negative test: handler without outbox enqueue fails linting/test.

## Verification Command
`npx tsc --noEmit -p apps/hr-service/tsconfig.json && npx jest --testPathPattern="apps/hr-service/src" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

