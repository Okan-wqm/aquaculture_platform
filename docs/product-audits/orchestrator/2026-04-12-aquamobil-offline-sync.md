# AquaMobil Offline Sync Orchestrator Report

**Date:** 2026-04-12
**Topic:** `2026-04-12-aquamobil-offline-sync`
**Scope:** AquaMobil-only pilot audit following the mobile profile in `.claude/agents/product-audit/INVOCATION-PACK.md`

## Verdict

AquaMobil is **partially enterprise-ready** on session cleanup and tenant-aware local caching, but **not yet trustworthy for mobile offline roundtrip confidence** because the highest-risk leave and messaging paths still break proof of completion.

**Deployment confidence for mobile offline/reconnect:** **LOW**

Blocking gaps:

- HIGH-001
- HIGH-002
- HIGH-003
- MEDIUM-005

Non-blocking but important:

- MEDIUM-004
- MEDIUM-006

## Flows Checked

- auth restore and logout cleanup
- offline queue and sync status surfaces
- leave-request mobile create, submit, and readback path
- messaging offline send, reconnect, and notification-click path
- mobile feature gating and tenant-aware local caching

## Preserved Findings

### HIGH-001 -- write-gap, sync-gap

**Leave request mobile roundtrip is not coherent: the queued create payload mismatches the backend contract, queue-level dedup never engages for that payload, and the follow-up submit path uses the offline queue UUID as if it were the leave-request ID.**

Evidence:

- `web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx:81-103`
- `web/apps/aquamobil/src/hooks/useLeave.ts:187-202`
- `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:95-103`
- `web/apps/aquamobil/src/pwa/offline-queue.ts:95-176`
- `apps/hr-service/src/leave/dto/create-leave-request.input.ts:16-63`
- `apps/hr-service/src/leave/leave.resolver.ts:282-292`

Assessment:

- the mobile page queues `leaveTypeId`, `startDate`, `endDate`, `isHalfDay`, and `reason`
- the backend `CreateLeaveRequestInput` requires `employeeId` and `totalDays`, and uses `isHalfDayStart` / `isHalfDayEnd` / `halfDayPeriod` rather than `isHalfDay`
- offline queue dedup for HR writes keys off `employeeId`; because the mobile leave payload omits `employeeId`, the queue cannot derive a stable resource ID and the 5-second dedup window never protects this path
- after queueing, the page calls `submitRequest(queueId)` even though `queueId` is the offline operation UUID, not the leave request aggregate ID expected by `submitLeaveRequest(id: ID!)`

Operational impact:

- mobile can claim "Request Submitted" without proving draft creation or the draft-to-pending transition
- repeated taps can enqueue duplicate leave-create work instead of being structurally deduped
- online workers can leave the screen believing the request is submitted while the domain aggregate never reached the intended status

### HIGH-002 -- write-gap, sync-gap, visibility-gap

**Offline chat sends are stored in a separate IndexedDB queue with no authoritative replay owner and no user-visible sync surface.**

Evidence:

- `web/apps/aquamobil/src/hooks/useSendMessage.ts:28-29`
- `web/apps/aquamobil/src/hooks/useSendMessage.ts:197-214`
- `web/apps/aquamobil/src/hooks/useSendMessage.ts:230-232`
- `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:19-29`
- `web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx:15-17`
- `web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx:67-90`
- `web/apps/aquamobil/src/pages/HomePage.tsx:103-176`
- `web/apps/aquamobil/src/pages/account/AccountPage.tsx:579-613`
- repo-wide search for `messaging_offline_sends` only returns `web/apps/aquamobil/src/hooks/useSendMessage.ts`
- repo-wide search for `registerMessagingSync` only returns `web/apps/aquamobil/src/pwa/messaging-sw.ts`

Assessment:

- offline messaging persists sends under `messaging_offline_sends`
- no consumer, flusher, or reconnect replay path was found for that queue key
- the service-worker helper that would register `sync-messages` exists but no call site was found
- AquaMobil's visible sync surfaces use `useOfflineQueue()` and only reflect the general encrypted operation queue, not the separate messaging queue

Operational impact:

- operators can compose offline messages that never reach the backend
- the app can show `0` pending operations on home, account, and sync-status screens while offline chat sends remain stranded
- messaging offline support is not end-to-end proven

### HIGH-003 -- sync-gap, visibility-gap

**Service-worker messaging handoff is incomplete, and notification navigation ignores AquaMobil's `/mobile` route base.**

Evidence:

- `web/apps/aquamobil/src/pwa/messaging-sw.ts:36-46`
- `web/apps/aquamobil/src/pwa/messaging-sw.ts:121-138`
- `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:223-237`
- `web/apps/aquamobil/src/main.tsx:62`
- `web/apps/aquamobil/vite.config.ts:7`
- `web/apps/aquamobil/vite.config.ts:25-26`
- `web/apps/aquamobil/public/manifest.webmanifest:5-6`

