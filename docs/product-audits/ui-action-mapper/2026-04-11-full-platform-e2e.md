# UI Action Mapper Audit: `2026-04-11-full-platform-e2e`

Scope checked: `web/modules/tenant-admin/**`, `web/modules/admin-panel/**`, `web/apps/aquamobil/**`, and adjacent API surfaces needed to trace action wiring.

## Findings

### HIGH-001: Impersonation permission controls are rendered but not transmitted
`[ImpersonationPage.tsx](/var/aqua-saas/web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx#L253)` renders `allowedActions` checkboxes at `[L1038](/var/aqua-saas/web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx#L1038)`, but `handleGrantPermission()` only posts `superAdminId`, `allowedTenants`, `maxSessionDurationMinutes`, `notes`, and `expiresAt` at `[L257](/var/aqua-saas/web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx#L257)`. The API contract in `[impersonation.ts](/var/aqua-saas/web/modules/admin-panel/src/services/api/impersonation.ts#L20)` does not accept `allowedActions` either.

Root cause: a privileged access-scoping control exists in the UI but is dropped before the backend request is built, so the operator cannot actually constrain the permission they think they are granting.

Cross-domain dependencies: `access-boundary-auditor`, `contract-parity-auditor`.

### MEDIUM-002: Impersonation "View Actions" opens a modal backed by a missing backend endpoint
`handleViewActions()` in `[ImpersonationPage.tsx](/var/aqua-saas/web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx#L292)` calls `impersonationApi.getSessionActions(session.id)` at `[L297](/var/aqua-saas/web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx#L297)`, but `[impersonation.ts](/var/aqua-saas/web/modules/admin-panel/src/services/api/impersonation.ts#L60)` throws `Not implemented` for that path. The page still exposes the `View Actions` button at `[L613](/var/aqua-saas/web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx#L613)`.

Root cause: the audit/read surface is advertised in the product but has no live data source, so the modal can only fail or remain empty instead of showing real session history.

Cross-domain dependencies: `data-readback-auditor`, `schema-surface-parity-auditor`.

### MEDIUM-003: Tenant audit-log search only filters the current page client-side
`[TenantAuditLogPage.tsx](/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantAuditLogPage.tsx#L245)` computes `visibleEntries` by filtering the already-fetched `entries` array in memory at `[L246](/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantAuditLogPage.tsx#L246)`. Those entries come from `useTenantAuditLog(20)` at `[L211](/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantAuditLogPage.tsx#L211)`, so the search box does not search the full tenant log set, only the current page slice.

Root cause: the search affordance implies tenant-wide discovery, but the implementation is page-local and can hide matches that live on later server pages.

Cross-domain dependencies: `data-readback-auditor`, `list-visibility-auditor`.

### MEDIUM-004: AquaMobil messaging actions have dead-end handlers
`[ChatRoomPage.tsx](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx#L159)` leaves `handleDelete()` as a placeholder at `[L160](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx#L160)`. The composer also wires `onAttachmentPress` and `onVoiceRecordingComplete` to empty callbacks at `[L392](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx#L392)`, while `[MessageInput.tsx](/var/aqua-saas/web/apps/aquamobil/src/components/messaging/MessageInput.tsx#L338)` still renders an `Add attachment` button at `[L339](/var/aqua-saas/web/apps/aquamobil/src/components/messaging/MessageInput.tsx#L339)` and `[MessageBubble.tsx](/var/aqua-saas/web/apps/aquamobil/src/components/messaging/MessageBubble.tsx#L489)` still renders a `Delete` context-menu item at `[L489](/var/aqua-saas/web/apps/aquamobil/src/components/messaging/MessageBubble.tsx#L489)`.

Root cause: multiple visible messaging action surfaces are present, but the parent page never binds them to real backend mutations or file/voice workflows, so the controls silently no-op.

Cross-domain dependencies: `file-transfer-auditor`, `form-write-auditor`, `mobile-app-auditor`.

### MEDIUM-005: AquaMobil media viewer is an orphaned route with an empty data source
`[App.tsx](/var/aqua-saas/web/apps/aquamobil/src/App.tsx#L230)` exposes `/messages/media/:attachmentId` at `[L236](/var/aqua-saas/web/apps/aquamobil/src/App.tsx#L236)`, but `[MediaViewerPage.tsx](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/MediaViewerPage.tsx#L39)` uses a stub `useChannelMedia()` that always returns `[]` at `[L43](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/MediaViewerPage.tsx#L43)` and even hard-codes an empty channel id at `[L101](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/MediaViewerPage.tsx#L101)`.

Root cause: the viewer route exists as a product surface, but no live attachment query or channel context reaches it, so the promised pinch-to-zoom/download experience cannot show real media.

Cross-domain dependencies: `data-readback-auditor`, `schema-surface-parity-auditor`, `mobile-app-auditor`.

### LOW-006: Tenant database export control is a visible no-op
`[TenantDatabase.tsx](/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantDatabase.tsx#L431)` renders an `Export Schema` button at `[L438](/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantDatabase.tsx#L438)` with no `onClick`, no navigation target, and no attached API hook.

Root cause: the UI advertises an export action but never binds it to any observable behavior, so the affordance is misleading even though the rest of the page is read-only.

Cross-domain dependencies: `file-transfer-auditor`, `button-action-auditor`.

## Overall Assessment

The audited surfaces are not yet fully coherent as an end-to-end action map. The most important failure is the impersonation permission grant path, where a privileged UI control does not reach the backend contract. The remaining issues are mostly dead-end or partially wired action surfaces that weaken product confidence across tenant admin and AquaMobil.
