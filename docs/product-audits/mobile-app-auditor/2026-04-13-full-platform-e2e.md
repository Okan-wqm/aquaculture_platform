# Mobile App Auditor: 2026-04-13 Full Platform E2E

Scope: AquaMobil offline/reconnect behavior, queued writes, cached truth, action availability, local storage partitioning, sync status, notifications, attachments/media, and tenant-safe local state.

Prior cycle: `docs/test-audits/mobile-app-auditor/2026-04-11-full-platform-e2e.md` (5 findings). Commit `79ce984f` addressed 12 findings.

## Summary of Prior Cycle Status

| Prior Finding | Status | Notes |
|---|---|---|
| HIGH-001 (chat actions are no-ops) | OPEN | `onAttachmentPress` and `onVoiceRecordingComplete` are still empty callbacks; `handleDelete` is still a TODO placeholder. AttachmentPicker component exists but is never mounted in ChatRoomPage. |
| HIGH-002 (media viewer dead-end) | OPEN | `useChannelMedia` still returns hard-coded empty array. MediaViewerPage still passes `''` as channelId. |
| MEDIUM-003 (SW sync message contract mismatch) | OPEN | Service worker still posts `SYNC_MESSAGES`; OfflineProvider still listens only for `SYNC_COMPLETE`. |
| MEDIUM-004 (shared sync timestamp) | OPEN | `aquamobil_last_sync_at` is still a single global localStorage key with no user/tenant scoping. `handleSyncNow` is defined but `void`-suppressed and not wired to any button. |
| MEDIUM-005 (notification deep-link broken) | OPEN | `NAVIGATE_TO_CHANNEL` is still posted by SW but no window-side listener consumes it. |

All five prior findings remain open. This is the second consecutive audit cycle with no resolution, escalating these to systemic mobile state-management debt per operating instructions.

---

## Findings

### CRITICAL-001 -- Offline queue operations are not partitioned by tenant; cross-tenant replay is structurally possible

- **File refs:** `web/apps/aquamobil/src/pwa/offline-queue.ts` L1-L9 (queueStore definition), L137-L218 (queueOperation), L480-L518 (syncAllOperations); `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx` L239-L249 (addToQueue), L251-L299 (executeGraphQL)
- **Root cause:** The IndexedDB queue store (`aquamobil-queue`) uses key format `pending_{uuid}` with no tenant prefix. The `StoredOperation` interface stores `type`, `_enc`, `_resourceId`, `createdAt`, `retryCount`, `status` -- but NOT `tenantId`. When `syncAllOperations` runs, it fetches ALL pending operations from the store and replays them using whatever `tenantId` and `accessToken` are currently active in the auth context. If User A on Tenant X queues operations offline, logs out, and User B on Tenant Y logs in on the same device, the sync will attempt to replay Tenant X's operations against Tenant Y's backend context. The `executeGraphQL` function injects the CURRENT auth context's `tenantId` as the `X-Tenant-Id` header (line 278), not the tenantId that was active when the operation was queued.
- **Contrast with cache layer:** The data cache layer (`cacheData`/`getCachedData`) correctly uses `cache_${tenantId}:${key}` key format (FE-CRITICAL-002 fix). The queue layer has no equivalent tenant scoping.
- **Impact:** Cross-tenant data mutation. A mortality record, harvest, or stock movement queued for Tenant X could be replayed against Tenant Y. This is a data integrity and tenant isolation violation at the storage layer.
- **Mitigation factors:** Logout calls `clearAllOperations()` which purges the queue. However, the queue is NOT cleared on token refresh or tenant switch within the same session (e.g., if the backend supports multi-tenant users). The encryption-at-rest (SEC-03) makes queued payloads unreadable after a session key rotation (page reload), but this is a crash-recovery safeguard, not a tenant isolation mechanism.
- **Cross-domain dependency:** `tenant-isolation-auditor`

### HIGH-001 -- Chat attachment pipeline is fully disconnected: AttachmentPicker component exists but is never mounted

