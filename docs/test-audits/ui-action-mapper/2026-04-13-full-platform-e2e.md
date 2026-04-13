# UI Action Mapper Audit: `2026-04-13-full-platform-e2e`

**Auditor:** ui-action-mapper
**Date:** 2026-04-13
**Scope:** `web/shell/**`, `web/modules/**`, `web/apps/aquamobil/**`, `apps/**`
**Prior Cycle:** `2026-04-11-full-platform-e2e` (6 findings). Commit `79ce984f` claimed 12 fixes.

---

## Prior Finding Verification

| Prior ID | Status | Notes |
|---|---|---|
| HIGH-001 | **STILL OPEN** | `allowedActions` still dropped from `grantPermission()` payload (line 257-263 of ImpersonationPage.tsx). Escalated to CRITICAL in this cycle. |
| MEDIUM-002 | **STILL OPEN** | `getSessionActions()` still throws `Not implemented` (impersonation.ts:62). Button still rendered at ImpersonationPage.tsx. |
| MEDIUM-003 | **PARTIALLY RESOLVED** | Server-side pagination/filtering added to `useTenantAuditLog` hook. However, the search bar text input at TenantAuditLogPage.tsx:246-253 still filters only the current page client-side. Downgraded to LOW since structured filters (date, action, severity, performedBy) are server-side. |
| MEDIUM-004 | **STILL OPEN** | `handleDelete` at ChatRoomPage.tsx:160-164 is still a TODO placeholder. `onAttachmentPress` at line 392-394 is still a no-op. `onVoiceRecordingComplete` at line 395-397 is still a no-op. |
| MEDIUM-005 | **STILL OPEN** | `useChannelMedia()` at MediaViewerPage.tsx:43-48 still returns `[]`. |
| LOW-006 | **STILL OPEN** | Export Schema button at TenantDatabase.tsx:438 still has no `onClick` handler. |

**Summary:** 0 of 6 prior findings fully resolved. 1 partially resolved. 5 still open. Commit 79ce984f appears to have addressed other issues (e.g., CompliancePage response contract fix, health check routing) but did not touch these UI action mapping gaps.

---

## New Findings

### CRITICAL-001: Impersonation allowedActions checkboxes are rendered but never transmitted (ESCALATED from prior HIGH-001)

**Gap taxonomy:** write-gap
**Severity escalation reason:** Second consecutive audit cycle with this finding open. A privileged access-scoping control exists in the UI but is silently dropped.

**Evidence:**
- `ImpersonationPage.tsx` renders `allowedActions` checkboxes at lines 1047-1057, with state at line 104: `allowedActions: ['read'] as string[]`
- `handleGrantPermission()` at line 253-277 calls `impersonationApi.grantPermission()` but omits `allowedActions` from the payload
- `impersonation.ts` `grantPermission` DTO (line 20-33) does not include an `allowedActions` field

**Root cause:** The `grantPermission` API contract and the handler both omit `allowedActions`. The operator sees checkboxes (read, write, delete, admin) and believes they are constraining the permission, but the backend receives no such constraint. The impersonation session runs with whatever default permissions the backend assigns.

**Cross-domain:** contract-parity-auditor, access-boundary-auditor

---

### CRITICAL-002: GDPR data subject request actions (verify/reject/complete) are no-ops

**Gap taxonomy:** write-gap
**File:** `web/modules/admin-panel/src/pages/security/CompliancePage.tsx`

**Evidence:**
- `DataRequestDetailModal` renders Verify Identity (line 429), Reject (line 438), and Complete (line 444) buttons with `onAction` callbacks
- `handleRequestAction()` at line 506-510 only logs the action and closes the modal:
  ```
  const handleRequestAction = (action: string) => {
    console.log('Action:', action, 'on request:', selectedRequest?.id);
    setSelectedRequest(null);
    loadData();
  };
  ```
- No API call is made to `securityApi.updateDataRequest()` or any backend mutation

**Root cause:** The GDPR compliance page presents a full data subject request management workflow (verify identity, reject, complete), but the action handler only logs to console. An operator who processes a GDPR erasure request through this UI will see a success-like experience (modal closes, data reloads) while the backend request status remains unchanged.

**Cross-domain:** form-write-auditor, contract-parity-auditor

---

### HIGH-001: Messaging admin retention/compliance/monitoring pages are fully mock-backed with fake write paths

