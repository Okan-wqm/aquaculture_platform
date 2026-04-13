# Button Action Auditor: Full Platform E2E

**Date:** 2026-04-13
**Scope:** `web/**`, `web/apps/aquamobil/**`, tracing into `apps/**` when needed
**Prior cycle:** 2026-04-11 (commit 79ce984f fixed 12 findings)

---

## Status of Prior Findings

Prior findings from 2026-04-11 are re-evaluated below. Findings that were fully resolved by commit 79ce984f are marked RESOLVED. Findings that remain open or have partially regressed are re-issued with new IDs.

| Prior ID | Status | Notes |
|----------|--------|-------|
| HIGH-001 | OPEN (re-issued as CRITICAL-001) | Mobile record pages still show success before backend confirmation |
| HIGH-002 | OPEN (re-issued as HIGH-001) | Task actions still swallow errors into offline queue with false success |
| HIGH-003 | OPEN (re-issued as HIGH-002) | Impersonation handlers still lack per-action in-flight guards |

---

## Findings

### CRITICAL-001 -- Maintenance page handlers produce false success on API failure (catch block applies optimistic state)

**What the user believes:** Clicking "Start Maintenance", "End Maintenance", or "Cancel Maintenance" triggers the backend operation and updates the UI to reflect the real outcome.

**What the code actually does:** Every catch block in `MaintenancePage.tsx` applies the exact same local-state mutation as the happy path. When the API call fails, the UI still transitions the maintenance window to `in_progress`, `completed`, or `cancelled` respectively. The user sees success while the backend state has not changed. The comments literally say `// Demo: update locally`.

**Evidence:**
- `web/modules/admin-panel/src/pages/system/MaintenancePage.tsx:174-184` -- `handleStartMaintenance` catch block applies the same state update
- `web/modules/admin-panel/src/pages/system/MaintenancePage.tsx:199-208` -- `handleEndMaintenance` catch block applies the same state update
- `web/modules/admin-panel/src/pages/system/MaintenancePage.tsx:251-257` -- `handleCancelMaintenance` catch block applies the same state update
- `web/modules/admin-panel/src/pages/system/MaintenancePage.tsx:140-154` -- `handleCreate` catch block creates a fake maintenance window with `Date.now().toString()` as ID

**Root cause:** These handlers were written as demo stubs that permanently swallow errors by applying optimistic-style local updates in the catch path. There is no error boundary between success and failure -- both paths produce identical UI outcomes.

**Impact:** A super-admin can believe they started or ended a maintenance window when the backend rejected or timed out the request. Stale maintenance state in the admin panel can lead to incorrect user-facing maintenance banners, premature traffic restoration, or invisible ongoing outages.

**Cross-domain dependency:**
- Route to `workflow-state-auditor` for maintenance lifecycle correctness.

---

### CRITICAL-002 -- Job queue retry and pause/resume handlers produce false success on API failure

**What the user believes:** Clicking "Retry" on a failed job or "Pause"/"Resume" on a queue performs the operation.

**What the code actually does:** The catch blocks in `handleRetryJob`, `handleCancelJob`, `handlePauseQueue`, and `handleResumeQueue` all apply the same optimistic state update as the success path. The comments say `// Optimistic update for demo`.

**Evidence:**
- `web/modules/admin-panel/src/pages/system/JobQueuePage.tsx:123-132` -- `handleRetryJob` catch applies identical state as success
- `web/modules/admin-panel/src/pages/system/JobQueuePage.tsx:148-154` -- `handleCancelJob` catch applies identical state as success
- `web/modules/admin-panel/src/pages/system/JobQueuePage.tsx:183-196` -- `handlePauseQueue` catch applies identical state as success
- `web/modules/admin-panel/src/pages/system/JobQueuePage.tsx:214-226` -- `handleResumeQueue` catch applies identical state as success

**Root cause:** Same demo-stub anti-pattern as CRITICAL-001. The error path intentionally mirrors the success path.

**Impact:** An admin believes they retried a failed job or paused a queue while the backend did nothing. Silently-failed retries mean data-loss jobs stay dead. Silently-failed pause means a dangerous queue keeps running.

---

### CRITICAL-003 -- Mobile record pages treat offline-queue insertion as confirmed business success (re-issue of prior HIGH-001)

**What the user believes:** Tapping "Submit" on a harvest/mortality/cull/transfer/leave/attendance record and seeing the green checkmark + "Request Submitted!" means the backend has accepted and persisted the record.

