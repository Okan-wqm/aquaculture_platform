# List Visibility Auditor

**Topic:** `2026-04-13-full-platform-e2e`
**Prior cycle:** `2026-04-11-full-platform-e2e` (2 findings: MEDIUM-001, MEDIUM-002)
**Fix commit:** `79ce984f` — "fix 3 CRITICAL + 6 HIGH + 3 MEDIUM findings from e2e audit"

## Scope checked

- `web/modules/tenant-admin/` — user CRUD, modules, devices, messaging, tickets, announcements
- `web/modules/farm-module/` — batches, tasks, equipment, maintenance, harvest plans, purchase orders, storage inventory, health events, water quality, cleaner fish, regulatory
- `web/modules/hr-module/` — employees, leaves, attendance, certifications, payroll, scheduling
- `web/modules/admin-panel/` — announcements, messaging threads, tenants
- `web/modules/sensor-module/` — alert rules, edge devices
- `web/apps/aquamobil/` — channels, messages, tasks, attendance, tanks, leave, stock events, offline queue
- `web/shared-ui/` — useGraphQLMutation wrapper, graphqlClient

## Prior cycle status

### MEDIUM-001 (prior): User writes can disappear behind the current page offset
**Status: STILL OPEN.** Commit `79ce984f` did not address this finding. The tenant user mutations (`useCreateTenantUser`, `useUpdateTenantUser`, `useDeleteTenantUser`, `useDeactivateTenantUser`) at `/var/aqua-saas/web/modules/tenant-admin/src/hooks/useTenantData.ts:551-607` all invalidate `tenantKeys.users()` on success, but the page component at `/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx:86` never resets `page` state to 0 after a mutation succeeds. Filter changes reset page (lines 204-205), but create/edit/delete do not. After creating a user while on page 2+, the new user may land on page 1 while the UI stays on page 2. After deleting the last row on a page, the user sees an empty page.

### MEDIUM-002 (prior): AquaMobil channel list can keep stale ordering and badges after a write
**Status: PARTIALLY RESOLVED.** The `useChannels` hook at `/var/aqua-saas/web/apps/aquamobil/src/hooks/useChannels.ts:68-132` was refactored. The `accumulatedChannelsRef` is now reset when `offset === 0` (line 124-125), meaning first-page invalidation correctly replaces the accumulated state. However, the accumulation pattern still uses a mutable ref that is not synchronized with the query cache on invalidation when `offset > 0` (lines 126-129). If the user has scrolled past the first page and a `channelUpdated` event fires, only the first-page query is refetched; pages 2+ remain stale in the ref. Downgraded from prior severity because the first-page path (most common) is now correct.

## New findings

### HIGH-001: AquaMobil task actions do not invalidate any list cache after write

After `completeTask` or `startTask` succeeds (or is queued offline and synced), the task list displayed by `useMyTasks` is never refreshed. The `useTaskActions` hook at `/var/aqua-saas/web/apps/aquamobil/src/hooks/useTaskActions.ts:11-53` calls `graphqlRequest` directly (or falls back to `addToQueue`) without any React Query cache invalidation. `useMyTasks` at `/var/aqua-saas/web/apps/aquamobil/src/hooks/useMyTasks.ts:33-79` uses manual `useState`/`useCallback` state, not React Query, so there is no query key to invalidate anyway. The only way to see the updated task status is to leave the page and return (triggering `hasFetchedRef` re-evaluation) or pull to refresh (if the page exposes `refetch`).

**Root cause:** `useMyTasks` uses hand-rolled fetch state instead of React Query. `useTaskActions` mutations have no way to signal `useMyTasks` that data changed. After completing a task, the user sees the task in its old state until the next full page load.

**Evidence:**
- `/var/aqua-saas/web/apps/aquamobil/src/hooks/useTaskActions.ts:14-24` — `completeTask` does not call any invalidation or state update
- `/var/aqua-saas/web/apps/aquamobil/src/hooks/useMyTasks.ts:38-39` — `hasFetchedRef` prevents re-fetch after initial load
- `/var/aqua-saas/web/apps/aquamobil/src/hooks/useMyTasks.ts:69-74` — fetch only triggers once per auth session

**Cross-domain dependency:** `mobile-app-auditor` for AquaMobil-specific UX impact assessment.

