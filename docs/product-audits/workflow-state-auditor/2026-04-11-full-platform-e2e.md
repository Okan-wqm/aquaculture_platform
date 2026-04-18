# Workflow State Audit

Topic: `2026-04-11-full-platform-e2e`

## Findings

### HIGH-001: Task lifecycle transitions can succeed while required downstream state side effects are lost
Root cause: task completion and task start both persist the new task state first, then try to publish a lifecycle event through the in-process event bus. If publish fails, the code only logs a warning and still returns success, so the database state advances but downstream projections, notifications, or audit consumers can miss the transition with no retry or outbox safety net.

Evidence:
- [`apps/farm-service/src/task/services/task.service.ts:328`](/var/aqua-saas/apps/farm-service/src/task/services/task.service.ts#L328)
- [`apps/farm-service/src/task/services/task.service.ts:340`](/var/aqua-saas/apps/farm-service/src/task/services/task.service.ts#L340)
- [`apps/farm-service/src/task/services/task.service.ts:367`](/var/aqua-saas/apps/farm-service/src/task/services/task.service.ts#L367)
- [`apps/farm-service/src/task/services/task.service.ts:377`](/var/aqua-saas/apps/farm-service/src/task/services/task.service.ts#L377)

Impact: a task can be marked `COMPLETED` or `IN_PROGRESS` in the primary store while downstream read models stay stale or never observe the change. That is a workflow integrity break, not just a logging issue.

Cross-domain: `list-visibility-auditor`

### HIGH-002: `startTask` emits the wrong prior state for overdue tasks
Root cause: `startTask` accepts both `PENDING` and `OVERDUE`, but the emitted `TaskStatusChanged` payload hard-codes `previousStatus: TaskStatus.PENDING`. When an overdue task is started, the event is semantically wrong even though the state transition itself is legal.

Evidence:
- [`apps/farm-service/src/task/services/task.service.ts:358`](/var/aqua-saas/apps/farm-service/src/task/services/task.service.ts#L358)
- [`apps/farm-service/src/task/services/task.service.ts:374`](/var/aqua-saas/apps/farm-service/src/task/services/task.service.ts#L374)
- [`libs/event-contracts/src/task-events.ts:34`](/var/aqua-saas/libs/event-contracts/src/task-events.ts#L34)

Impact: any consumer reconstructing the task lifecycle from events will record the wrong transition history for overdue tasks, which breaks auditability and can poison projections that depend on the old/new state pair.

Cross-domain: `list-visibility-auditor`

### HIGH-003: Edge device maintenance mode can resurrect a decommissioned device
Root cause: the backend `setMaintenanceMode` handler has no terminal-state guard. It will move any device to `MAINTENANCE` or back to `ACTIVE`, including devices that were already `DECOMMISSIONED`. The tenant-admin UI also exposes the maintenance button regardless of lifecycle state, so the final state is not protected at either layer.

Evidence:
- [`apps/sensor-service/src/edge-device/edge-device.service.ts:560`](/var/aqua-saas/apps/sensor-service/src/edge-device/edge-device.service.ts#L560)
- [`apps/sensor-service/src/edge-device/edge-device.service.ts:563`](/var/aqua-saas/apps/sensor-service/src/edge-device/edge-device.service.ts#L563)
- [`web/modules/tenant-admin/src/pages/EdgeDeviceDetailPage.tsx:383`](/var/aqua-saas/web/modules/tenant-admin/src/pages/EdgeDeviceDetailPage.tsx#L383)
- [`web/modules/tenant-admin/src/pages/EdgeDeviceDetailPage.tsx:392`](/var/aqua-saas/web/modules/tenant-admin/src/pages/EdgeDeviceDetailPage.tsx#L392)
- [`apps/sensor-service/src/edge-device/edge-device.service.ts:1072`](/var/aqua-saas/apps/sensor-service/src/edge-device/edge-device.service.ts#L1072)

Impact: a terminal lifecycle can be reopened into an operational state, which defeats decommissioning semantics and creates a privileged state rollback path that should not exist.

Cross-domain: `button-action-auditor`

### HIGH-004: Channel archival is authorized against historical membership, not active membership
Root cause: the archive handler checks membership with `leftAt: undefined`, while the rest of the channel lifecycle code uses `IsNull()` to require an active member. Because `leftAt` is not constrained to null here, a former admin/owner who already left can still match the row and archive the channel.

Evidence:
- [`apps/messaging-service/src/channel/commands/archive-channel.handler.ts:48`](/var/aqua-saas/apps/messaging-service/src/channel/commands/archive-channel.handler.ts#L48)
- [`apps/messaging-service/src/channel/commands/archive-channel.handler.ts:50`](/var/aqua-saas/apps/messaging-service/src/channel/commands/archive-channel.handler.ts#L50)
- [`apps/messaging-service/src/channel/queries/get-channel.handler.ts:46`](/var/aqua-saas/apps/messaging-service/src/channel/queries/get-channel.handler.ts#L46)
- [`apps/messaging-service/src/channel/commands/remove-member.handler.ts:59`](/var/aqua-saas/apps/messaging-service/src/channel/commands/remove-member.handler.ts#L59)
- [`apps/messaging-service/src/channel/commands/update-channel.handler.ts:57`](/var/aqua-saas/apps/messaging-service/src/channel/commands/update-channel.handler.ts#L57)

Impact: the destructive archive transition can be executed by a user who is no longer an active member, which is a direct workflow-state authorization failure.

Cross-domain: `button-action-auditor`

## Verdict

The platform has the right shape for workflow enforcement, but these gaps are still production-significant: one lossy side-effect path, one incorrect lifecycle payload, one terminal-state bypass, and one archive authorization bug. These are root-cause issues, not UI-only affordance problems.