**What the code actually does:** Success UI is shown immediately after `addToQueue()` resolves, which only inserts into the local IndexedDB offline queue. No backend roundtrip has occurred or been verified at that point.

**Evidence (unchanged from prior cycle):**
- `web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx:102` -- `setShowSuccess(true)` after `addToQueue`, with a fire-and-forget `setTimeout` that calls `submitRequest` inside a swallowed catch
- `web/apps/aquamobil/src/pages/attendance/AttendancePage.tsx:95-96` -- `setSuccessMessage('Clock In Recorded!')` after `addToQueue`
- `web/apps/aquamobil/src/pages/harvest/RecordHarvestPage.tsx:102` -- `setShowSuccess(true)` after `addToQueue`
- Mobile mortality, cull, and transfer pages follow the identical pattern

**Root cause:** The offline queue is being used as the success boundary. The UI equates "queued locally" with "accepted by server."

**Impact:** Users can believe they recorded a harvest, mortality event, or leave request that the backend never received. In aquaculture, a missing mortality record directly impacts fish stock counts and regulatory reporting.

**Cross-domain dependency:**
- Route to `mobile-app-auditor` for offline queue confirmation discipline.
- Route to `workflow-state-auditor` for lifecycle truthfulness.

---

### HIGH-001 -- Task start/complete buttons report success even when mutation was silently queued offline (re-issue of prior HIGH-002)

**What the user believes:** Tapping "Start Task" or "Complete Task" and seeing "Task started!"/"Task completed!" means the operation succeeded.

**What the code actually does:** `useTaskActions.ts` catches any error from the GraphQL call and silently falls back to `addToQueue()`. The calling page (`TaskDetailPage.tsx`) then shows the success screen because the hook resolved without throwing.

**Evidence:**
- `web/apps/aquamobil/src/hooks/useTaskActions.ts:17-21` -- `completeTask` catches all errors and falls back to offline queue
- `web/apps/aquamobil/src/hooks/useTaskActions.ts:29-33` -- `startTask` catches all errors and falls back to offline queue
- `web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx:79-80` -- Shows success after `startTask()` resolves
- `web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx:97-99` -- Shows success after `completeTask()` resolves
- `web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx:116-118` -- `handleToggleChecklist` silently catches errors with empty catch
- `web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx:126-128` -- `handleAddNote` silently catches errors with empty catch

**Root cause:** The hook does not distinguish between "online mutation succeeded" and "offline queue accepted." The page has no way to know which occurred.

**Impact:** Business rule rejections (e.g., task already completed by another user, lifecycle state violation) are silently swallowed. The user sees success while the backend state is unchanged.

---

### HIGH-002 -- Impersonation privileged actions lack per-action loading state, enabling double execution (re-issue of prior HIGH-003)

**What the user believes:** Clicking "Start Impersonation", "End Session", "Grant Permission", "Extend Session", or "Revoke" fires exactly once.

**What the code actually does:** None of the handlers (`handleStartImpersonation`, `handleEndSession`, `handleExtendSession`, `handleRevokeSession`, `handleGrantPermission`, `handleRevokePermission`) set a pending flag that would disable the button while the promise is in flight. The modal stays open until the async call resolves.

**Evidence:**
- `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:200-216` -- `handleStartImpersonation` has no loading flag
- `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:218-227` -- `handleEndSession` has no loading flag
- `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:229-238` -- `handleExtendSession` has no loading flag
- `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:240-251` -- `handleRevokeSession` has no loading flag
- `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:253-277` -- `handleGrantPermission` has no loading flag
- `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:279-290` -- `handleRevokePermission` has no loading flag

**Root cause:** No `isPending` / `isSubmitting` state is tracked per action. The confirmation modal buttons remain enabled throughout.

**Impact:** Double-click on "Start Impersonation" can create two sessions. Double-click on "Extend Session" can double the extension. These are privileged super-admin actions where duplicate execution has audit and security implications.

---

### HIGH-003 -- Feature toggle status change has no in-flight guard and applies optimistic state without rollback

**What the user believes:** Clicking the enable/disable toggle for a feature flag changes its status.

**What the code actually does:** `handleToggleStatus` optimistically updates local state immediately via `setToggles(toggles.map(...))`, but the state update happens only inside the try block after the `await`. However, there is no `isToggling` guard on the toggle button, meaning rapid clicks can fire concurrent mutations.

