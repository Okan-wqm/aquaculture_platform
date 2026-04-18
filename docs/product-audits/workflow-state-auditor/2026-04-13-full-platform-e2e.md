# Workflow State Audit

Topic: `2026-04-13-full-platform-e2e`
Scope: `apps/**`, `web/**`, `libs/**`
Prior cycle: `2026-04-11-full-platform-e2e` (HIGH-001 through HIGH-004 all resolved in commit 79ce984f)

## Prior Cycle Verification

All four findings from the 2026-04-11 cycle are confirmed resolved:

- **HIGH-001 (task event silent fail):** `completeTask` and `startTask` now use `OutboxPublisher.enqueue()` inside a transaction (lines 336-347, 386-395 of `apps/farm-service/src/task/services/task.service.ts`). Events are atomic with the domain write.
- **HIGH-002 (previousStatus hard-coded):** `startTask` now captures `const previousStatus = task.status` at line 376 before mutation and passes the real value at line 391. Correct for both PENDING and OVERDUE origins.
- **HIGH-003 (maintenance resurrect decommissioned):** `setMaintenanceMode` now guards `if (device.lifecycleState === DeviceLifecycleState.DECOMMISSIONED) throw` at line 563 of `apps/sensor-service/src/edge-device/edge-device.service.ts`.
- **HIGH-004 (archive-channel leftAt):** `ArchiveChannelHandler` now uses `leftAt: IsNull()` at line 53 of `apps/messaging-service/src/channel/commands/archive-channel.handler.ts`, matching the rest of the membership queries.

---

## New Findings

### HIGH-001: `completeTask` bypasses VALID_TRANSITIONS -- allows PENDING to COMPLETED directly

**Severity:** HIGH

The `TaskService.VALID_TRANSITIONS` map at line 37 of `apps/farm-service/src/task/services/task.service.ts` declares that PENDING can only transition to IN_PROGRESS or CANCELLED:

```typescript
[TaskStatus.PENDING]: [TaskStatus.IN_PROGRESS, TaskStatus.CANCELLED],
```

However, `completeTask()` (line 310-357) does NOT consult this transition map. Its guard logic only rejects COMPLETED and CANCELLED:

```typescript
if (task.status === TaskStatus.COMPLETED) { throw ... }
if (task.status === TaskStatus.CANCELLED) { throw ... }
```

This means PENDING -> COMPLETED is allowed by `completeTask`, contradicting the declared state machine. The mobile UI (`web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx`, line 378) shows a "Complete" button for PENDING tasks, actively encouraging this invalid transition.

**Impact:** The task lifecycle has two conflicting sources of truth. The `update()` method enforces VALID_TRANSITIONS (line 133), while `completeTask()` uses ad-hoc guards that permit a transition the formal state machine forbids. Any consumer relying on the transition map for invariants (audit reconstructors, projections) will encounter states that should be impossible.

**Cross-domain:** `button-action-auditor` (mobile UI encourages the bypass)

---

### HIGH-002: Equipment update handler bypasses tank `canTransitionTo` validation entirely

**Severity:** HIGH

`UpdateEquipmentHandler.updateTank()` at lines 428-448 of `apps/farm-service/src/equipment/handlers/update-equipment.handler.ts` maps an incoming equipment status string to a `TankStatus` and directly assigns it:

```typescript
if (input.status !== undefined) {
  const statusMapping: Record<string, TankStatus> = { ... };
  const mappedStatus = statusMapping[input.status.toLowerCase()];
  if (mappedStatus) {
    tank.status = mappedStatus;    // NO canTransitionTo() check
    tank.statusChangedAt = new Date();
  }
}
```

The `UpdateTankStatusHandler` (line 45) correctly calls `tank.canTransitionTo(input.status)` before allowing a transition. But the equipment update path is a parallel entry point that skips this validation entirely.

This means any tank status -- including transitions from ACTIVE to INACTIVE, or from HARVESTING to ACTIVE -- can be performed through the equipment GraphQL mutation without lifecycle enforcement. The transition map defined in `Tank.canTransitionTo()` (lines 610-628 of `apps/farm-service/src/tank/entities/tank.entity.ts`) is dead code for this code path.