**Gap taxonomy:** write-gap, read-gap
**Files:**
- `web/modules/admin-panel/src/pages/messaging/MessagingRetentionPage.tsx` (lines 237-246, 262-266, 290-294)
- `web/modules/admin-panel/src/pages/messaging/MessagingCompliancePage.tsx` (lines 237-255, 270-273)
- `web/modules/admin-panel/src/pages/messaging/MessagingMonitoringPage.tsx` (lines 180-198)
- `web/modules/admin-panel/src/pages/messaging/MessagingAuditPage.tsx` (lines 90-97)
- `web/modules/admin-panel/src/pages/messaging/MessagingTenantsPage.tsx` (lines 61-68, 97-98, 114-115)
- `web/modules/admin-panel/src/pages/messaging/MessagingAiDashboardPage.tsx` (lines 171-189)
- `web/modules/admin-panel/src/pages/messaging/MessagingAiPersonasPage.tsx` (line 195)

**Evidence:**
- All 7 pages use `MOCK_*` constants (empty arrays/objects) as initial state
- `fetchData()` functions have the real API calls commented out with `// TODO: Replace with actual admin API call` comments
- The pages load `MOCK_*` data instead of calling the backend
- Mutation handlers (`handleSaveRetention`, `handleToggleHold`, `handleAddOverride`, tenant toggle, etc.) have API calls commented out and only mutate local React state
- The pages render full interactive UIs (tables, modals, buttons) that appear functional but persist nothing

**Root cause:** The entire messaging admin surface was scaffolded with mock data and never wired to backend APIs. The pages are accessible in the admin panel navigation and present interactive controls (save retention policy, toggle legal holds, enable/disable tenant messaging) that silently no-op on the backend.

**Cross-domain:** form-write-auditor, data-readback-auditor

---

### HIGH-002: AquaMobil messaging attachment and voice recording buttons are visible no-ops

**Gap taxonomy:** write-gap
**Files:**
- `web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx` (lines 392-397)
- `web/apps/aquamobil/src/components/messaging/MessageInput.tsx` (lines 338-351)

**Evidence:**
- `MessageInput.tsx` renders an "Add attachment" button (Paperclip icon) at line 339 and a voice recording button
- `ChatRoomPage.tsx` wires `onAttachmentPress` to an empty callback: `() => { // TODO: open native file picker or attachment sheet }` (line 392-394)
- `onVoiceRecordingComplete` is wired to: `(blob, durationSeconds, mimeType) => { // TODO: upload voice recording and send as voice message }` (line 395-397)
- The `useMediaUpload` hook exists at `hooks/useMediaUpload.ts` and is fully implemented with presigned URL upload, but ChatRoomPage does not import or use it
- The `VoiceRecorder` component exists at `components/messaging/VoiceRecorder.tsx` but the recording result is discarded

**Root cause:** The upload infrastructure exists (useMediaUpload hook with compression, MIME validation, presigned URLs) but ChatRoomPage never integrates it. Field workers see attachment and voice buttons that do nothing when tapped.

**Cross-domain:** file-transfer-auditor, mobile-app-auditor

---

### HIGH-003: AquaMobil message delete action is a placeholder

**Gap taxonomy:** write-gap
**File:** `web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx` (lines 159-164)

**Evidence:**
- `handleDelete` at line 160: `const handleDelete = useCallback(async (messageId: string) => { // TODO: wire to deleteMessage GraphQL mutation }, []);`
- `MessageBubble.tsx` renders a "Delete" context menu item at line 489-497 with `onDelete` callback
- The delete button is conditionally shown for own messages (`isOwn ? handleDelete : undefined` at line 368)

**Root cause:** The delete action surface exists and is shown to message owners, but the handler is an empty placeholder. The user long-presses, selects "Delete", and nothing happens.

**Cross-domain:** form-write-auditor

---

### HIGH-004: AquaMobil media viewer route exists but data source always returns empty

**Gap taxonomy:** read-gap
**File:** `web/apps/aquamobil/src/pages/messaging/MediaViewerPage.tsx` (lines 43-49)

**Evidence:**
- Route `/messages/media/:attachmentId` is registered in `App.tsx` at line 236
- `useChannelMedia()` at line 43 is a stub function that always returns `{ media: [], loading: false, error: null }`
- The component renders a full pinch-to-zoom viewer UI but can never display any media
- Comment at line 42: `TODO: Wire to graphqlRequest(GET_ATTACHMENT) when backend is ready`

**Root cause:** The viewer route and UI are complete but the data hook is hardcoded to return empty. Any navigation to this route results in a blank viewer.

**Cross-domain:** data-readback-auditor, mobile-app-auditor

---

### HIGH-005: Security Dashboard has no action controls for events or incidents

**Gap taxonomy:** visibility-gap
**File:** `web/modules/admin-panel/src/pages/security/SecurityDashboardPage.tsx`