Additionally, `handleDelete` at line 174 uses `confirm()` (browser native) for a destructive operation on a production feature flag -- there is no proper modal, no loading state, and no undo.

**Evidence:**
- `web/modules/admin-panel/src/pages/system/FeatureTogglesPage.tsx:105-120` -- `handleToggleStatus` lacks loading guard
- `web/modules/admin-panel/src/pages/system/FeatureTogglesPage.tsx:173-183` -- `handleDelete` uses bare `confirm()` for destructive feature flag deletion

**Root cause:** No per-toggle pending state. Toggle buttons remain interactive during the API call.

**Impact:** Rapid toggling of a feature flag can result in race conditions where the final backend state does not match what the UI shows. Deleting a feature flag has no proper confirmation beyond a browser dialog.

---

### HIGH-004 -- TenantUsers "Export" button is a no-op handler

**What the user believes:** Clicking "Export" will download a CSV or similar export of the user list.

**What the code actually does:** The button has no `onClick` handler. It renders a static `<button>` with "Export" text and a Download icon that does nothing when clicked.

**Evidence:**
- `web/modules/tenant-admin/src/pages/TenantUsers.tsx:227-229` -- Button with no `onClick`:
  ```tsx
  <button className="inline-flex items-center gap-2 px-4 py-2 ...">
    <Download className="w-4 h-4" />
    Export
  </button>
  ```

**Root cause:** The export functionality was never implemented. The button was placed in the UI for design purposes but never wired.

**Impact:** Users expect the button to work. Clicking it does nothing and provides no feedback that the feature is unavailable.

---

### HIGH-005 -- Tenant activate action in detail modal has no loading state and no error display

**What the user believes:** Clicking "Activate" on a suspended tenant in the detail modal immediately activates it.

**What the code actually does:** `handleToggleStatus(tenant, 'activate')` calls `tenantsApi.activate(tenant.id)` without any loading flag. The button remains enabled during the async call. If the call fails, an error is set via `setError()`, but the detail modal has already closed (no error display inside it).

**Evidence:**
- `web/modules/admin-panel/src/pages/TenantManagementPage.tsx:129-135` -- No loading guard on activate
- `web/modules/admin-panel/src/pages/TenantManagementPage.tsx:496-512` -- Detail modal suspend/activate buttons have no `disabled` prop tied to a pending state

**Root cause:** The detail modal does not pass a saving/loading state to the action buttons. Error state is set on the page but the modal has no error display zone.

---

### HIGH-006 -- Database schema suspend/activate uses confirm() and has no loading state or error handling in inline handler

**What the user believes:** Clicking "Suspend" or "Activate" on a database schema in the DatabaseManagementPage will safely toggle the schema state.

**What the code actually does:** The suspend action uses bare `confirm()`, then fires an inline `.then()` chain with no catch handler. If the API rejects, the error is silently lost. The button stays enabled during execution.

**Evidence:**
- `web/modules/admin-panel/src/pages/DatabaseManagementPage.tsx:374-376` -- inline `confirm()` + `.then()` with no `.catch()`
- `web/modules/admin-panel/src/pages/DatabaseManagementPage.tsx:385-386` -- activate uses inline `.then()` with no `.catch()`

**Root cause:** Inline promise chains without error handling. No loading state prevents double-click.

**Impact:** Schema suspend/activate is a high-privilege operation. Silent failures mean the admin believes the schema is suspended while tenants continue to have access, or vice versa.

**Cross-domain dependency:**
- Route to `tenant-isolation-auditor` for schema lifecycle.

---

### MEDIUM-001 -- Maintenance page uses `prompt()` for extend duration input

**What the user believes:** They can specify how many minutes to extend a maintenance window.

**What the code actually does:** `handleExtendMaintenance` at line 213 uses `prompt('Extend by how many minutes?', '30')` -- a browser-native input dialog. This is not validated (non-numeric input produces `NaN`), has no loading state, and is not accessible.

**Evidence:**
- `web/modules/admin-panel/src/pages/system/MaintenancePage.tsx:213` -- `const minutes = prompt(...)`

**Root cause:** Quick prototype code that was never replaced with a proper modal.

---

### MEDIUM-002 -- Automation programs reject action uses `window.prompt()` for reason input

**What the user believes:** They can reject an automation program with a reason.

