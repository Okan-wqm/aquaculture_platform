# Package 10: hr-leave-approval-race

## Metadata
Status: PENDING
Estimated Tokens: 6K
Priority: CRITICAL
Security-Sensitive: no
Parallelizable: yes (Sprint 1)
Prerequisites: none
Sprint: 1
Closing-Findings: [HR-CRITICAL-006]
Source-Reviews: [user-provided finding list 2026-04-09]

## Context
The approve-leave-request handler reads the leave balance, checks availability, and approves without a pessimistic lock. Two concurrent approval requests for the same employee can both read sufficient balance and both approve, resulting in negative leave balance (employee gets more leave than entitled). In aquaculture with minimum staffing requirements, this can leave a facility understaffed.

## Findings
- **HR-CRITICAL-006**: Leave approve no pessimistic lock -- concurrent approval race condition
  - File: `apps/hr-service/src/leave/handlers/approve-leave-request.handler.ts` (~4.4K chars)
  - Read-check-write without FOR UPDATE lock
  - Root cause: missing pessimistic locking on balance check

## Affected Files
- `/var/aqua-saas/apps/hr-service/src/leave/handlers/approve-leave-request.handler.ts` (~4.4K chars)

## Dependencies
None.

## Atomic Commit Plan
```
fix(hr): add pessimistic lock to leave approval preventing double-approval race

Add FOR UPDATE pessimistic lock when reading the employee's leave
balance in approve-leave-request handler. This serializes concurrent
approval attempts, preventing negative balance from race conditions.

Closes: docs/reviews/2026-04-09-critical-fixes#HR-CRITICAL-006
Plan: docs/plans/2026-04-09-critical-fixes/packages/10-hr-leave-approval-race.md
```

## Test Plan
- Unit test: single approval with sufficient balance -- approved
- Unit test: single approval with insufficient balance -- rejected
- Integration test: two concurrent approvals for same employee with balance=1 day -- only one approved
- Verify: pessimistic_write lock mode used in findOne query

## Verification Command
```bash
cd /var/aqua-saas && npx jest --testPathPattern="apps/hr-service/src/leave" --coverage=false
```

## Rollback Plan
```
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
