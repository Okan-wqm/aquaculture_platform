# Mobile App Auditor Recommendations: 2026-04-13 Full Platform E2E

Recommendations for findings in `docs/test-audits/mobile-app-auditor/2026-04-13-full-platform-e2e.md`.

## CRITICAL-001: Tenant-scope the offline queue

**Direction:** Add `tenantId` as a mandatory field on `StoredOperation`. Prefix queue keys with `pending_${tenantId}_${uuid}`. In `syncAllOperations`, filter operations by the current tenantId before replaying. On logout, clear only the current tenant's queue entries (in addition to the existing `clearAllOperations` call). On login, skip operations whose stored tenantId does not match the newly authenticated tenantId.

**Alternative (simpler):** Store `tenantId` on each `StoredOperation` and have `executeGraphQL` read the stored tenantId from the operation instead of the current auth context. This ensures the correct `X-Tenant-Id` header is sent even if the tenant changed. However, this requires the JWT token to also be valid for the stored tenantId, which may not hold after a tenant switch.

**Root-cause approach:** The queue store should be structurally partitioned the same way the cache store already is. This is a one-pattern-two-implementations inconsistency.

## HIGH-001/HIGH-002/HIGH-003: Wire ChatRoomPage to existing components

**Direction:** ChatRoomPage needs three changes:
1. Import `AttachmentPicker` and `useMediaUpload`. Add `isAttachmentPickerOpen` state. Wire `onAttachmentPress` to `setIsAttachmentPickerOpen(true)`. Wire `onFileSelect` to `uploadMedia(file).then(key => sendMessage({ attachmentKeys: [key], contentType: 'image'|'file' }))`.
2. Wire `onVoiceRecordingComplete` to upload the blob via `uploadMedia` (wrapping the Blob as a File) and send as `contentType: 'voice'`.
3. Wire `handleDelete` to call `addToQueue('deleteMessage', { id: messageId })` or directly via `graphqlRequest(DELETE_MESSAGE, { id: messageId })`.

All three underlying subsystems are complete. Only the ChatRoomPage integration is missing.

## HIGH-004: Wire MediaViewerPage to real attachment data

**Direction:** Replace the inline `useChannelMedia` stub with a real hook that queries the `channelMedia` GraphQL query (or constructs the media list from the messages query cache). Pass `channelId` via React Router state or a query parameter from the chat room navigation.

## MEDIUM-001: Fix service worker message type mismatch

**Direction:** Either:
- Change `messaging-sw.ts` L45 from `{ type: 'SYNC_MESSAGES' }` to `{ type: 'SYNC_COMPLETE' }`, OR
- Add a second listener in `useOfflineQueue.tsx` L226 for `'SYNC_MESSAGES'`, OR
- Rename both sides to a shared constant imported from a types file.

The third option is the enterprise-grade approach: define SW message types in a shared constants file.

## MEDIUM-002: Add NAVIGATE_TO_CHANNEL listener

**Direction:** Add a service worker message listener in the ChannelListPage or a top-level layout component that handles `NAVIGATE_TO_CHANNEL` by calling `navigate(`/messages/${channelId}`)`. This should be registered at the app shell level (e.g., in MobileLayout or App.tsx) so it works regardless of which page is open.

## MEDIUM-003: Complete OPERATION_LABELS in SyncStatusPage

**Direction:** Add the missing 13 operation types to `OPERATION_LABELS`:
```
clockIn: { label: 'Clock In', icon: '...' },
clockOut: { label: 'Clock Out', icon: '...' },
createLeaveRequest: { label: 'Leave Request', icon: '...' },
completeTask: { label: 'Complete Task', icon: '...' },
startTask: { label: 'Start Task', icon: '...' },
recordTransfer: { label: 'Transfer', icon: '...' },
createWaterQuality: { label: 'Water Quality', icon: '...' },
recordStockMovement: { label: 'Stock Movement', icon: '...' },
transferStock: { label: 'Stock Transfer', icon: '...' },
sendMessage: { label: 'Message', icon: '...' },
editMessage: { label: 'Edit Message', icon: '...' },
deleteMessage: { label: 'Delete Message', icon: '...' },
markMessagesRead: { label: 'Read Receipt', icon: '...' },
```

## MEDIUM-004: Scope last-sync timestamp per user

**Direction:** Change the localStorage key from `aquamobil_last_sync_at` to `aquamobil_last_sync_at_${userId}` (or `${tenantId}:${userId}`). Wire `handleSyncNow` to the sync completion path (either call it after `syncNow()` returns, or trigger it from the auto-sync effect on reconnect).

## MEDIUM-005: Scope clearCache to current tenant in AccountPage

**Direction:** Pass `tenantId` from `useAuth()` to `clearCache(tenantId)` in `handleClearCache`. The `clearCache` function already supports this parameter.

## MEDIUM-006: Add visibilitychange probe trigger

**Direction:** In `useNetworkStatus.ts`, add a `visibilitychange` listener that fires an immediate probe when the document becomes visible. This ensures the network status is fresh when the user returns to the app.

## MEDIUM-007: Drain offline message queue or unify with general queue

**Direction (preferred):** Remove the separate `queueOffline` path in `useSendMessage` and route offline messages through the general `addToQueue('sendMessage', ...)` from `useOfflineQueue`. This ensures they participate in the standard sync lifecycle. The general queue already has the `sendMessage` mutation defined and the dedup logic handles `idempotencyKey`.

**Direction (alternative):** Add a drain function that reads `messaging_offline_sends` from the cache and replays each entry via `sendMessage` mutation on reconnect. This requires a new effect in the messaging hooks that triggers on isOnline transition.