**What the code actually does:** `handleReject` at line 458 uses `window.prompt()` for the rejection reason. Non-validated, not accessible, no loading state during the mutation.

**Evidence:**
- `web/modules/sensor-module/src/pages/automation/AutomationProgramsPage.tsx:458` -- `const reason = window.prompt(...)`

---

### MEDIUM-003 -- VFD changeset reject action uses `window.prompt()` for reason input

**What the user believes:** They can reject a VFD changeset with a reason.

**What the code actually does:** Inline `window.prompt('Rejection reason:')` with no validation, accessibility, or loading state.

**Evidence:**
- `web/modules/sensor-module/src/components/vfd/VfdChangeSetList.tsx:410` -- `const reason = window.prompt('Rejection reason:')`

---

### MEDIUM-004 -- Multiple farm setup tabs use bare `confirm()` for destructive delete actions

Numerous farm module setup tabs use `confirm()` or `window.confirm()` for delete confirmations instead of the proper `DeleteConfirmationDialog` component that already exists in `shared-ui`. These are unguarded against double-click and provide no loading feedback.

**Evidence:**
- `web/modules/farm-module/src/pages/setup/tabs/SpeciesTab.tsx:323` -- `confirm('Are you sure...')`
- `web/modules/farm-module/src/pages/setup/tabs/ChemicalsTab.tsx:579` -- `confirm('Are you sure...')`
- `web/modules/farm-module/src/pages/setup/tabs/FeedsTab.tsx:406` -- `confirm('Are you sure...')`
- `web/modules/farm-module/src/pages/setup/tabs/ConsumablesTab.tsx:219` -- `confirm('Are you sure...')`
- `web/modules/farm-module/src/pages/setup/tabs/WorkersTab.tsx:84` -- `confirm('Are you sure...')`
- `web/modules/farm-module/src/pages/setup/tabs/SuppliersTab.tsx:300` -- `confirm('Are you sure...')`
- `web/modules/farm-module/src/pages/setup/tabs/FishHealthChemicalsTab.tsx:123` -- `confirm('Are you sure...')`
- `web/modules/farm-module/src/pages/health/HealthEventsPage.tsx:335,389,426` -- `window.confirm()`
- `web/modules/farm-module/src/pages/maintenance/WorkOrdersPage.tsx:413` -- `window.confirm()`
- `web/modules/farm-module/src/pages/maintenance/SparePartsPage.tsx:253` -- `window.confirm()`
- `web/modules/farm-module/src/pages/maintenance/MaintenanceSchedulesPage.tsx:220` -- `window.confirm()`

**Root cause:** The `DeleteConfirmationDialog` exists and is used in some places (EquipmentTab, SitesTab) but was not adopted across the entire farm module. The setup tabs were written before the shared dialog was available and were never migrated.

**Impact:** No loading state during delete means double-click can fire duplicate DELETE requests. No accessible modal means screen readers see nothing.

---

### MEDIUM-005 -- Sensor module destructive actions use `window.confirm()` instead of proper modals

Same pattern as MEDIUM-004 but in the sensor module.