### HIGH-002: AquaMobil offline queue sync does not refresh any list/detail caches

The `OfflineProvider` at `/var/aqua-saas/web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:302-345` calls `syncAllOperations(executeGraphQL)` which executes the stored mutations server-side on reconnect. After sync completes, it calls `refreshQueue()` (line 329) to update the pending count, but it does NOT invalidate any React Query caches for the domain data that was just written. This means after going online and syncing:

- Mortality records, cull records, harvest records, feeding records, transfers, water quality measurements, stock movements, task completions, leave requests, clock-in/out, and messages are all persisted server-side but the local UI still shows the pre-sync state.
- The user sees "0 pending operations" (queue is empty) but the list views (tanks, tasks, attendance, messages) show stale data from the last online fetch.

**Root cause:** `syncAllOperations` is a generic fire-and-forget executor. It has no knowledge of which query keys to invalidate for each operation type. The sync-complete path refreshes only the offline queue state, not the application state.

**Evidence:**
- `/var/aqua-saas/web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:302-345` — `syncNow` only calls `refreshQueue()`, never `queryClient.invalidateQueries()`
- `/var/aqua-saas/web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:36-188` — `MUTATIONS` map has 14 operation types, each affecting different query keys
- Compare with web panel's `useSendMessage` at `useTenantData.ts:376-385` which correctly invalidates both `threadMessages` and `threads` after send

**Cross-domain dependency:** `mobile-app-auditor` for offline-to-online transition UX.

### HIGH-003: Admin panel announcement and messaging mutations do not invalidate list caches

The admin-panel uses `useGraphQLMutation` from `shared-ui` for all announcement and messaging mutations. This wrapper at `/var/aqua-saas/web/shared-ui/src/hooks/useGraphQL.ts:159-201` is a raw `useState`-based mutation executor with NO React Query integration. It does not call `queryClient.invalidateQueries()` anywhere. The consuming hooks also do not add any invalidation:

- `useCreateAnnouncement` at `/var/aqua-saas/web/modules/admin-panel/src/hooks/useAnnouncements.ts:217-229` — creates announcement, no list invalidation
- `usePublishAnnouncement` at line 269 — publishes, no list invalidation
- `useCancelAnnouncement` at line 285 — cancels, no list invalidation
- `useDeleteAnnouncement` at line 301 — deletes, no list invalidation
- `useCreateThread` at `/var/aqua-saas/web/modules/admin-panel/src/hooks/useMessaging.ts:222-234` — creates thread, no list invalidation
- `useSendMessage` at line 239 — sends message, no thread list or message list invalidation
- `useCloseThread` at line 273 — closes thread, no list invalidation
- `useReopenThread` at line 289 — reopens thread, no list invalidation
- `useArchiveThread` at line 305 — archives thread, no list invalidation

After any of these mutations succeed, the admin sees the stale list (old announcement count, old thread status, missing new threads) until they manually reload the page.

**Root cause:** The `useGraphQLMutation` wrapper in shared-ui was designed as a minimal fetch abstraction. It does not integrate with TanStack Query's cache. Every admin-panel mutation hook that uses it inherits this cache-blindness. The query-side hooks (`useAdminAnnouncements`, `useAdminThreads`) use `useGraphQLQuery` which is also useState-based (not React Query), so there is no query key to invalidate anyway -- the entire admin-panel data layer bypasses React Query.

**Evidence:**
- `/var/aqua-saas/web/shared-ui/src/hooks/useGraphQL.ts:159-201` — `useGraphQLMutation` has no queryClient access
- `/var/aqua-saas/web/shared-ui/src/hooks/useGraphQL.ts:66-132` — `useGraphQLQuery` also bypasses React Query
- `/var/aqua-saas/web/modules/admin-panel/src/hooks/useAnnouncements.ts:217-312` — all 6 mutation hooks lack invalidation
- `/var/aqua-saas/web/modules/admin-panel/src/hooks/useMessaging.ts:222-316` — all 6 mutation hooks lack invalidation

**Cross-domain dependency:** `data-readback-auditor` for confirmation that the backend persists correctly despite the stale UI.

### MEDIUM-003: AquaMobil leave mutations do not invalidate leave request or balance caches