- **File refs:** `web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx` L382-L413 (MessageInput usage), L392-L394 (empty onAttachmentPress and onVoiceRecordingComplete); `web/apps/aquamobil/src/components/messaging/AttachmentPicker.tsx` (complete component, 237 lines); `web/apps/aquamobil/src/hooks/useMediaUpload.ts` (complete hook, 276 lines); `web/apps/aquamobil/src/components/messaging/MessageInput.tsx` L339-L351 (attachment button rendered and clickable)
- **Root cause:** ChatRoomPage renders `<MessageInput>` with `onAttachmentPress={() => { /* TODO */ }}`. The `AttachmentPicker` component is fully implemented (Camera/Gallery/File picker with size validation), and the `useMediaUpload` hook is fully implemented (presigned URL upload with progress, compression, cancellation). However, ChatRoomPage never imports AttachmentPicker, never calls useMediaUpload, and never manages the `isOpen` state for the picker sheet. The MessageInput component renders a visible, tappable paperclip button that calls `onAttachmentPress` -- which does nothing.
- **Impact:** Field workers see a functioning attachment button in every chat conversation. Tapping it produces no visible response. This is a primary mobile action-availability failure on a core enterprise communication surface. The backend pipeline (presigned URLs, MinIO storage) is presumably ready; only the ChatRoomPage wiring is missing.
- **Prior cycle:** Reported as HIGH-001 in 2026-04-11 audit. Still open.
- **Cross-domain dependency:** `file-transfer-auditor`, `button-action-auditor`

### HIGH-002 -- Chat voice recording pipeline is disconnected: VoiceRecorder works but output is discarded

- **File refs:** `web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx` L395-L397 (empty onVoiceRecordingComplete); `web/apps/aquamobil/src/components/messaging/MessageInput.tsx` L260-L275 (voice toggle and complete handlers), L280-L293 (VoiceRecorder rendering); `web/apps/aquamobil/src/hooks/useVoiceRecorder.ts` (complete hook, 237 lines)
- **Root cause:** MessageInput correctly toggles to `<VoiceRecorder>` when the mic button is tapped. The VoiceRecorder uses MediaRecorder to produce an audio Blob. When recording completes, `handleVoiceComplete` calls `onVoiceRecordingComplete?.(blob, durationSeconds, mimeType)`. In ChatRoomPage, `onVoiceRecordingComplete` receives `(blob, durationSeconds, mimeType)` but the callback body is `{ // TODO: upload voice recording and send as voice message }`. The blob is silently discarded.
- **Impact:** Users can record voice notes (the UI shows recording time, waveform, and stop button), but completing the recording produces no message. The user perceives a successful recording action, but no data is persisted or sent. This is a false-success UX failure.
- **Prior cycle:** Part of HIGH-001 in 2026-04-11 audit. Still open.
- **Cross-domain dependency:** `file-transfer-auditor`, `button-action-auditor`

### HIGH-003 -- Chat message delete is a TODO stub; delete button is rendered for own messages

- **File refs:** `web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx` L159-L163 (handleDelete), L368 (onDelete={isOwn ? handleDelete : undefined})
- **Root cause:** `handleDelete` is `async (messageId: string) => { // TODO: wire to deleteMessage GraphQL mutation }`. The MessageBubble context menu renders a "Delete" action for the user's own messages (`onDelete={isOwn ? handleDelete : undefined}`). The offline queue already has a `deleteMessage` mutation definition (L179-L182 in useOfflineQueue.tsx). The backend socket handler for `messageDeleted` events is wired in useMessageSocket.ts. Only the ChatRoomPage-level handler is missing.
- **Impact:** Users can tap "Delete" on their own messages with no effect. The message remains visible to all participants. This is an action-availability gap that affects message governance (e.g., retracting sensitive operational data shared by mistake).
- **Cross-domain dependency:** `button-action-auditor`, `workflow-state-auditor`

### HIGH-004 -- Media viewer is a dead-end: useChannelMedia returns hardcoded empty array

- **File refs:** `web/apps/aquamobil/src/pages/messaging/MediaViewerPage.tsx` L43-L49 (useChannelMedia stub), L104 (calling with empty string channelId)
- **Root cause:** `useChannelMedia` is defined inline in MediaViewerPage as `function useChannelMedia(_channelId: string) { return { media: [], loading: false, error: null }; }`. The page cannot resolve any attachment ID to a viewable media item because the source array is always empty. The route `/messages/media/:attachmentId` is registered in App.tsx (line 236), and message bubbles with image/file content types render correctly in the chat, but navigating to the media viewer shows "Media not found" every time.
- **Impact:** Attachment inspection and download from the dedicated viewer is impossible. The chat room can display inline image thumbnails and file cards, but the full-screen viewer with pinch-to-zoom and swipe navigation is nonfunctional.
- **Prior cycle:** Reported as HIGH-002 in 2026-04-11 audit. Still open.
- **Cross-domain dependency:** `file-transfer-auditor`

### MEDIUM-001 -- Service worker posts SYNC_MESSAGES but OfflineProvider listens for SYNC_COMPLETE

