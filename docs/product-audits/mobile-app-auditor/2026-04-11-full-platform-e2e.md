# Mobile App Auditor: 2026-04-11 Full Platform E2E

Scope: AquaMobil offline/reconnect behavior, queued writes, cached truth, action availability, local storage partitioning, sync status, notifications, attachments/media, and tenant-safe local state.

## Findings

### HIGH-001 - AquaMobil chat actions are visibly present but several mobile handlers are no-ops
- File refs: [web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx#L381), [web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx#L392), [web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx#L395), [web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx#L159)
- Root cause: the mobile chat screen exposes attachment, voice-recording, and delete affordances, but `onAttachmentPress` and `onVoiceRecordingComplete` are empty callbacks and `handleDelete` is only a TODO placeholder. The attachment pipeline is also not instantiated in this screen: `AttachmentPicker` is never mounted and `useMediaUpload` is never used anywhere in AquaMobil. The UI therefore advertises actions that cannot complete a roundtrip.
- Impact: users can tap visible mobile actions without producing a persisted message attachment, voice note, or delete mutation. This is a direct action-availability failure on a primary field-worker surface.
- Cross-domain dependency: `file-transfer-auditor`, `button-action-auditor`, `workflow-state-auditor`

### HIGH-002 - AquaMobil media viewer cannot load or download real attachments
- File refs: [web/apps/aquamobil/src/pages/messaging/MediaViewerPage.tsx](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/MediaViewerPage.tsx#L39), [web/apps/aquamobil/src/pages/messaging/MediaViewerPage.tsx](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/MediaViewerPage.tsx#L43), [web/apps/aquamobil/src/pages/messaging/MediaViewerPage.tsx](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/MediaViewerPage.tsx#L101), [web/apps/aquamobil/src/pages/messaging/MediaViewerPage.tsx](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/MediaViewerPage.tsx#L104)
- Root cause: `useChannelMedia` is a hard stub that always returns an empty media array, and the page calls it with `''` instead of a real channel context. The viewer can resolve an `attachmentId`, but it has no attachment source, so the page never reaches a real preview/download target.
- Impact: attachment and media viewing is a dead-end route on mobile. Users cannot inspect or download the assets that the chat UI implies are available.
- Cross-domain dependency: `file-transfer-auditor`

### MEDIUM-003 - Service worker sync completion and the mobile queue provider speak different message contracts
- File refs: [web/apps/aquamobil/src/pwa/messaging-sw.ts](/var/aqua-saas/web/apps/aquamobil/src/pwa/messaging-sw.ts#L42), [web/apps/aquamobil/src/hooks/useOfflineQueue.tsx](/var/aqua-saas/web/apps/aquamobil/src/hooks/useOfflineQueue.tsx#L223)
- Root cause: the service worker posts `SYNC_MESSAGES` to window clients after a sync event, but the only AquaMobil message listener in the queue provider listens for `SYNC_COMPLETE`. There is no consumer for the message type the worker actually emits.
- Impact: after background sync or reconnect-driven sync, the queue badge and pending-op state can remain stale until another explicit refresh path runs. That weakens mobile sync truth and makes the sync status surface unreliable.
- Cross-domain dependency: `realtime-sync-auditor`, `list-visibility-auditor`

### MEDIUM-004 - Account sync truth is both shared across sessions and effectively orphaned from real sync completion
- File refs: [web/apps/aquamobil/src/pages/account/AccountPage.tsx](/var/aqua-saas/web/apps/aquamobil/src/pages/account/AccountPage.tsx#L30), [web/apps/aquamobil/src/pages/account/AccountPage.tsx](/var/aqua-saas/web/apps/aquamobil/src/pages/account/AccountPage.tsx#L87), [web/apps/aquamobil/src/pages/account/AccountPage.tsx](/var/aqua-saas/web/apps/aquamobil/src/pages/account/AccountPage.tsx#L419), [web/apps/aquamobil/src/pages/account/AccountPage.tsx](/var/aqua-saas/web/apps/aquamobil/src/pages/account/AccountPage.tsx#L431), [web/apps/aquamobil/src/pages/account/AccountPage.tsx](/var/aqua-saas/web/apps/aquamobil/src/pages/account/AccountPage.tsx#L679)
- Root cause: the footer sync timestamp is stored in a single global `aquamobil_last_sync_at` localStorage key, but the only write path is `handleSyncNow`, which is not wired into any actual sync action. The visible "Last synced" label therefore shares one device-wide value across users/tenants and does not track real sync completion.
- Impact: shared-device sessions can display another user's sync time, and the account page can report stale sync truth even after a successful mobile sync. This is a tenant-safe local-state and mobile status-truth defect.
- Cross-domain dependency: `tenant-isolation-auditor`, `realtime-sync-auditor`

### MEDIUM-005 - Notification taps do not deep-link into the selected channel
- File refs: [web/apps/aquamobil/src/pwa/messaging-sw.ts](/var/aqua-saas/web/apps/aquamobil/src/pwa/messaging-sw.ts#L111), [web/apps/aquamobil/src/pwa/messaging-sw.ts](/var/aqua-saas/web/apps/aquamobil/src/pwa/messaging-sw.ts#L125), [web/apps/aquamobil/src/hooks/useOfflineQueue.tsx](/var/aqua-saas/web/apps/aquamobil/src/hooks/useOfflineQueue.tsx#L223)
- Root cause: the service worker emits `NAVIGATE_TO_CHANNEL` when a push notification is tapped, but the only registered window message listener in AquaMobil handles sync completion and ignores navigation messages. The focused client is brought to the foreground, but the requested channel navigation never happens.
- Impact: push notifications advertise a direct jump into the conversation, but the app lands on a generic messages surface instead. On mobile, that breaks the notification-to-action roundtrip and leaves the user to manually hunt for the target channel.
- Cross-domain dependency: `realtime-sync-auditor`, `button-action-auditor`

## Verdict

The AquaMobil mobile surface has the right architectural ingredients for offline queueing, push, and attachment flows, but several of the user-facing roundtrips are still broken at the contract layer: chat actions are stubbed, the media viewer is empty, sync completion messages do not match, the last-sync indicator is both stale and shared, and notification taps do not deep-link to the target channel.

## Review Notes

- Review-only audit; no source files were modified outside this report.