**Evidence:**
- The page renders security events (line 716-750) and active incidents (line 758-779) as clickable list items
- The `EventDetailModal` (lines 336-458) shows event details but only has a "Close" button (line 448-453)
- No "Resolve", "Dismiss", "Investigate", "Acknowledge", or "Assign" actions exist anywhere in the component
- The `securityApi` service has methods like `resolveSecurityEvent()` and `updateIncident()` available but they are not imported or called
- The incidents section displays severity, status, affected users, and category but provides no way to change incident status or trigger response actions

**Root cause:** The security dashboard is read-only despite displaying operational security data that demands response actions. A security operator can see critical events and open incidents but cannot take any action from this page.

**Cross-domain:** workflow-state-auditor

---

### MEDIUM-001: Subscription cancel and trial extend pass hardcoded 'admin' string instead of actual user identity

**Gap taxonomy:** access-gap
**File:** `web/modules/admin-panel/src/pages/SubscriptionManagementPage.tsx` (lines 74-78, 92-96)

**Evidence:**
- `handleCancelSubscription()` at line 74-78:
  ```
  await billingApi.cancelSubscription(
    selectedSubscription.tenantId,
    cancelReason,
    'admin', // TODO: get from auth context
  );
  ```
- `handleExtendTrial()` at line 92-96:
  ```
  await billingApi.extendTrial(
    selectedSubscription.tenantId,
    trialDays,
    'admin', // TODO: get from auth context
  );
  ```
- The `useAuthContext` hook is not imported; no auth identity is available in this component

**Root cause:** Billing audit trail records show `'admin'` as the actor for all cancel/extend operations, making it impossible to attribute these privileged actions to a specific super admin. This breaks audit traceability for billing operations.

**Cross-domain:** access-boundary-auditor, tenant-isolation-auditor

---

### MEDIUM-002: Impersonation "View Actions" modal backed by unimplemented endpoint (carried from prior MEDIUM-002)

**Gap taxonomy:** read-gap
**File:** `web/modules/admin-panel/src/services/api/impersonation.ts` (line 61-63)

**Evidence:**
- `getSessionActions()` at line 61: `throw new Error('Not implemented: no backend GET endpoint for /impersonation/sessions/:id/actions');`
- The ImpersonationPage still exposes a "View Actions" button that opens a modal and calls this method

**Root cause:** The session audit surface is advertised but has no live data source.

**Cross-domain:** data-readback-auditor

---

### MEDIUM-003: Farm regulatory report tabs display mock data for report history/listing

**Gap taxonomy:** read-gap
**Files:**
- `web/modules/farm-module/src/pages/reports/tabs/SeaLiceReportTab.tsx` (lines 1337-1356)
- `web/modules/farm-module/src/pages/reports/tabs/BiomassReportTab.tsx`
- `web/modules/farm-module/src/pages/reports/tabs/SmoltReportTab.tsx`
- `web/modules/farm-module/src/pages/reports/tabs/CleanerFishReportTab.tsx`
- `web/modules/farm-module/src/pages/reports/tabs/SlaughterReportTab.tsx`
- `web/modules/farm-module/src/pages/reports/tabs/WelfareEventTab.tsx`
- `web/modules/farm-module/src/pages/reports/tabs/DiseaseOutbreakTab.tsx`
- `web/modules/farm-module/src/pages/reports/tabs/EscapeReportTab.tsx`
- `web/modules/farm-module/src/pages/reports/ReportsPage.tsx` (line 17: imports from `./mock/helpers`)

**Evidence:**
- All 8 report tabs import from `../mock/*` (e.g., `mockSeaLiceReports`, `mockBiomassReports`)
- The report listing, filtering, and statistics all compute against mock arrays
- The `useSubmitSeaLiceReport` mutation hook IS wired to a real GraphQL mutation, so the write path exists
- However, after submission, the report history still shows mock data, not the real submitted reports

**Root cause:** The regulatory report write path (wizard + submit mutation) is connected to the backend, but the read path (history listing, status tracking, deadline monitoring) is driven by static mock data. Submitted reports are never visible in the UI after creation.

**Cross-domain:** data-readback-auditor, form-write-auditor

---

### MEDIUM-004: Shell global search handler is a no-op

**Gap taxonomy:** write-gap
**File:** `web/shell/src/layouts/MainLayout.tsx` (lines 480-484)

**Evidence:**
- Line 480: Comment `Search route is not yet implemented; navigate to "/" as a no-op fallback.`
- Line 482: `const handleSearch = useCallback((_query: string) => { // TODO: implement global search page and update this navigation }, []);`
- The Header component renders a search bar that accepts input but the handler discards it

**Root cause:** The shell renders a global search bar in the header that accepts user input but has no search implementation behind it.

**Cross-domain:** data-readback-auditor