- **File refs:** `web/apps/aquamobil/src/pwa/messaging-sw.ts` L42-L46 (posts `SYNC_MESSAGES`); `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx` L224-L237 (listens for `SYNC_COMPLETE`)
- **Root cause:** The service worker `notifyClientsToSync()` function (messaging-sw.ts L43-L46) posts `{ type: 'SYNC_MESSAGES' }` to all window clients when the browser fires a `sync` event. The OfflineProvider's message listener (useOfflineQueue.tsx L226) checks for `event.data?.type === 'SYNC_COMPLETE'`. These are different string values. No code anywhere posts a `SYNC_COMPLETE` message. No code anywhere listens for `SYNC_MESSAGES` in the window context.
- **Impact:** After background sync fires (connectivity restored while app is backgrounded), the queue badge count and pending operations list remain stale. The queue refreshes only via explicit user action (pull-to-refresh, navigate to Sync Status) or the periodic 30-second retry timer. On mobile, this creates a confusing "sync should have happened but the badge didn't update" experience.
- **Prior cycle:** Reported as MEDIUM-003 in 2026-04-11 audit. Still open.
- **Cross-domain dependency:** `realtime-sync-auditor`

### MEDIUM-002 -- Notification tap deep-link NAVIGATE_TO_CHANNEL is posted but never consumed

- **File refs:** `web/apps/aquamobil/src/pwa/messaging-sw.ts` L126-L138 (posts `NAVIGATE_TO_CHANNEL` and focuses client); `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx` L224-L237 (only listener in app, listens for `SYNC_COMPLETE`)
- **Root cause:** When a user taps a push notification, `handleNotificationClick` in the service worker finds an existing window client with `/messages` in its URL and posts `{ type: 'NAVIGATE_TO_CHANNEL', channelId }`. The client window is focused, but there is no message event listener anywhere in AquaMobil that handles `NAVIGATE_TO_CHANNEL`. The user lands on whatever messages page was open, not the target channel.
- **Impact:** Push notification deep-linking is broken. Users must manually navigate to the correct conversation after tapping a notification. On a mobile device with slow navigation, this breaks the expected notification-to-action roundtrip.
- **Prior cycle:** Reported as MEDIUM-005 in 2026-04-11 audit. Still open.
- **Cross-domain dependency:** `realtime-sync-auditor`, `button-action-auditor`

### MEDIUM-003 -- Sync Status page OPERATION_LABELS only covers 4 of 17 operation types

- **File refs:** `web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx` L8-L13 (OPERATION_LABELS)
- **Root cause:** OPERATION_LABELS maps only `recordMortality`, `recordCull`, `createHarvestRecord`, and `recordFeeding`. The offline queue supports 17 operation types (see `web/apps/aquamobil/src/types/index.ts` L227): `clockIn`, `clockOut`, `createLeaveRequest`, `completeTask`, `startTask`, `recordTransfer`, `createWaterQuality`, `recordStockMovement`, `transferStock`, `sendMessage`, `editMessage`, `deleteMessage`, `markMessagesRead` are all unmapped. Any of these operations in the queue will render as `{ label: op.type, icon: '...' }` via the fallback at line 91, showing raw camelCase strings like "clockIn" or "transferStock" instead of user-friendly labels.
- **Impact:** Field workers viewing the Sync Status page see cryptic operation type identifiers for 13 of 17 possible queued operation types. This degrades mobile UX and makes it difficult for operators to understand what is pending sync.
- **Cross-domain dependency:** `list-visibility-auditor`

### MEDIUM-004 -- Account page last-sync timestamp is global, not per-user/per-tenant

- **File refs:** `web/apps/aquamobil/src/pages/account/AccountPage.tsx` L31 (LAST_SYNC_KEY constant), L87-L93 (getLastSyncTime), L419-L428 (handleSyncNow writes timestamp), L679-L682 (footer renders lastSyncLabel)
- **Root cause:** The localStorage key `aquamobil_last_sync_at` is a single device-wide value. It is not scoped by userId or tenantId. On shared field devices, when User A syncs and then User B logs in, User B sees User A's last sync time in the account page footer. Additionally, `handleSyncNow` (the only writer) is defined but suppressed with `void handleSyncNow` at line 433 and is not wired to any clickable element -- the Sync Status row navigates to `/sync` instead of calling it inline. The sync timestamp is therefore only written if `handleSyncNow` is called programmatically, which currently never happens from the UI.
- **Impact:** The "Last synced" label in the account footer is both shared across users and effectively always "Never" because the write path is dead code. This is a mobile status-truth defect on a visible surface.
- **Prior cycle:** Reported as MEDIUM-004 in 2026-04-11 audit. Still open.
- **Cross-domain dependency:** `tenant-isolation-auditor`

