# Form Write Auditor: `2026-04-11-full-platform-e2e`

Scope checked: `web/**`, `web/apps/aquamobil/**`, and the corresponding `apps/**`, `libs/**`, `platform/**`, and `database/**` surfaces needed to trace create/edit/update/delete write paths end to end.

## Findings

### HIGH-001: AquaMobil leave submission writes server state but does not invalidate the visible read model
`[LeaveRequestPage.tsx](/var/aqua-saas/web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx#L74)` creates the leave draft through `addToQueue('createLeaveRequest', ...)` at `[L81-L87](/var/aqua-saas/web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx#L81)` and then calls `submitRequest(queueId)` later at `[L91-L99](/var/aqua-saas/web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx#L91)`, but neither path invalidates the queries that render the destination screen. The write helper in `[useLeave.ts](/var/aqua-saas/web/apps/aquamobil/src/hooks/useLeave.ts#L187)` only flips a local loading flag at `[L190-L203](/var/aqua-saas/web/apps/aquamobil/src/hooks/useLeave.ts#L190)`, while `[MyLeavesPage.tsx](/var/aqua-saas/web/apps/aquamobil/src/pages/leave/MyLeavesPage.tsx#L24)` reads from `useMyLeaveRequests()` / `useMyLeaveBalances()` with stale windows and IndexedDB fallback at `[L27-L37](/var/aqua-saas/web/apps/aquamobil/src/pages/leave/MyLeavesPage.tsx#L27)` and `[useLeave.ts](/var/aqua-saas/web/apps/aquamobil/src/hooks/useLeave.ts#L65-L100)`.

Root cause: the create/submit flow is split across offline queue, GraphQL mutation, and a cached read screen, but the mutation layer never marks the leave list or balance queries stale. A successful submit can therefore disappear behind fresh cache values until the stale window expires or the user manually refreshes.

Cross-domain dependencies: `mobile-app-auditor`, `data-readback-auditor`, `workflow-state-auditor`.

### HIGH-002: AquaMobil message delete is exposed in the UI but the handler is a no-op
`[MessageBubble.tsx](/var/aqua-saas/web/apps/aquamobil/src/components/messaging/MessageBubble.tsx#L489)` renders a `Delete` context-menu item at `[L489-L496](/var/aqua-saas/web/apps/aquamobil/src/components/messaging/MessageBubble.tsx#L489)`, and `[ChatRoomPage.tsx](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx#L349)` passes `onDelete={isOwn ? handleDelete : undefined}` at `[L350-L369](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx#L350)`. The handler itself is an empty placeholder at `[L159-L164](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx#L159)`, even though the GraphQL contract already defines `[DELETE_MESSAGE](/var/aqua-saas/web/apps/aquamobil/src/graphql/messaging-operations.ts#L305)` at `[L306-L310](/var/aqua-saas/web/apps/aquamobil/src/graphql/messaging-operations.ts#L306)`.

Root cause: the product surface advertises soft-delete, but the page never binds the action to the existing mutation contract, so the delete command silently closes the menu and performs no write.

Cross-domain dependencies: `button-action-auditor`, `form-write-auditor`, `mobile-app-auditor`.

### HIGH-003: Channel edit is promised in AquaMobil but there is no wired update path
`[ChannelSettingsPage.tsx](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/ChannelSettingsPage.tsx#L239)` renders an edit affordance for editable group channels at `[L239-L242](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/ChannelSettingsPage.tsx#L239)`, but the button has no `onClick`, no modal, and no mutation wiring. The supporting hook `[useChannelActions.ts](/var/aqua-saas/web/apps/aquamobil/src/hooks/useChannelActions.ts#L34)` only exposes notification preference, leave, and archive actions at `[L39-L133](/var/aqua-saas/web/apps/aquamobil/src/hooks/useChannelActions.ts#L39)`, even though the GraphQL layer already exposes `[UPDATE_CHANNEL](/var/aqua-saas/web/apps/aquamobil/src/graphql/messaging-operations.ts#L232)` at `[L233-L239](/var/aqua-saas/web/apps/aquamobil/src/graphql/messaging-operations.ts#L233)`.

Root cause: the UI advertises channel rename/description edit capability, but the frontend never adds the corresponding form or mutation path, so the write surface stops at an inert pencil icon.

Cross-domain dependencies: `contract-parity-auditor`, `button-action-auditor`, `form-write-auditor`.

### MEDIUM-004: Admin AI persona configuration is presentation-only and does not persist
`[MessagingAiPersonasPage.tsx](/var/aqua-saas/web/modules/admin-panel/src/pages/messaging/MessagingAiPersonasPage.tsx#L184)` mutates only local component state in `handleToggle()` at `[L189-L196](/var/aqua-saas/web/modules/admin-panel/src/pages/messaging/MessagingAiPersonasPage.tsx#L189)` and explicitly leaves persistence as `TODO: Persist toggle via admin API mutation`. The `Add Custom Persona` button at `[L211-L217](/var/aqua-saas/web/modules/admin-panel/src/pages/messaging/MessagingAiPersonasPage.tsx#L211)` opens a future-release placeholder card instead of a save flow. On the backend, `[AiPersonasRegistryService](/var/aqua-saas/apps/messaging-service/src/ai/services/ai-personas-registry.service.ts#L102)` still returns `DEFAULT_PERSONAS` for every tenant at `[L107-L115](/var/aqua-saas/apps/messaging-service/src/ai/services/ai-personas-registry.service.ts#L107)` and says per-tenant configuration is future work at `[L7-L8](/var/aqua-saas/apps/messaging-service/src/ai/services/ai-personas-registry.service.ts#L7)` and `[L128-L141](/var/aqua-saas/apps/messaging-service/src/ai/services/ai-personas-registry.service.ts#L128)`.

Root cause: the route exists as a configuration surface, but both the admin UI and the registry service are still static, so toggles and custom persona actions do not survive a refresh and cannot change runtime routing.

Cross-domain dependencies: `schema-surface-parity-auditor`, `data-readback-auditor`, `mobile-app-auditor`.

## Overall Assessment

The audited write surfaces are not yet fully end-to-end coherent. The most important failures are the leave submission cache gap and the messaging delete/edit gaps, because those are visible user actions that do not round-trip cleanly into persisted, reread state. The AI persona screen is lower severity because the backend service itself still documents the feature as future work, but it should be treated as a placeholder rather than a production configuration surface.