**Impact:** The equipment update route provides an unrestricted status-change backdoor for tanks. A client can set any status regardless of the current state, defeating the tank lifecycle invariants.

**Cross-domain:** `form-write-auditor`

---

### HIGH-003: Employee status has no transition validation -- any status can be set via update

**Severity:** HIGH

`UpdateEmployeeHandler` at lines 88-92 of `apps/hr-service/src/hr/handlers/update-employee.handler.ts` uses `Object.assign(employee, updateData)` to apply the input, including the `status` field. The input DTO (`apps/hr-service/src/hr/dto/update-employee.input.ts`, line 14) accepts any `EmployeeStatus` enum value.

There is no transition validation whatsoever. The employee status enum has four values: ACTIVE, ON_LEAVE, TERMINATED, SUSPENDED. All transitions are silently allowed, including:

- TERMINATED -> ACTIVE (re-hiring a terminated employee without a proper re-hire flow)
- SUSPENDED -> ON_LEAVE (bypassing the suspension)
- ON_LEAVE -> TERMINATED (without the formal termination event side effects)

The handler only detects the TERMINATED transition for event publishing (line 104), but does not prevent invalid reverse transitions.

**Impact:** Employee lifecycle has zero backend enforcement. Any status value accepted by the enum can be set from any other status, which defeats HR compliance invariants and can produce incorrect EmployeeTerminated events (e.g., toggling ACTIVE -> TERMINATED -> ACTIVE -> TERMINATED would emit multiple termination events for the same employee).

**Cross-domain:** `form-write-auditor`

---

### HIGH-004: Cancel-leave-request publishes event AFTER commit via fire-and-forget eventBus, not transactional outbox

**Severity:** HIGH

`CancelLeaveRequestHandler` at line 129 of `apps/hr-service/src/leave/handlers/cancel-leave-request.handler.ts` publishes the `LeaveCancelledEvent` via `this.eventBus.publish()` AFTER the transaction has been committed (line 124: `await queryRunner.commitTransaction()`). This uses `@nestjs/cqrs` `EventBus`, not the `OutboxPublisher`.

In contrast, `ApproveLeaveRequestHandler` at line 104 of `apps/hr-service/src/leave/handlers/approve-leave-request.handler.ts` correctly uses `this.outboxPublisher.enqueue(approvedEvent, queryRunner.manager)` inside the transaction before commit.

If the cancel-leave eventBus publish fails (NATS down, service crash after commit), the domain state (CANCELLED) has already been committed but downstream consumers never learn about it. The balance has been restored, the request is cancelled, but notification, audit, and projection consumers miss the event with no retry mechanism.

**Evidence:**
- `apps/hr-service/src/leave/handlers/cancel-leave-request.handler.ts:129` -- `await this.eventBus.publish(...)` outside transaction
- `apps/hr-service/src/leave/handlers/approve-leave-request.handler.ts:104` -- `await this.outboxPublisher.enqueue(...)` inside transaction

**Impact:** Asymmetric delivery guarantee within the same bounded context. Approvals have at-least-once delivery via outbox; cancellations have at-most-once delivery via direct publish. This is the same class of bug as prior-cycle HIGH-001 (task event silent fail), now in the leave domain.

**Cross-domain:** `form-write-auditor`

---

### HIGH-005: Goal `updateGoal` handler accepts any status without transition validation

**Severity:** HIGH

`UpdateGoalHandler` at line 39 of `apps/hr-service/src/performance/handlers/update-goal.handler.ts` accepts a `status` field and applies it directly:

```typescript
if (status !== undefined) goal.status = status;
```

The only guard is a check that the goal is not already COMPLETED or CANCELLED (line 31). This means:

- DEFERRED -> COMPLETED is allowed (bypassing the `completeGoal` handler's proper key-result/milestone completion)
- IN_PROGRESS -> NOT_STARTED is allowed (rollback without audit)
- NOT_STARTED -> DEFERRED is allowed (bypassing the `deferGoal` handler's date and reason tracking)

The dedicated `CompleteGoalHandler` and `DeferGoalHandler` exist with proper business logic and side effects, but the generic `updateGoal` path bypasses them all.

**Impact:** The goal lifecycle can be manipulated via the generic update mutation, skipping the dedicated handlers' business rules (key-result completion, milestone completion, target-date enforcement). This creates inconsistent goal state where `progressPercent`, `completedDate`, `keyResults`, and `milestones` are out of sync with the reported status.

**Cross-domain:** `form-write-auditor`

---

### MEDIUM-001: Alert incident `suppress()` has no state guard -- can suppress RESOLVED or CLOSED incidents

**Severity:** MEDIUM

The `suppress()` method at line 338 of `apps/alert-engine/src/database/entities/alert-incident.entity.ts` unconditionally sets `this.status = IncidentStatus.SUPPRESSED` without checking the current status:

```typescript
suppress(userId: string, reason?: string): void {
  this.status = IncidentStatus.SUPPRESSED;  // No guard
  ...
}
```

Compare with `acknowledge()` (line 247) and `startInvestigation()` (line 273) which both check `!this.isOpen()`, and `resolve()` (line 290) which checks `this.isClosed()`. The `suppress` method is the only transition action without any state guard.

This means a RESOLVED or CLOSED incident can be moved to SUPPRESSED, which breaks the terminal-state semantics. The `isClosed()` helper (line 225) includes SUPPRESSED as a closed state, so this creates a path between two "closed" states without a reopen step.

**Impact:** A suppression can be applied to an already-resolved incident, overwriting the resolution metadata (resolvedBy, resolvedAt remain but the status no longer reflects RESOLVED). Audit consumers see a RESOLVED -> SUPPRESSED transition that the incident lifecycle does not formally allow.

**Cross-domain:** `button-action-auditor`

---

### MEDIUM-002: Tank transition map divergence between entity and handler

**Severity:** MEDIUM

The `Tank.canTransitionTo()` method at line 611 of `apps/farm-service/src/tank/entities/tank.entity.ts` includes FALLOW in the ACTIVE transitions and FALLOW/MAINTENANCE in the CLEANING transitions:

```typescript
[TankStatus.ACTIVE]: [HARVESTING, MAINTENANCE, QUARANTINE, FALLOW],
[TankStatus.CLEANING]: [PREPARING, MAINTENANCE, FALLOW],
```

The `UpdateTankStatusHandler.getAllowedTransitions()` at line 114 of `apps/farm-service/src/tank/handlers/update-tank-status.handler.ts` has a different map:

```typescript
[TankStatus.ACTIVE]: [HARVESTING, MAINTENANCE, QUARANTINE],  // missing FALLOW
[TankStatus.CLEANING]: [PREPARING, MAINTENANCE],              // missing FALLOW
```

The handler correctly calls `tank.canTransitionTo()` for enforcement (line 45), so the entity's map is the source of truth. But the handler's `getAllowedTransitions()` is used to generate the error message (line 48). A user who attempts ACTIVE -> FALLOW will succeed, but the error for ACTIVE -> INACTIVE will show an incomplete list of allowed transitions that omits FALLOW.

**Impact:** Misleading error messages. Not a data integrity issue since the entity method is the enforcement layer, but the handler's duplicate map is a maintenance hazard -- it will diverge further as new transitions are added to the entity.

**Cross-domain:** N/A

---

### MEDIUM-003: Task overdue cron event publish is fire-and-forget, not outbox-backed

**Severity:** MEDIUM

The `detectOverdueTasks` cron at line 592-612 of `apps/farm-service/src/task/services/task.service.ts` publishes `TaskOverdue` events via `this.eventBus.publish()` with a try/catch that only logs warnings. The status UPDATE is committed via raw SQL (`UPDATE tasks SET status = $1 ...` at line 579) but the event is published after the fact, outside any transaction.

While the `completeTask` and `startTask` methods were fixed to use the outbox (prior-cycle HIGH-001 resolution), the overdue detection cron was not migrated. If the NATS publish fails for any task, the task's status is already OVERDUE in the database but downstream consumers miss the notification.

**Evidence:**
- `apps/farm-service/src/task/services/task.service.ts:599` -- `await this.eventBus.publish(...)` outside transaction
- `apps/farm-service/src/task/services/task.service.ts:608-611` -- catch logs warning and continues

**Impact:** TaskOverdue events are at-most-once delivery. Since overdue detection is the trigger for escalation notifications and dashboard alerts, a lost event means the field crew may not be notified about overdue tasks. Lower severity than HIGH-001 was because the cron re-runs every 30 minutes, so the UPDATE itself is idempotent, but the event may never be delivered for a specific task if the eventBus is persistently down during the window.

**Cross-domain:** `list-visibility-auditor`

---

### MEDIUM-004: Billing subscription lifecycle events use fire-and-forget NATS, not transactional outbox

**Severity:** MEDIUM

All billing-service handlers publish events via direct `this.eventBus?.publish()` outside (or after) the transaction, with try/catch that swallows failures:

- `CancelSubscriptionHandler` -- line 88 of `apps/billing-service/src/billing/handlers/cancel-subscription.handler.ts`
- `ChangeSubscriptionPlanHandler` -- line 224 of `apps/billing-service/src/billing/handlers/change-subscription-plan.handler.ts`
- `CreateSubscriptionHandler` -- line 164 of `apps/billing-service/src/billing/handlers/create-subscription.handler.ts`
- `BillingSchedulerService` -- lines 78, 151 of `apps/billing-service/src/billing/billing-scheduler.service.ts`

The billing-service has no `OutboxPublisher` import at all (confirmed: `grep OutboxPublisher apps/billing-service/` returns zero results). Every subscription lifecycle event -- creation, plan change, cancellation, trial expiry, subscription expiry -- is at-most-once.

**Impact:** Cross-service reactions to billing events (metering, tenant suspension, notification) can be silently lost. For SubscriptionCancelled and SubscriptionExpired, this means a tenant could remain provisioned after their subscription ends because the admin-service never received the event.

**Cross-domain:** `form-write-auditor`, `billing-reconciliation-auditor`

---

### LOW-001: Edge device maintenance toggle UI button not disabled for REVOKED or ERROR states

**Severity:** LOW

The maintenance toggle button at line 383-393 of `web/modules/tenant-admin/src/pages/EdgeDeviceDetailPage.tsx` is only disabled when `actionLoading` is truthy:

```tsx
disabled={!!actionLoading}
```

The backend now correctly guards against DECOMMISSIONED (prior HIGH-003 fix), but the UI does not disable the button for REVOKED or ERROR states. While the backend may handle these gracefully (reverting to ACTIVE from MAINTENANCE is the exit path), presenting the maintenance toggle for a device in ERROR or REVOKED state is a misleading affordance.

**Impact:** UI suggests an action that may not make operational sense, though the backend will handle it. Non-blocking.

**Cross-domain:** `button-action-auditor`

---

## Systemic Pattern: Parallel Entry Points Bypass Lifecycle Enforcement

Findings HIGH-001, HIGH-002, and HIGH-005 share a common root cause: dedicated lifecycle methods (state-machine-validated handlers) coexist with generic CRUD update paths that accept the same status field without consulting the transition map.

- Task: `update()` uses `VALID_TRANSITIONS`; `completeTask()` does not
- Tank: `UpdateTankStatusHandler` uses `canTransitionTo()`; `UpdateEquipmentHandler.updateTank()` does not
- Goal: `CompleteGoalHandler`/`DeferGoalHandler` have business rules; `UpdateGoalHandler` bypasses them

This is a structural anti-pattern. The recommendation is to enforce all status mutations through a single state-machine function per entity and remove the `status` field from generic update DTOs. Status changes should only be possible via dedicated commands.

## Systemic Pattern: Inconsistent Event Delivery Guarantee

Findings HIGH-004, MEDIUM-003, and MEDIUM-004 show that the outbox migration is incomplete. Some handlers within the same bounded context (leave-approve vs. leave-cancel) use different event delivery mechanisms. The billing-service has not adopted the outbox at all. This creates a patchwork where some lifecycle events have at-least-once delivery and others have at-most-once, making it impossible for consumers to reason about delivery guarantees.

---

## Verdict

The prior cycle's four findings are all confirmed fixed. This cycle surfaces five HIGH findings, four MEDIUM findings, and one LOW finding. The two systemic patterns -- parallel update bypasses and inconsistent event delivery -- are the dominant themes. Until every status-mutation entry point runs through a single state-machine validator per entity, and until every lifecycle event is outbox-backed, these categories of bugs will recur.