**Evidence:**
- `web/modules/sensor-module/src/pages/DeviceDetailPage.tsx:401` -- sensor delete via `window.confirm()`
- `web/modules/sensor-module/src/pages/process/ProcessListPage.tsx:86` -- process delete via `window.confirm()`
- `web/modules/sensor-module/src/pages/scada/ScadaPackageListPage.tsx:76` -- package delete via `window.confirm()`
- `web/modules/sensor-module/src/pages/EdgeDeviceDetailPage.tsx:1801,1815` -- device approve/decommission via `window.confirm()`
- `web/modules/sensor-module/src/components/scada-builder/ScreenTabBar.tsx:112` -- screen delete via `window.confirm()`
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/EmergencyStopRenderer.tsx:14` -- **EMERGENCY STOP** uses `window.confirm()` -- this is the most safety-critical button in the SCADA interface

---

### MEDIUM-006 -- Leave approve mutation fires without confirmation and has no per-row loading state

**What the user believes:** Clicking the green checkmark on a pending leave request approves it.

**What the code actually does:** `approveMutation.mutate({ id: row.id })` is called directly on click with no confirmation step. The `disabled` prop only checks `approveMutation.isPending` which is a global flag -- if the user clicks approve on two different rows in rapid succession, only the second will be blocked.

**Evidence:**
- `web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:142-152` -- approve handler fires mutation directly, disabled uses global `isPending`

**Root cause:** TanStack Query mutation `isPending` is per-mutation-instance, not per-row. There is no per-row loading state.

**Impact:** Approving the wrong leave request is an irreversible action that affects employee balances. Missing per-row loading state means the user can accidentally approve multiple requests.

---

### LOW-001 -- Debug tools query execution button throws hardcoded error

**What the user believes:** They can execute a diagnostic query.

**What the code actually does:** The handler at line 237 immediately throws `new Error('Query execution API endpoint not yet implemented')`.

**Evidence:**
- `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:237-238` -- hardcoded throw

**Root cause:** Unfinished feature left in the UI.

---

### LOW-002 -- Debug tools cache invalidation falls through to mock success on failure

**What the user believes:** Invalidating a cache entry removes it from the cache.

**What the code actually does:** The catch block at line 225 removes the entry from local state, making it look like the invalidation succeeded.

**Evidence:**
- `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:224-226` -- catch block applies mock success

---

### LOW-003 -- Admin panel pages use `console.error` instead of NestJS Logger

Multiple admin panel page handlers log errors via `console.error`. While this is a frontend context where NestJS Logger does not apply, the pattern is inconsistent with structured logging expectations for enterprise observability.

**Evidence:**
- `web/modules/admin-panel/src/pages/system/MaintenancePage.tsx:175,200,236,252` -- `console.error()`
- `web/modules/admin-panel/src/pages/system/JobQueuePage.tsx:123,148,184,215` -- `console.error()`
- `web/modules/admin-panel/src/pages/system/FeatureTogglesPage.tsx:117,143,165,180` -- `console.error()`
- `web/modules/admin-panel/src/pages/TenantManagementPage.tsx:83` -- `console.error()`

---

## Systemic Patterns

### Pattern A: "Demo Fallback" Anti-Pattern (CRITICAL)

Multiple admin panel system pages (MaintenancePage, JobQueuePage, DebugToolsPage) implement a pattern where the catch block of an API call applies the exact same local state mutation as the success path, with comments like `// Demo: update locally` or `// Optimistic update for demo`. This means:

1. The user sees no difference between success and failure.
2. The local state drifts from backend truth with no reconciliation.
3. Subsequent page reloads reveal the true state, breaking trust.

**Affected pages:** MaintenancePage, JobQueuePage, DebugToolsPage
**Recommendation:** Remove all catch-block state mutations. Show error toasts on failure. Add a `refetch()` call on page focus to reconcile stale state.

### Pattern B: `confirm()` / `prompt()` for Destructive and Privileged Actions

At least 25 destructive or privileged action handlers use `window.confirm()` or `window.prompt()` instead of proper modal components. The codebase already has `DeleteConfirmationDialog` in `shared-ui`. These native dialogs:
- Are not accessible (no screen reader integration, no focus management)
- Cannot show loading state
- Cannot display rich content (affected items, warnings)
- Do not prevent double-click execution

**Recommendation:** Replace all `confirm()`/`prompt()` usage with the existing `DeleteConfirmationDialog` or a new `ActionConfirmationModal` shared component. Highest priority: `EmergencyStopRenderer.tsx` (SCADA safety-critical), maintenance page actions, database schema suspend.

### Pattern C: Mobile Offline Queue as Success Boundary

All mobile record pages (harvest, mortality, cull, transfer, leave, attendance, task) treat `addToQueue()` resolution as the user-visible success boundary. The queue is local IndexedDB -- no backend confirmation has occurred. This was identified in the prior cycle and remains unfixed.

**Recommendation:** Implement a two-phase success UX: (1) "Queued" state with a pending indicator, (2) "Confirmed" state only after the backend sync callback succeeds. Show a reconciliation banner when sync fails.

---

## Summary

| Severity | Count | New vs Re-issue |
|----------|-------|-----------------|
| CRITICAL | 3     | 2 new, 1 re-issue |
| HIGH     | 6     | 4 new, 2 re-issue |
| MEDIUM   | 6     | 6 new |
| LOW      | 3     | 3 new |
| **Total** | **18** | |

The most urgent items are the "demo fallback" false-success handlers in the admin system pages (CRITICAL-001, CRITICAL-002) which are currently shipping code that intentionally lies to the admin about operation outcomes. The mobile false-success pattern (CRITICAL-003) remains open from the prior cycle.
