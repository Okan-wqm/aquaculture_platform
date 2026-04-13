# Package 06: task-event-integrity

## Metadata
Status: PENDING
Estimated Tokens: ~15K
Priority: HIGH
Security-Sensitive: no
Parallelizable: yes (with 04, 05)
Prerequisites: 01-nats-edge-device-tenant-scoped-routing, 02-user-deleted-tenant-verification, 03-mobile-settings-role-enforcement

## Source Reviews
- docs/test-audits/workflow-state-auditor/2026-04-11-full-platform-e2e.md
- docs/test-audits/context-manager/2026-04-11-full-platform-e2e.md

## Closing Findings
Closing-Findings: [workflow-state-auditor/HIGH-001, workflow-state-auditor/HIGH-002]

## Context

**IMPORTANT (verified by senior engineer — planner missed this):**

Farm-service already has `@platform/outbox` infrastructure fully wired:
- `FarmOutboxModule` registered globally at `apps/farm-service/src/outbox/farm-outbox.module.ts`
- `OutboxPublisher` already injected and used in: `create-harvest-record.handler.ts`, `record-mortality.handler.ts`, `allocate-to-tank.handler.ts`, `create-feeding-record.handler.ts`, `transfer-batch.handler.ts`, `record-cull.handler.ts`, `create-batch.handler.ts`, `update-batch-status.handler.ts`, and `water-quality.service.ts`
- `task.service.ts` is the ONLY remaining handler still using the old direct `eventBus.publish()` pattern

Two related bugs in task.service.ts task lifecycle methods:
1. Task state is saved BEFORE event publish. Event publish is wrapped in try/catch that only logs a warning. If event publish fails, the task state advances but downstream consumers miss the transition. **The fix is to migrate to `OutboxPublisher.enqueue()` within the same transaction**, consistent with every other farm-service handler.
2. The `startTask` method hardcodes `previousStatus: TaskStatus.PENDING` but also accepts `TaskStatus.OVERDUE` tasks (line 358). Fix: capture `task.status` before mutation.

Both bugs share root cause in the same method region (lines 326-383) and should be fixed atomically.

## Findings
workflow-state-auditor HIGH-001: Task lifecycle event publish can fail silently while state advances.
- File: `apps/farm-service/src/task/services/task.service.ts` lines 326-342 (completeTask), 365-380 (startTask)
- Task save happens first, then event publish in try/catch that only logs a warning. If event publish fails, task state advances but downstream consumers miss the transition.
- Severity: HIGH
- Gap class: write-gap, sync-gap, visibility-gap

workflow-state-auditor HIGH-002: startTask emits wrong previousStatus for overdue tasks.
- File: `apps/farm-service/src/task/services/task.service.ts` line 374
- `previousStatus` is hardcoded as `TaskStatus.PENDING` but the method also accepts `TaskStatus.OVERDUE` (line 358). Overdue task starts emit incorrect event history.
- Severity: HIGH
- Gap class: write-gap, sync-gap, visibility-gap

## Affected Files
- apps/farm-service/src/task/services/task.service.ts (primary -- modify completeTask lines 326-346, startTask lines 351-383)

## Dependencies
Prerequisites: Tier 1 packages (01, 02, 03) must be committed first (security-first ordering).
This package touches only the farm-service. No shared lib changes.

## Atomic Commit Plan
```
fix(farm): migrate task events to OutboxPublisher and fix previousStatus

Two bugs in task lifecycle methods:

1. completeTask and startTask save state before publishing the event,
   then swallow publish failures with a warn log. Migrate to
   OutboxPublisher.enqueue() within the same QueryRunner transaction,
   consistent with every other farm-service handler (harvest, mortality,
   feeding, allocation, etc.). This guarantees the event is committed
   atomically with the state change.

2. startTask hardcodes previousStatus as TaskStatus.PENDING, but also
   accepts OVERDUE tasks. Fix: capture task.status before mutation and
   use it as previousStatus in the TaskStatusChanged event.

Addresses: workflow-state-auditor/HIGH-001, workflow-state-auditor/HIGH-002

Plan: docs/plans/2026-04-13-e2e-audit-fixes/packages/06-task-event-integrity.md
Closes: docs/test-audits/workflow-state-auditor/2026-04-11-full-platform-e2e.md#HIGH-001
Closes: docs/test-audits/workflow-state-auditor/2026-04-11-full-platform-e2e.md#HIGH-002
```

## Test Plan
- Unit test: startTask on an OVERDUE task. Assert the enqueued TaskStatusChanged event has `previousStatus: TaskStatus.OVERDUE`.
- Unit test: startTask on a PENDING task. Assert the enqueued TaskStatusChanged event has `previousStatus: TaskStatus.PENDING`.
- Unit test: verify completeTask enqueues TaskCompleted event via OutboxPublisher within the same transaction (no direct eventBus.publish call).
- Unit test: verify startTask enqueues TaskStatusChanged event via OutboxPublisher within the same transaction.
- Unit test: if the transaction rolls back, verify the outbox row is also rolled back (no orphaned event).
- Existing completeTask and startTask happy-path tests must continue to pass.
- Reference pattern: `apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts` (exemplary OutboxPublisher usage)

## Verification Command
`npx tsc --noEmit -p apps/farm-service/tsconfig.json && npx jest --testPathPattern="apps/farm-service/src/task" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
