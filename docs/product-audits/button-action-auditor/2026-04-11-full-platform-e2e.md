# Button Action Auditor: Full Platform E2E

Scope: `web/**` and `web/apps/aquamobil/**`, tracing into `apps/**` only when needed for the click path.

## Findings

### HIGH-001 - Mobile record buttons report success before backend truth is established
The mobile record flows are treating queue acceptance as completed business success, then immediately showing success UI and navigating away. That is not backend-confirmed truth, and in `LeaveRequestPage` the problem is stronger: the page queues a draft, fires a delayed submit in the background, and still shows "Request Submitted!" before `submitRequest(queueId)` is verified. The same success-before-confirmation pattern appears across the core mutation pages that users depend on for operational records.

Evidence:
- [`web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx:81`](../../../../web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx#L81), [`web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx:91`](../../../../web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx#L91), [`web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx:102`](../../../../web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx#L102)
- [`web/apps/aquamobil/src/pages/attendance/AttendancePage.tsx:90`](../../../../web/apps/aquamobil/src/pages/attendance/AttendancePage.tsx#L90), [`web/apps/aquamobil/src/pages/attendance/AttendancePage.tsx:95`](../../../../web/apps/aquamobil/src/pages/attendance/AttendancePage.tsx#L95)
- [`web/apps/aquamobil/src/pages/harvest/RecordHarvestPage.tsx:89`](../../../../web/apps/aquamobil/src/pages/harvest/RecordHarvestPage.tsx#L89), [`web/apps/aquamobil/src/pages/harvest/RecordHarvestPage.tsx:102`](../../../../web/apps/aquamobil/src/pages/harvest/RecordHarvestPage.tsx#L102)
- [`web/apps/aquamobil/src/pages/mortality/RecordMortalityPage.tsx:86`](../../../../web/apps/aquamobil/src/pages/mortality/RecordMortalityPage.tsx#L86), [`web/apps/aquamobil/src/pages/mortality/RecordMortalityPage.tsx:95`](../../../../web/apps/aquamobil/src/pages/mortality/RecordMortalityPage.tsx#L95)
- [`web/apps/aquamobil/src/pages/cull/RecordCullPage.tsx:77`](../../../../web/apps/aquamobil/src/pages/cull/RecordCullPage.tsx#L77), [`web/apps/aquamobil/src/pages/cull/RecordCullPage.tsx:86`](../../../../web/apps/aquamobil/src/pages/cull/RecordCullPage.tsx#L86)
- [`web/apps/aquamobil/src/pages/transfer/RecordTransferPage.tsx:71`](../../../../web/apps/aquamobil/src/pages/transfer/RecordTransferPage.tsx#L71), [`web/apps/aquamobil/src/pages/transfer/RecordTransferPage.tsx:81`](../../../../web/apps/aquamobil/src/pages/transfer/RecordTransferPage.tsx#L81)
- [`web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx:303`](../../../../web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx#L303), [`web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx:313`](../../../../web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx#L313), [`web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx:320`](../../../../web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx#L320)
- [`web/apps/aquamobil/src/pages/storage/StockTransferPage.tsx:210`](../../../../web/apps/aquamobil/src/pages/storage/StockTransferPage.tsx#L210), [`web/apps/aquamobil/src/pages/storage/StockTransferPage.tsx:219`](../../../../web/apps/aquamobil/src/pages/storage/StockTransferPage.tsx#L219), [`web/apps/aquamobil/src/pages/storage/StockTransferPage.tsx:225`](../../../../web/apps/aquamobil/src/pages/storage/StockTransferPage.tsx#L225)

Root cause:
- Queue insertion is being treated as the success boundary for the UI, even when the real mutation is deferred or retried later.
- `LeaveRequestPage` additionally schedules the real submit in a delayed background callback and never waits for its outcome before showing success.

Cross-domain dependency:
- Route the lifecycle/submit truthfulness gap to `workflow-state-auditor`.
- Route the offline queue confirmation gap to `mobile-app-auditor`.
- Route the write-path parity gap to `form-write-auditor`.

### HIGH-002 - Task start/complete buttons can surface false success and lose error truth
Task actions are wrapped in a fallback that turns any GraphQL failure into an offline queue write, then the page unconditionally shows a success state after `await startTask(...)` or `await completeTask(...)`. That means the user can see "Task started!" or "Task completed!" even when the online mutation failed and only a queue item was created. The same page also swallows failures for checklist toggles and note adds, so button clicks can silently do nothing.

Evidence:
- [`web/apps/aquamobil/src/hooks/useTaskActions.ts:14`](../../../../web/apps/aquamobil/src/hooks/useTaskActions.ts#L14), [`web/apps/aquamobil/src/hooks/useTaskActions.ts:18`](../../../../web/apps/aquamobil/src/hooks/useTaskActions.ts#L18), [`web/apps/aquamobil/src/hooks/useTaskActions.ts:26`](../../../../web/apps/aquamobil/src/hooks/useTaskActions.ts#L26), [`web/apps/aquamobil/src/hooks/useTaskActions.ts:30`](../../../../web/apps/aquamobil/src/hooks/useTaskActions.ts#L30)
- [`web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx:75`](../../../../web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx#L75), [`web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx:80`](../../../../web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx#L80), [`web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx:93`](../../../../web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx#L93), [`web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx:98`](../../../../web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx#L98)
- [`web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx:111`](../../../../web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx#L111), [`web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx:116`](../../../../web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx#L116), [`web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx:121`](../../../../web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx#L121), [`web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx:127`](../../../../web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx#L127)
- [`web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx:283`](../../../../web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx#L283), [`web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx:347`](../../../../web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx#L347), [`web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx:365`](../../../../web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx#L365), [`web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx:379`](../../../../web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx#L379)

Root cause:
- The mutation hook catches all errors and converts them into a queued action, without distinguishing network failure from business-rule rejection.
- The page then renders a success screen as soon as the hook resolves, with no backend confirmation boundary and no in-flight guard for the checklist/note actions.

Cross-domain dependency:
- Route the status transition rules to `workflow-state-auditor`.
- Route the post-click visibility/update gap to `list-visibility-auditor`.
- Route the mobile mutation fallback discipline to `mobile-app-auditor`.

### HIGH-003 - Impersonation actions are privileged but lack in-flight locking, enabling duplicate execution
The impersonation page exposes privileged actions for starting sessions, granting permissions, ending sessions, extending sessions, and revoking access, but none of those flows hold a dedicated loading/disabled state while the request is in flight. The modal stays open until the promise resolves, so a fast double-click can fire the same privileged mutation more than once before the UI closes or refreshes.

Evidence:
- [`web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:200`](../../../../web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx#L200), [`web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:253`](../../../../web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx#L253), [`web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:279`](../../../../web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx#L279)
- [`web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:360`](../../../../web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx#L360), [`web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:363`](../../../../web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx#L363)
- [`web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:1241`](../../../../web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx#L1241), [`web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:1252`](../../../../web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx#L1252)

Root cause:
- The handlers do not set a per-action pending flag, and the modal buttons do not disable while the promise is unresolved.
- The privileged action surface therefore depends on user timing instead of deterministic execution control.

Cross-domain dependency:
- Route the privilege boundary review to `access-boundary-auditor`.
- Route the tenant scope and impersonation isolation review to `tenant-isolation-auditor`.
- Route any session lifecycle assertions to `workflow-state-auditor`.
