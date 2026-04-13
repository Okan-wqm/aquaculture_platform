# AquaMobil Offline Sync Context Manager Report

BUDGET_STATUS: OK
ESTIMATED_INPUT_TOKENS: 16000
REPORT_COUNT: 1

**Date:** 2026-04-12
**Topic:** `2026-04-12-aquamobil-offline-sync`
**Scope:** AquaMobil mobile-only pilot review over auth/session, offline queue, sync status, notifications, messaging, permissions, and tenant partitioning

## Preserved Findings

### HIGH-001 -- write-gap, sync-gap

**Leave request mobile roundtrip is broken at create, dedup, and submit edges.**

Evidence:

- `web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx:81-103`
- `web/apps/aquamobil/src/hooks/useLeave.ts:187-202`
- `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:95-103`
- `web/apps/aquamobil/src/pwa/offline-queue.ts:95-176`
- `apps/hr-service/src/leave/dto/create-leave-request.input.ts:16-63`
- `apps/hr-service/src/leave/leave.resolver.ts:282-292`

Root cause:

- the queued mobile payload does not match `CreateLeaveRequestInput`: it omits required `employeeId` and `totalDays`, and uses `isHalfDay` instead of the backend half-day fields
- offline queue dedup for HR writes derives its resource key from `employeeId`; because the mobile leave payload omits `employeeId`, the dedup window never protects this path
- even if create somehow succeeded, `addToQueue('createLeaveRequest', ...)` returns the offline queue UUID, not the HR leave request aggregate ID
- the page then calls `submitRequest(queueId)` after a timeout, and `useSubmitLeaveRequest()` sends that value directly as the GraphQL `id`

Consequence:

- the mobile UI can claim "Request Submitted" while neither the create edge nor the submit transition is reliably pointed at the real domain record
- duplicate taps are not structurally suppressed on the queued leave path
- this is a write-truth failure, not a cosmetic timing issue

### HIGH-002 -- write-gap, sync-gap, visibility-gap

**Offline messaging persists into a separate IndexedDB queue that has no observed replay consumer and no user-visible sync surface.**

Evidence:

- `web/apps/aquamobil/src/hooks/useSendMessage.ts:28-29`
- `web/apps/aquamobil/src/hooks/useSendMessage.ts:197-214`
- `web/apps/aquamobil/src/hooks/useSendMessage.ts:222-232`
- `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:19-29`
- `web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx:15-17`
- `web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx:67-90`
- `web/apps/aquamobil/src/pages/HomePage.tsx:103-176`
- `web/apps/aquamobil/src/pages/account/AccountPage.tsx:579-613`
- repo-wide search for `messaging_offline_sends` only returns `web/apps/aquamobil/src/hooks/useSendMessage.ts`
- repo-wide search for `registerMessagingSync` only returns `web/apps/aquamobil/src/pwa/messaging-sw.ts`

Root cause:

- offline chat sends are stored under `messaging_offline_sends`
- no local replay hook, reconnect worker, or flush routine was found for that queue key
- the service-worker sync registration helper also appears orphaned, so the queue lacks both a stored replay owner and a registration path
- AquaMobil's visible sync surfaces only reflect the general offline operation queue, not this separate messaging queue

Consequence:

- offline chat sends can be durably stored but never durably delivered
- the app can report zero pending work while offline chat sends are still stranded locally
- the app has the shape of an offline messaging feature without a proved end-to-end replay path

### HIGH-003 -- sync-gap, visibility-gap

**The service worker posts messaging handoff events that the app does not handle, and its notification navigation path is inconsistent with AquaMobil's `/mobile` base.**

Evidence:

- `web/apps/aquamobil/src/pwa/messaging-sw.ts:36-46`
- `web/apps/aquamobil/src/pwa/messaging-sw.ts:121-138`
- `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:223-237`
- `web/apps/aquamobil/src/main.tsx:62`
- `web/apps/aquamobil/vite.config.ts:7`
- `web/apps/aquamobil/vite.config.ts:25-26`
- `web/apps/aquamobil/public/manifest.webmanifest:5-6`

Root cause:

- reconnect/background-sync path posts `SYNC_MESSAGES` to active windows
- notification-click focus path posts `NAVIGATE_TO_CHANNEL`
- the app-side service-worker message listener only handles `SYNC_COMPLETE`
- when a new window must be opened, the service worker targets `/messages` even though the app is mounted under `/mobile`

Consequence:

- background sync can fail to trigger client-side flush behavior when a window is already open
- clicking a push notification into an already-open messaging window can focus the window without actually navigating to the target channel
- clicking a push notification with no matching messaging window can open the wrong route root

### MEDIUM-004 -- access-gap

**Mobile feature gating fails open when the permission query errors and no cached permissions exist.**

Evidence:

- `web/apps/aquamobil/src/hooks/useMobilePermissions.ts:65-80`
- `web/apps/aquamobil/src/hooks/useMobilePermissions.ts:145-168`

Root cause:

- `FALLBACK_SETTINGS` enables every mobile feature
- GraphQL error or network error without cache applies that fallback

Consequence:

- page-level and control-level feature visibility can expand during permission-service failure
- backend guards may still stop writes, but the mobile access boundary becomes inconsistent exactly when the system is degraded

### MEDIUM-005 -- sync-gap, visibility-gap

**Task detail action semantics are inconsistent under offline or degraded conditions.**

Evidence:

- `web/apps/aquamobil/src/hooks/useTaskActions.ts:14-49`
- `web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx:75-129`

Root cause:

- `startTask` and `completeTask` fall back to queued work on request failure
- `TaskDetailPage` treats that return as a completed success path and shows definitive success copy
- checklist and note actions do not share the same offline fallback and simply fail silently

Consequence:

- task workflow truth becomes inconsistent across actions on the same screen
- operators can leave the task screen believing state has already changed durably when it has only been queued

### MEDIUM-006 -- visibility-gap

**Leave readback remains cache-stale after submit because the mobile mutation path does not invalidate or update leave queries before returning to the list.**

Evidence:

- `web/apps/aquamobil/src/hooks/useLeave.ts:110-142`
- `web/apps/aquamobil/src/hooks/useLeave.ts:187-202`
- `web/apps/aquamobil/src/pages/leave/MyLeavesPage.tsx:27-37`
- `web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx:102-103`
- `web/modules/hr-module/src/hooks/useLeaves.ts:332-349`

Root cause:

- mobile leave requests are cached with a 2-minute freshness window
- the mobile submit hook does not invalidate `leaveRequests`, `leaveBalances`, or set updated query data
- the request page routes back to `/leave` immediately after success copy
- the desktop HR leave path already implements the missing invalidation behavior

Consequence:

- even after a backend-accepted submit, the worker can return to a stale leave screen
- mobile leave readback does not currently prove convergence after submit

## What Looks Solid

- `web/apps/aquamobil/src/hooks/useAuth.tsx:96-118` and `web/apps/aquamobil/src/hooks/useAuth.tsx:280-306` perform strong shared-device cleanup on logout across offline queue, tenant cache, permission cache, biometric storage, and service-worker caches.
- `web/apps/aquamobil/src/pwa/offline-queue.ts:303-379` enforces tenant-scoped encrypted cache keys and tenant-aware clearing semantics.
- `web/apps/aquamobil/src/services/authenticated-fetch.ts:54-90` updates both bearer token and `X-Tenant-Id` after silent refresh, which is important for tenant-stable retries.

## Dependency Graph

- HIGH-001: write-gap -> sync-gap -> visibility-gap
- HIGH-002: write-gap -> sync-gap -> visibility-gap
- HIGH-003: sync-gap -> visibility-gap
- MEDIUM-004: access-gap
- MEDIUM-005: sync-gap -> visibility-gap
- MEDIUM-006: visibility-gap

## Synthesis Note

This pilot still does not show a broad tenant-cache leak in AquaMobil's local-storage design. The blocking issues remain around mobile async truth: contract-valid payloads, dedup keys, authoritative domain IDs, replay ownership, service-worker-to-app handoff contracts, basename-aware notification routing, and readback surfaces that can still present stale state after a write.