### MEDIUM-005 -- Account page "Clear Cache" clears ALL tenants' cache data, not just the current tenant

- **File refs:** `web/apps/aquamobil/src/pages/account/AccountPage.tsx` L435-L444 (handleClearCache calls `clearCache()` with no tenantId); `web/apps/aquamobil/src/pwa/offline-queue.ts` L381-L388 (clearCache function)
- **Root cause:** `handleClearCache` calls `clearCache()` without passing `tenantId`. The `clearCache` function (offline-queue.ts L381-L388) accepts an optional tenantId parameter -- when omitted, it deletes ALL cache entries (all tenants). While this is the correct behavior for logout (clear everything), for the "Clear Cache" button in the Account page it should only clear the current tenant's cache. A Tenant X admin clearing cache also destroys any cached data belonging to Tenant Y if the device was previously used by a different tenant.
- **Impact:** On shared devices, cache clearing has a blast radius beyond the current tenant. This is a minor tenant isolation defect in the explicit user action path (as opposed to the implicit logout path where full-clear is correct).
- **Cross-domain dependency:** `tenant-isolation-auditor`

### MEDIUM-006 -- No visibilitychange/resume refresh for mobile app-foreground scenarios

- **File refs:** `web/apps/aquamobil/src/hooks/useNetworkStatus.ts` (no visibilitychange listener); `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx` (no visibilitychange listener); `web/apps/aquamobil/src/App.tsx` (no visibilitychange handler)
- **Root cause:** When a mobile PWA is backgrounded (user switches to another app) and then foregrounded, the `visibilitychange` event fires. AquaMobil has no listener for this event anywhere in its codebase (confirmed by grep). The network status probe runs on a 30-second timer which will eventually fire, and TanStack Query's `refetchOnWindowFocus` covers SOME hooks, but the probe timer and the offline queue sync-on-reconnect logic are not triggered by app resume. If the device goes offline while backgrounded and comes back online before the app is foregrounded, the probe timer may not have fired yet, leaving the app in a stale "offline" state until the next 30s tick.
- **Impact:** After app resume, there can be up to 30 seconds where the app shows "Offline" even though connectivity has been restored. Queued operations are not immediately flushed on resume. This is a mobile-specific timing gap.
- **Cross-domain dependency:** `realtime-sync-auditor`

### MEDIUM-007 -- Offline message queue (useSendMessage) uses a separate storage path from the general offline queue

- **File refs:** `web/apps/aquamobil/src/hooks/useSendMessage.ts` L29 (OFFLINE_QUEUE_KEY), L197-L216 (queueOffline); `web/apps/aquamobil/src/pwa/offline-queue.ts` L137-L218 (queueOperation); `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx` L157-L187 (MUTATIONS includes sendMessage/editMessage/deleteMessage/markMessagesRead)
- **Root cause:** There are TWO offline message queuing paths. Path 1: `useSendMessage.queueOffline()` stores messages in the encrypted cache under key `messaging_offline_sends` via `cacheData(tenantId, OFFLINE_QUEUE_KEY, queue)`. Path 2: The general `addToQueue('sendMessage', ...)` in the OfflineProvider stores operations in the queue IndexedDB store. The `useSendMessage` hook checks `isOnline` and falls back to its own `queueOffline` path, but there is no code that ever drains the `messaging_offline_sends` cache back into the general queue or sends them directly. The messages queued via Path 1 are stored as a tenant-scoped cache entry with 7-day TTL but are never consumed on reconnect.
- **Impact:** Messages sent while offline via the chat UI are queued in IndexedDB but never delivered. The user sees the message in optimistic UI (with pending status), but when coming back online, nothing triggers the `messaging_offline_sends` cache to be drained. The general offline queue's `syncAllOperations` only processes operations from the `aquamobil-queue` IndexedDB store. This is a false-success offline write path -- the user believes the message will sync, but it never will.
- **Cross-domain dependency:** `realtime-sync-auditor`, `form-write-auditor`

### LOW-001 -- WebAuthn credential IDs and biometric email in localStorage are not tenant-scoped