Assessment:

- the service worker posts `SYNC_MESSAGES` on reconnect and `NAVIGATE_TO_CHANNEL` on notification-click focus
- the app listener only handles `SYNC_COMPLETE`
- if no existing messaging window is reused, the service worker opens `/messages` or `/messages/{channelId}` even though the router basename, Vite base, and manifest scope are all `/mobile`

Operational impact:

- reconnect/background-sync behavior can stall at the app handoff boundary
- notification click can focus an existing client without routing the user to the intended channel
- when no matching messaging window is open, push navigation can target the wrong route root instead of AquaMobil's messaging path

### MEDIUM-004 -- access-gap

**Mobile permissions fail open to all features during permission-fetch failure without cache.**

Evidence:

- `web/apps/aquamobil/src/hooks/useMobilePermissions.ts:65-80`
- `web/apps/aquamobil/src/hooks/useMobilePermissions.ts:145-168`

Assessment:

- this is not a direct proof of backend privilege escalation
- it is still a real mobile access-boundary drift because degraded mode expands the visible feature set

Operational impact:

- users can see routes and entry points that the live permission source did not confirm

### MEDIUM-005 -- sync-gap, visibility-gap

**Task detail actions use inconsistent offline semantics: start and complete can silently fall back to queueing while the UI shows definitive success, but checklist and note actions have no offline fallback at all.**

Evidence:

- `web/apps/aquamobil/src/hooks/useTaskActions.ts:14-49`
- `web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx:75-129`

Assessment:

- `startTask` and `completeTask` fall back to the offline queue on request failure
- `TaskDetailPage` shows "Task started!" and "Task completed!" immediately after those calls return, without distinguishing queued work from durable completion
- `toggleChecklistItem` and `addNote` have no comparable queue fallback and simply disappear on offline failure

Operational impact:

- operators can believe a task state transition is already durable when it is only queued
- checklist and note edits are more fragile than the surrounding task actions, creating uneven mobile workflow truth

### MEDIUM-006 -- visibility-gap

**Leave readback truth is cache-stale after submit because the mobile mutation path does not invalidate or update leave queries before routing back to the list view.**

Evidence:

- `web/apps/aquamobil/src/hooks/useLeave.ts:110-142`
- `web/apps/aquamobil/src/hooks/useLeave.ts:187-202`
- `web/apps/aquamobil/src/pages/leave/MyLeavesPage.tsx:27-37`
- `web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx:102-103`
- `web/modules/hr-module/src/hooks/useLeaves.ts:332-349`

Assessment:

- mobile leave requests are cached with a 2-minute `staleTime`
- the mobile submit hook sends the mutation but does not invalidate `leaveRequests`, `leaveBalances`, or set updated query data
- the request page routes back to `/leave` immediately after showing success copy
- the desktop HR leave hook already implements the missing invalidation and cache-update pattern

Operational impact:

- even after the backend path is corrected, a worker can return to the leave screen and still see stale request state
- mobile leave readback does not currently prove convergence after create or submit

## What Is Trustworthy

- logout cleanup is strong and shared-device aware:
  - `web/apps/aquamobil/src/hooks/useAuth.tsx:96-118`
  - `web/apps/aquamobil/src/hooks/useAuth.tsx:280-306`
- tenant-aware encrypted local cache design is materially sound:
  - `web/apps/aquamobil/src/pwa/offline-queue.ts:303-379`
- authenticated retry updates both token and tenant header:
  - `web/apps/aquamobil/src/services/authenticated-fetch.ts:54-90`

## Gap Classification

- HIGH-001: `write-gap`, `sync-gap`
- HIGH-002: `write-gap`, `sync-gap`, `visibility-gap`
- HIGH-003: `sync-gap`, `visibility-gap`
- MEDIUM-004: `access-gap`
- MEDIUM-005: `sync-gap`, `visibility-gap`
- MEDIUM-006: `visibility-gap`

## Orchestrator Decision

Do not treat AquaMobil's current offline/reconnect path as production-trustworthy for leave submission or messaging until:

1. leave mobile create and submit use the real backend contract, the real domain ID, and a stable dedup fingerprint
2. offline messaging has one authoritative replay path and appears on the same sync surfaces the user sees
3. service-worker message contracts are completed on the client side and notification routes become `/mobile`-aware
4. queued mobile task actions stop overstating durable completion
5. mobile leave readback converges immediately after submit instead of waiting on cache expiry

The mobile foundation is not weak overall, but the remaining defects sit exactly on the paths that operators rely on when connectivity is unstable.