`useSubmitLeaveRequest` and `useCancelLeaveRequest` at `/var/aqua-saas/web/apps/aquamobil/src/hooks/useLeave.ts:187-221` are hand-rolled `useState`/`useCallback` wrappers that call `graphqlRequest` directly, with no cache invalidation on success. Meanwhile, `useMyLeaveRequests` and `useMyLeaveBalances` in the same file (lines 65-143) use React Query with query keys `['leaveRequests', tenantId, ...]` and `['leaveBalances', tenantId, ...]`. After submitting or cancelling a leave request, the leave request list and balance summary remain stale until `staleTime` expires (2 min for requests, 5 min for balances).

Compare with the web panel's HR module: `useSubmitLeaveRequest` at `/var/aqua-saas/web/modules/hr-module/src/hooks/useLeaves.ts:332-352` correctly invalidates `leaveKeys.requests()` and `leaveKeys.myRequests()` and updates the detail cache.

**Evidence:**
- `/var/aqua-saas/web/apps/aquamobil/src/hooks/useLeave.ts:187-203` — `useSubmitLeaveRequest.submit()` calls `graphqlRequest()` then only `setLoading(false)`, no invalidation
- `/var/aqua-saas/web/apps/aquamobil/src/hooks/useLeave.ts:205-221` — `useCancelLeaveRequest.cancel()` same pattern
- `/var/aqua-saas/web/modules/hr-module/src/hooks/useLeaves.ts:332-352` — correct pattern for comparison

### MEDIUM-004: AquaMobil channel list accumulated ref diverges from query cache after paged scroll + channel update

The `useChannels` hook at `/var/aqua-saas/web/apps/aquamobil/src/hooks/useChannels.ts:121-132` accumulates channel pages into `accumulatedChannelsRef`. On `channelUpdated` socket event (line 103-104), `queryClient.invalidateQueries({ queryKey: ['messaging', 'channels'] })` is called, which refetches the current offset's query. When `offset > 0`, the refetched data for the current page replaces the accumulated slice at that offset, but pages prior to the current offset remain stale in the ref (line 127-129 only appends new items by ID, never updates existing items). A channel that changed its `lastMessage` or `unreadCount` on a previously loaded page will show stale preview text and badge count.

This is a refinement of prior MEDIUM-002 which is partially fixed for `offset === 0`.

**Evidence:**
- `/var/aqua-saas/web/apps/aquamobil/src/hooks/useChannels.ts:126-129` — `existingIds` filter prevents updating already-accumulated items
- `/var/aqua-saas/web/apps/aquamobil/src/hooks/useChannels.ts:134-137` — return prefers accumulated ref over query data
- `/var/aqua-saas/web/apps/aquamobil/src/hooks/useChannels.ts:103-104` — invalidation refetches query but does not clear accumulated ref for all pages

### MEDIUM-005: Tenant user page offset not clamped on total count change (prior MEDIUM-001, still open)

This is a re-statement of MEDIUM-001 from the prior cycle, tracked here as it remains unfixed after `79ce984f`. The `TenantUsers` page at `/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx:86` holds `page` as `useState(0)`. After a user is deleted on the last page, the page count may decrease but `page` is not clamped. The `UserListSection` at line 272 receives `pagination={{ page, pageSize, rawPageCount: users.length }}` and when `users.length === 0` on a stale page, renders an empty state even though records exist on earlier pages. After create, the new record lands on a page that may not be the currently viewed one.

**Evidence:**
- `/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx:86` — `page` state never reset on mutation
- `/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx:141-168` — `handleSaveUser` does not call `setPage(0)` on success
- `/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx:171-181` — `handleConfirmDelete` does not call `setPage(0)` on success
- `/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx:183-188` — `handleDeactivateUser` does not call `setPage(0)` on success
- `/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx:204-205` — filter changes correctly call `setPage(0)`, proving the pattern is known

### LOW-001: Task stats badge can diverge from task list after toggleChecklistItem or addTaskNote

In the farm-module `useTasks` hook at `/var/aqua-saas/web/modules/farm-module/src/hooks/useTasks.ts:286-334`, `toggleChecklistItemMutation` and `addTaskNoteMutation` only invalidate `['tasks']` but not `['taskStats']`. Meanwhile, `createTask`, `updateTask`, `completeTask`, `startTask`, and `deleteTask` correctly invalidate both `['tasks']` and `['taskStats']`. If a checklist completion causes the backend to transition a task to COMPLETED (all items checked), the task stats (completed count, completion rate) remain stale for up to 60 seconds (`staleTime: 60_000` at line 138).