- **File refs:** `web/apps/aquamobil/src/hooks/useWebAuthn.ts` L502-L528 (CREDENTIAL_IDS_KEY, saveCredentialIdLocally, removeCredentialIdLocally), L548-L564 (storeBiometricEmail, getStoredBiometricEmail), L567-L577 (clearBiometricData)
- **Root cause:** localStorage keys `webauthn_credential_ids` and `webauthn_email` are device-global. On a shared device, if User A from Tenant X registers biometric credentials, then logs out, User B from Tenant Y sees User A's email pre-filled in the biometric login flow (via `getStoredBiometricEmail()`). The credential IDs are also shared. `clearBiometricData()` is called on logout, which mitigates this in the normal flow, but if the app crashes or the user force-closes without logging out, the data persists.
- **Impact:** Minor information leakage of email address across users on shared devices in edge cases. The credential IDs themselves are public identifiers (not secrets), and the WebAuthn ceremony would fail for the wrong user anyway. The email pre-fill is the primary concern.
- **Cross-domain dependency:** `tenant-isolation-auditor`

### LOW-002 -- Dark mode preference in localStorage is not scoped per user

- **File refs:** `web/apps/aquamobil/src/hooks/useDarkMode.ts` L29 (STORAGE_KEY = 'aquamobil_dark_mode')
- **Root cause:** The dark mode preference is stored in a single `aquamobil_dark_mode` localStorage key. On shared devices, one user's theme preference persists to the next user's session.
- **Impact:** Cosmetic. A user who prefers dark mode logs in and finds the previous user's light mode preference. Not a data integrity or security issue, but breaks per-user personalization on shared devices.

---

## Architecture Assessment

### What improved since prior cycle

1. **Data cache tenant isolation** (FE-CRITICAL-002): The `cacheData`/`getCachedData` functions now require `tenantId` as a mandatory first parameter and include it in the IndexedDB key. This structurally prevents cross-tenant cache reads.
2. **Payload encryption at rest** (SEC-03): Queue operations and cache entries are AES-GCM encrypted with a per-session key. This prevents trivial extraction via DevTools.
3. **Offline queue retry policy** (BUG-17): Failed operations are now automatically retried with exponential backoff, and permanent vs. transient errors are distinguished.
4. **Token refresh before sync**: The `syncNow` function proactively refreshes the JWT if it expires within 60 seconds, preventing mid-batch 401s.
5. **Network connectivity probe** (BUG-15/17): Uses `/health/live` instead of HEAD /graphql, with periodic probing and faster reconnect detection.

### Systemic debt: Messaging feature completeness

The messaging feature (ADR-012) has its architectural ingredients in place:
- AttachmentPicker component: fully implemented
- useMediaUpload hook: fully implemented (presigned URL, progress, compression)
- VoiceRecorder component: fully implemented
- useVoiceRecorder hook: fully implemented (MediaRecorder, codec detection, timer)
- Offline queue mutations: sendMessage, editMessage, deleteMessage, markMessagesRead all defined
- Socket.IO real-time: newMessage, messageUpdated, messageDeleted, readReceipt all wired
- Service worker: push notifications, background sync, cache strategies all present

However, **none of the upload/recording/delete actions are wired at the page level**. The ChatRoomPage is the integration point, and it has TODO comments in three critical callbacks. This has been reported for two consecutive audit cycles.

### Systemic debt: Service worker message contract

The SW posts `SYNC_MESSAGES` and `NAVIGATE_TO_CHANNEL`, but the only window-side listener checks for `SYNC_COMPLETE`. This disconnect has persisted for two cycles. The fix is a 2-line change (either rename the SW message type or add listeners for the SW's actual types), but it has not been addressed.

### Systemic debt: Queue tenant isolation

The general offline queue (`aquamobil-queue` IndexedDB store) stores operations without tenant context. The data cache was fixed with tenant-scoped keys, but the queue was not. This is the single most impactful finding in this audit because it can cause cross-tenant data mutations on shared devices.

---

## Recommendations

See `docs/recommendations/test-audits/mobile-app-auditor/2026-04-13-full-platform-e2e.md` for detailed implementation recommendations.

## Verdict

The AquaMobil mobile surface has solid architectural foundations: encrypted offline storage, tenant-scoped data cache, robust retry logic, real network connectivity probing, and comprehensive service worker support. However, the offline QUEUE layer (as opposed to the cache layer) is not tenant-scoped, creating a CRITICAL cross-tenant mutation risk on shared devices. The messaging feature's upload/recording/delete actions remain unwired at the integration layer for a second consecutive cycle. The service worker message contract mismatch and notification deep-link failure also persist. The separately-queued offline messages in `useSendMessage` are stored but never drained on reconnect, creating a false-success offline write path.

## Review Notes

- Review-only audit; no source files were modified.
- Prior cycle findings checked against current source: all 5 remain OPEN.
- 12 new or persisted findings identified in this cycle.