---

### MEDIUM-005: Tenant Database Export Schema button has no handler (carried from prior LOW-006, escalated)

**Gap taxonomy:** write-gap
**File:** `web/modules/tenant-admin/src/pages/TenantDatabase.tsx` (line 438)
**Severity escalation reason:** Second consecutive audit cycle with this finding open.

**Evidence:**
- Line 438: `<button className="...">Export Schema</button>` -- no `onClick`, no `href`, no handler of any kind
- The button is styled as a primary action (bg-tenant-600 with Download icon)

**Root cause:** A visible primary action button exists with no behavior attached.

**Cross-domain:** button-action-auditor

---

### MEDIUM-006: HR module has 14 placeholder routes with no real content

**Gap taxonomy:** visibility-gap
**File:** `web/modules/hr-module/src/Module.tsx` (lines 92-138)

**Evidence:**
- Lines 92, 103-105, 109-110, 114-115, 119, 121, 126-127, 130-131, 135, 138 all render `<PlaceholderPage title="..." />`
- PlaceholderPage is defined at line 43 as a simple component showing a title with "Coming Soon" text
- Routes include: Shift Management, Leave Calendar, Leave Balances, Leave Types, Payslips, Payroll Reports, Goals & OKRs, Review Cycles, Training Courses, Compliance Dashboard, Work Areas, Transport Schedule, Organization Structure, Positions, HR Reports, HR Settings
- These routes are accessible from the HR module sidebar navigation

**Root cause:** The HR module exposes 14 navigable routes that lead to placeholder "Coming Soon" pages. While each individual placeholder is honest (it shows "Coming Soon"), the volume of placeholder routes creates a misleading impression of module completeness.

**Cross-domain:** workflow-state-auditor

---

### LOW-001: Tenant audit log search bar only filters current page (downgraded from prior MEDIUM-003)

**Gap taxonomy:** visibility-gap
**File:** `web/modules/tenant-admin/src/pages/TenantAuditLogPage.tsx` (lines 246-253)

**Evidence:**
- `visibleEntries` at line 246 filters `entries` (current page data) by `debouncedSearch`
- The `useTenantAuditLog` hook passes structured filters (date, action, severity, performedBy) server-side but not text search
- Search bar placeholder says "Search audit logs by action, user, or entity..." implying full search

**Root cause:** The text search affordance suggests full audit log search but only filters the 20 entries on the current page. Structured filters work server-side correctly.

**Cross-domain:** data-readback-auditor

---

### LOW-002: AquaMobil AI persona toggle in admin panel is not persisted

**Gap taxonomy:** write-gap
**File:** `web/modules/admin-panel/src/pages/messaging/MessagingAiPersonasPage.tsx` (line 195)

**Evidence:**
- Line 195: `// TODO: Persist toggle via admin API mutation`
- The toggle handler only updates local state

**Root cause:** An admin toggling an AI persona on/off sees the UI update but the change is lost on page reload.

**Cross-domain:** form-write-auditor

---

## Summary Statistics

| Severity | Count | Write-gap | Read-gap | Visibility-gap | Access-gap |
|---|---|---|---|---|---|
| CRITICAL | 2 | 2 | 0 | 0 | 0 |
| HIGH | 5 | 3 | 1 | 1 | 0 |
| MEDIUM | 6 | 2 | 2 | 1 | 1 |
| LOW | 2 | 1 | 0 | 1 | 0 |
| **Total** | **15** | **8** | **3** | **3** | **1** |

## Overall Assessment

The platform has two systemic problems:

1. **Messaging admin pages are entirely mock-backed.** All 7 messaging admin pages (`MessagingRetentionPage`, `MessagingCompliancePage`, `MessagingMonitoringPage`, `MessagingAuditPage`, `MessagingTenantsPage`, `MessagingAiDashboardPage`, `MessagingAiPersonasPage`) use hardcoded empty arrays and commented-out API calls. They present interactive controls that silently no-op. This is the single largest UI-to-backend disconnect on the platform.

2. **GDPR compliance actions are console.log-only.** The CompliancePage renders a complete data subject request management workflow (verify identity, reject, complete) where every action only logs to console and closes the modal. For a platform handling tenant PII, this is the most consequential single finding.

The AquaMobil messaging surface has improved since the prior audit (ForwardModal is now wired, channel actions work) but attachment upload, voice recording, message deletion, and the media viewer remain unwired despite the backend infrastructure (useMediaUpload hook, presigned URLs, GraphQL mutations) being ready.

The impersonation `allowedActions` gap (now CRITICAL-001) has been open for two consecutive audit cycles and represents a privilege escalation surface where operators believe they are constraining impersonation permissions but are not.