**Evidence:**
- `/var/aqua-saas/web/modules/farm-module/src/hooks/useTasks.ts:301-303` — `toggleChecklistItemMutation.onSuccess` only invalidates `['tasks']`
- `/var/aqua-saas/web/modules/farm-module/src/hooks/useTasks.ts:325-329` — `addTaskNoteMutation.onSuccess` only invalidates `['tasks']`
- `/var/aqua-saas/web/modules/farm-module/src/hooks/useTasks.ts:175-177` — `createTaskMutation.onSuccess` correctly invalidates both `['tasks']` and `['taskStats']`

### LOW-002: HR dashboard stats not invalidated after employee create/update/status-change

The `useHRDashboardStats` hook at `/var/aqua-saas/web/modules/hr-module/src/hooks/useEmployees.ts:176-199` uses query key `['hrDashboardStats']` with no `staleTime` override (defaults to 0 which means always stale, BUT React Query only refetches on mount/window-focus/interval unless explicitly invalidated). The employee mutation hooks (`useCreateEmployee` at line 308, `useUpdateEmployee` at line 326, `useUpdateEmployeeStatus` at line 347) invalidate `employeeKeys.lists()` and `departmentKeys.all` but NOT `['hrDashboardStats']`. After creating/terminating an employee, the dashboard stat cards (total employees, active count, etc.) remain stale until the next window focus or page navigation.

**Evidence:**
- `/var/aqua-saas/web/modules/hr-module/src/hooks/useEmployees.ts:308-323` — `useCreateEmployee.onSuccess` invalidates `employeeKeys.lists()` and `departmentKeys.all` only
- `/var/aqua-saas/web/modules/hr-module/src/hooks/useEmployees.ts:176-199` — `useHRDashboardStats` query key is `['hrDashboardStats']`, independent from employee keys

## Systemic observations

### Pattern: Admin-panel data layer bypasses React Query entirely

The admin-panel module uses `useGraphQLQuery` and `useGraphQLMutation` from `shared-ui` instead of `@tanstack/react-query`. These wrappers are raw `useState`-based hooks with no cache, no deduplication, and no invalidation mechanism. Every mutation in admin-panel (announcements: 6 mutations, messaging: 6 mutations) operates in a cache-blind mode. This is a systemic cache discipline failure for the admin-panel module. The recommended architectural direction is migrating admin-panel to the same `useMutation`/`useQuery` pattern used in tenant-admin, farm-module, hr-module, and sensor-module.

### Pattern: AquaMobil mutation hooks mix two incompatible state models

Some AquaMobil hooks use React Query (`useChannels`, `useMessages`, `useTanks`, `useAttendance`, `useLeave` reads), while others use manual `useState` (`useMyTasks`, `useTaskActions`, `useLeave` writes). The manual-state hooks cannot trigger React Query invalidation, creating a permanent write-read divergence. The recommended direction is consolidating all data hooks in AquaMobil onto React Query with proper `onSuccess` invalidation in every mutation.

### Pattern: Offline sync is fire-and-forget for UI state

The `OfflineProvider` syncs 14 operation types to the server on reconnect but never refreshes the corresponding React Query caches. This is the highest-impact pattern because it affects all write-capable mobile flows (mortality, cull, harvest, feeding, transfer, water quality, stock movement, attendance, leave, task completion, messaging). The recommended direction is a sync-complete callback that maps operation types to query key prefixes and invalidates them.

## Result

| Severity | Count | IDs |
|----------|-------|-----|
| HIGH     | 3     | HIGH-001, HIGH-002, HIGH-003 |
| MEDIUM   | 3     | MEDIUM-003, MEDIUM-004, MEDIUM-005 |
| LOW      | 2     | LOW-001, LOW-002 |

**3 HIGH findings** represent core list/detail surfaces that never reflect real state after writes without a manual reload:
- Mobile task list after complete/start (HIGH-001)
- All mobile lists after offline sync (HIGH-002)
- Admin panel announcement and messaging lists after any mutation (HIGH-003)

No CRITICAL findings (no cross-tenant visibility leakage or dangerously misleading post-write state was found).
