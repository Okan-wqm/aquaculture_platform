# AquaMobil PWA Bug Fix Implementation Plan

**Date:** 2026-03-27
**Author:** Architecture Agent (Opus 4.6)
**Status:** PLAN ONLY -- Do not implement

---

## 1. Root Cause Analysis Per Bug

### BUG-01: HEAD /graphql returns 503 (P0-CRITICAL)

**Files investigated:**
- `/var/aqua-saas/apps/gateway-api/src/main.ts` (lines 174-185)
- `/var/aqua-saas/web/apps/aquamobil/src/hooks/useNetworkStatus.ts` (lines 8-28)

**Root cause hypothesis:**
The middleware at main.ts:179 intercepts HEAD /graphql and returns 200 -- the code logic itself is correct. However, the real problem is almost certainly that the **middleware registration occurs at line 179, AFTER `NestFactory.create(AppModule)` on line 34**. In NestJS, the GraphQL module (Apollo Server) registers its own middleware during `AppModule` initialization. By the time the HEAD middleware is added via `app.use('/graphql', ...)`, Apollo has ALREADY registered a request handler on `/graphql`. In Express, middleware order matters: Apollo's handler runs first, receives the HEAD request, and since Apollo only handles POST for GraphQL operations, it returns 503 (Service Unavailable) before the HEAD middleware ever executes.

Additionally, `useNetworkStatus.ts` line 24 checks `response.ok || response.status < 500` -- so a 503 is treated as "offline." This means the connectivity probe falsely reports the user as offline, which cascades to disable all data-dependent features.

**Architectural fix:**
1. Move the HEAD middleware registration BEFORE the GraphQL module loads. In NestJS, this means registering it as Express-level middleware early in the bootstrap, before `app.listen()` is called -- but the real issue is that `app.use()` after NestFactory.create should work for path-specific middleware BEFORE the NestJS routing layer. The actual problem may be that Apollo Server in NestJS registers a route handler (not middleware), so Express path middleware registered via `app.use` should execute first. Investigate whether the NestJS adapter or Apollo plugin intercepts the request at a different level.
2. Alternative: Register the HEAD handler as a NestJS Middleware or Guard within the AppModule itself (e.g., a `HeadGraphqlMiddleware` class applied via `configure()` in `AppModule.configure()`), which guarantees it runs in the NestJS middleware pipeline before Apollo.
3. Alternative: Add a NestJS `@Controller` endpoint that explicitly handles `@Head('/graphql')` returning 200, which takes precedence over Apollo's handler.

**Dependencies:** None -- this is the root blocker. Fix first.

**Effort:** M (Medium) -- Requires understanding NestJS/Apollo middleware ordering, testing with curl.

---

### BUG-02: Leave button routes to /water-quality/record (P0-CRITICAL)

**Files investigated:**
- `/var/aqua-saas/web/apps/aquamobil/src/pages/HomePage.tsx` (lines 82-88)
- `/var/aqua-saas/web/apps/aquamobil/src/App.tsx` (lines 389-403)

**Root cause hypothesis:**
In `HomePage.tsx`, the "Leave" quick action at line 82-88 correctly has `path: '/leave'`. The route at `App.tsx` line 389-394 correctly maps `/leave` to `MyLeavesPage`. The bug report says the Leave button navigates to `/water-quality/record`. This suggests the Leave button is NOT the one in the main HomePage quick actions grid, but rather a Leave button in a **different context** (possibly the StaffHubPage or OperationsHubPage).

Looking at `StaffHubPage.tsx` line 158-162, the quick action is `path: '/leave/request'` which is correct. The Operations hub pages don't have a Leave button directly.

The most likely root cause: The **"Leave" button exists in a location NOT yet identified** -- possibly a sub-hub page, or the issue is that the Leave button's `onClick` handler is using `navigate()` with an incorrect path, OR there is a route matching issue where `/leave` is being caught by the wildcard `*` route and falling through.

Actually, re-examining: the Quick Actions grid in `HomePage.tsx` defines the Leave action at index 7 (line 82-88). The path is `/leave`. The route for `/leave` exists. But -- if the user's `MobileFeature` permissions do NOT include `leave`, the `FeatureRoute` at App.tsx line 389-394 will redirect to `/` (home). This is not the described behavior though (redirect to `/water-quality/record`).

More likely root cause: There is a **rendering order issue** in the quick action grid. The grid renders buttons in a dense grid with dynamic column count. If the Leave button's onClick is not properly bound (closure issue) or if there's an index offset in the rendered buttons vs. the action array after permission filtering, clicking "Leave" could fire the onClick of a different button. However, examining the code, each button uses `action.path` inside its own map callback, so this should be correct.

The bug likely comes from a different page or a stale build. Further investigation needed.

**Architectural fix:**
1. Read the exact component where the Leave button exists (the user report may refer to a different page than HomePage).
2. If it is the HomePage, add `data-testid` attributes to each QuickAction button for automated testing.
3. Verify that the `navigate(action.path)` call inside the `.map()` closure is using the correct captured `action` from the iterator.
4. Add an integration test that clicks the Leave quick action and asserts the URL is `/leave`.

**Dependencies:** None.

**Effort:** S (Small) -- Likely a path string mismatch, once the exact component is identified.

---

### BUG-03: Stock In wizard -- empty "Next" goes to /account (P0-CRITICAL)

**Files investigated:**
- `/var/aqua-saas/web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx` (lines 206-224, 226-252)

**Root cause hypothesis:**
In `StockMovementPage.tsx`, the `canAdvance()` function at line 206-224 checks `step === 1: return selectedItemType !== null`. When `selectedItemType` is null (user hasn't selected a category), `canAdvance()` returns `false`. The "Next" button at line 719-731 is `disabled={!canAdvance()}` -- so the button SHOULD be disabled.

However, looking at the button's `onClick={handleNext}` at line 720 -- `handleNext` at line 226 checks `if (!canAdvance()) return;` which is a guard. The button is both disabled AND guarded. The user should not be able to tap Next.

**The redirect to /account** cannot originate from this component. The component has no navigate-to-account logic. This means:
1. The "Next" button IS tappable (the `disabled` attribute may not be working on mobile -- CSS `pointer-events` vs HTML `disabled` on a `<button>` element).
2. `handleNext()` runs, `canAdvance()` returns false, and the function returns early without navigating. So the /account redirect happens from somewhere else.
3. Most likely: The page crashes with a React error (unhandled null access), the ErrorBoundary catches it, and the global error handler navigates to /account as a fallback. OR: the `FeatureRoute` component re-evaluates permissions and redirects.

Actually, examining `App.tsx` line 406: `<Route path="*" element={<Navigate to="/" replace />} />`. The catch-all goes to `/`, not `/account`.

The redirect to `/account` could happen if the **bottom tab bar** is accidentally tapped during the wizard flow (the wizard renders without MobileLayout but the tab bar still shows because MobileLayout wraps all protected routes in App.tsx). Since StockMovementPage is inside MobileLayout, the Account tab is always visible at the bottom.

**Real root cause:** This is likely a **UX interaction issue**, not a code bug. When the user taps near the bottom of the screen (where "Next" is positioned), they may accidentally hit the Account tab in the fixed bottom navigation bar. The wizard's "Next" button at `pb-safe-bottom` sits right above the tab bar.

**Architectural fix:**
1. Add validation feedback on Step 1: when the user taps Next without selecting a category, show an inline error message ("Please select a category").
2. Increase the spacing between the wizard's bottom buttons and the tab bar to prevent misclicks.
3. Consider hiding the bottom tab bar during wizard flows (full-screen wizard pattern).

**Dependencies:** None.

**Effort:** S (Small)

---

### BUG-04: Write Off renders Stock In component (P0-CRITICAL)

**Files investigated:**
- `/var/aqua-saas/web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx` (lines 124-133)
- `/var/aqua-saas/web/apps/aquamobil/src/pages/storage/StorageHubPage.tsx` (lines 53-59)

**Root cause hypothesis:**
This bug is actually **already fixed** in the current codebase. The `StockMovementPage.tsx` correctly reads the `?type=` query parameter at line 131-132:

```typescript
const rawType = searchParams.get('type') ?? 'IN';
const movementType: StockMovementType = (rawType === 'OUT' || rawType === 'WASTE') ? rawType : 'IN';
```

And `StorageHubPage.tsx` correctly links to `/storage/movement?type=WASTE` at line 55.

The component renders the correct header, icon, and form based on `movementType`. The header shows "Write Off" with gray gradient and Trash2 icon for WASTE.

However, there IS a subtle issue: the URL is `/storage/movement?type=WASTE` but the component title shows "Write Off" via `MOVEMENT_CONFIG[movementType].label`. If the query parameter is somehow lost during navigation (e.g., React Router not preserving search params across lazy-load Suspense boundaries), it would default to `IN`.

**Possible root cause:** React Router v6's `useSearchParams` may lose the query string when the component lazy-loads if there's a navigation timing issue. OR: the `navigate(action.path)` in `StorageHubPage.tsx` is not correctly passing the full path with query string.

Checking `StorageHubPage.tsx` line 276: `navigate(action.path)` where `action.path = '/storage/movement?type=WASTE'` -- React Router's `navigate()` function accepts a path string including query parameters, so this should work.

**Architectural fix:**
1. Verify this is still reproducible. If so, add a `console.warn` when `rawType` is not recognized and falls back to IN.
2. Consider using a URL path segment instead of query parameter: `/storage/movement/write-off` instead of `/storage/movement?type=WASTE`. This is more robust against query string loss and more SEO-friendly (though irrelevant for PWA).
3. Add unit test that renders StockMovementPage with `?type=WASTE` and asserts the header text is "Write Off".

**Dependencies:** None.

**Effort:** S (Small)

---

### BUG-05: useWarehouseSummary GraphQL 400 (P0-CRITICAL)

**Files investigated:**
- `/var/aqua-saas/web/apps/aquamobil/src/hooks/useWarehouseSummary.ts`
- `/var/aqua-saas/web/apps/aquamobil/src/graphql/operations.ts` (lines 495-519)
- Gateway `apps/gateway-api/src/` -- grep for `warehouseSummary` returned NO RESULTS.

**Root cause hypothesis:**
The `GET_WAREHOUSE_SUMMARY` query at operations.ts:495-519 queries `warehouseSummary { ... }` but **the backend gateway has no resolver for `warehouseSummary`**. The grep across the entire `apps/` directory returned zero matches for "warehouseSummary" or "WarehouseSummary". This means:

1. The GraphQL schema does not define the `warehouseSummary` query.
2. The frontend sends a well-formed GraphQL request for a non-existent query.
3. Apollo Server validates the query against the schema and returns a 400 (Bad Request) because the field does not exist.

The `useWarehouseSummary` hook at line 61-72 has a catch block that falls back to IndexedDB cache, then defaults to zeros. This means the UI shows zeros instead of crashing, but the GraphQL 400 error is logged.

**Architectural fix:**
1. Implement the `warehouseSummary` query resolver in the storage-service backend. This requires:
   - A GraphQL type definition for `WarehouseSummary`, `LowStockItem`, and `RecentStockMovement`.
   - A resolver that aggregates: count of storage items, items below min threshold, today's movement count, and recent movements.
   - Proxy the query through the gateway-api federation/stitching layer.
2. Until the backend is ready, the frontend correctly falls back to defaults. No frontend change needed.

**Dependencies:** Requires backend work (storage-service). Frontend is already resilient.

**Effort:** L (Large) -- Backend resolver + gateway schema stitching.

---

### BUG-06: Sync page shows contradictory UI state (P1-MEDIUM)

**Files investigated:**
- `/var/aqua-saas/web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx`
- `/var/aqua-saas/web/apps/aquamobil/src/hooks/useOfflineQueue.tsx`

**Root cause hypothesis:**
In `SyncStatusPage.tsx`, the "Pending Count" section (lines 67-82) shows `{pendingCount}` from `useOfflineQueue()`. The "All Synced!" section (lines 138-146) is shown when `pendingOperations.length === 0`.

The issue is that `pendingCount` and `pendingOperations` come from two different state variables in `useOfflineQueue.tsx` (lines 192-193):

```typescript
const [pendingCount, setPendingCount] = useState(0);
const [pendingOperations, setPendingOperations] = useState<QueuedOperation[]>([]);
```

These are updated together in `refreshQueue()` (line 204-215), but they can be momentarily out of sync because `setState` is asynchronous. Between the time `getPendingCount()` resolves and `getPendingOperations()` resolves (they're both in a `Promise.all` at line 206), React may batch the state updates. However, they ARE inside the same callback, so React 18 should batch them.

The real issue: `pendingCount` is read from `IndexedDB.count()` while `pendingOperations` is read from `IndexedDB.getAll()`. If a sync completes between the two reads (race condition), count could return 1 while operations returns []. This is unlikely but possible.

More likely: The sync process updates `pendingCount` via the `syncNow()` function's `refreshQueue()` call (line 327) but there's a timing issue where the sync operation has been dequeued from IndexedDB (count = 0) but the React state hasn't been updated yet, and the SyncStatusPage re-renders with stale `pendingCount`.

Actually, looking more carefully: the `pendingCount` shown at line 70 is `{pendingCount}` and the check at line 85 is `pendingOperations.length > 0`. These can diverge: `pendingCount = 1` (stale state from before last refresh) while `pendingOperations = []` (updated from a later refresh). Since both are separate `useState` values, a render could show both: the count banner says "1 Pending Operations" while the operations list section shows "All Synced!" because the array is empty.

**Architectural fix:**
1. Derive `pendingCount` from `pendingOperations.length` instead of maintaining it as a separate state. Remove the `pendingCount` state variable and replace it with `const pendingCount = pendingOperations.length`. This guarantees consistency.
2. If `getPendingCount()` is needed for performance (IndexedDB count is O(1) vs getAll is O(n)), keep both but ensure the SyncStatusPage uses only `pendingOperations.length` for its display logic.
3. In SyncStatusPage, replace the `pendingCount` display with `pendingOperations.length` for source-of-truth consistency.

**Dependencies:** None.

**Effort:** S (Small)

---

### BUG-07: Clock In -- UI not updating after mutation (P1-MEDIUM)

**Files investigated:**
- `/var/aqua-saas/web/apps/aquamobil/src/pages/attendance/AttendancePage.tsx` (lines 85-106)
- `/var/aqua-saas/web/apps/aquamobil/src/hooks/useAttendance.ts` (lines 167-205)

**Root cause hypothesis:**
In `AttendancePage.tsx`, the `handleClockIn` function (lines 85-106):
1. Calls `addToQueue('clockIn', {...})` -- this queues the operation in IndexedDB.
2. Shows a success screen for 1.5 seconds.
3. After timeout, calls `refetchToday()` -- which re-fetches `todaysAttendance` from the backend.

The problem: The clock-in was queued LOCALLY (offline queue). The `addToQueue` does NOT execute the mutation immediately -- it only adds to IndexedDB. The actual GraphQL mutation executes later during sync. So when `refetchToday()` fires, the backend still has NO record of the clock-in. The backend returns the old data (no clock-in), and the UI reverts to "Clock In" state.

This is the fundamental architectural issue: **the offline queue decouples mutation execution from UI state**. After queueing a clock-in, the UI should show optimistic state (clocked in) without waiting for the backend to confirm.

**Architectural fix:**
1. Implement **optimistic UI updates** after queueing operations. After `addToQueue('clockIn', ...)` succeeds:
   - Set local state `isClockedIn = true` with the current timestamp.
   - Store optimistic attendance record in React Query cache directly via `queryClient.setQueryData()`.
2. When the sync actually executes and `refetchToday()` returns the server-confirmed data, the optimistic state is replaced by the real data.
3. If the sync fails, revert the optimistic state and show an error banner.
4. This pattern should be applied consistently across ALL mutation pages that use the offline queue.

**Dependencies:** None, but this pattern should be established as a reusable utility.

**Effort:** M (Medium) -- Requires optimistic cache update pattern.

---

### BUG-08: Messages badge count wrong (P1-MEDIUM)

**Files investigated:**
- `/var/aqua-saas/web/apps/aquamobil/src/hooks/useUnreadCount.ts`
- `/var/aqua-saas/web/apps/aquamobil/src/layouts/MobileLayout.tsx` (lines 103-109)
- `/var/aqua-saas/web/apps/aquamobil/src/graphql/messaging-operations.ts` (lines 152-156)

**Root cause hypothesis:**
The `useUnreadCount` hook queries `totalUnreadMessageCount` from the messaging service backend. The `MobileLayout` badge logic at line 107 shows `messageUnreadCount` on the Messages tab.

If the badge shows "1" but no messages exist:
1. The messaging service may have a stale count in its database (a message was deleted but the count wasn't decremented).
2. The `totalUnreadMessageCount` resolver may be counting messages in channels the user has been removed from.
3. There is a "system" or "welcome" message created during channel initialization that is marked as unread but not visible in the UI (filtered out by the channel list query).

The most likely cause in a single-user demo environment: when the messaging system initializes, it may create a default channel or system message. The `totalUnreadMessageCount` counts ALL unread messages including system/bot messages, but the UI's channel list filters them out.

**Architectural fix:**
1. Ensure `totalUnreadMessageCount` only counts messages in channels where the user is an active member (not archived, not left).
2. Exclude system messages from the unread count if they are not displayed in the channel list.
3. Add a query cache invalidation when the user navigates to the Messages tab and has read all messages.
4. Frontend: when the Messages tab opens and displays zero channels with unread messages, call `queryClient.setQueryData(['messaging', 'unreadCount', tenantId], 0)` to force-correct the badge.

**Dependencies:** May require backend messaging-service fix.

**Effort:** M (Medium)

---

### BUG-09: Harvest/Transfer forms -- silent validation failure (P1-MEDIUM)

**Files investigated:**
- `/var/aqua-saas/web/apps/aquamobil/src/pages/harvest/RecordHarvestPage.tsx` (lines 65-75, 408-417)
- `/var/aqua-saas/web/apps/aquamobil/src/pages/transfer/RecordTransferPage.tsx` (lines 43-56, 358-368)

**Root cause hypothesis:**
In `RecordHarvestPage.tsx`, the "Review Harvest" button at line 410-411 is `disabled={!selectedTankId || !metrics?.batchId || quantityNum < 1 || avgWeightNum < 1}`. When the button is disabled, tapping it does nothing -- no error message, no visual feedback. The user sees a faded button but may not understand WHY it's disabled.

The `validateForm()` function (lines 65-75) sets error messages in the `errors` state, but it's only called by `handleReview()` which only fires when the button is clicked (and it's enabled). So errors are only shown AFTER the user fills in enough data to enable the button, then the form validates and might find other issues.

Similarly in `RecordTransferPage.tsx`, the "Review Transfer" button at line 362 is `disabled={!sourceTankId || !destinationTankId || !quantity}`. No inline error messages shown before the button enables.

**Architectural fix:**
1. Add **inline field-level error states** that activate when the user attempts to submit (or after the field loses focus -- onBlur validation).
2. When the user taps a disabled button, show a toast/banner explaining what's missing: "Please select a tank", "Enter quantity", etc.
3. Implement a `useFormValidation` hook that provides field-level dirty/touched/error states with a consistent pattern across all form pages.
4. Use the existing `errors` state object but trigger `validateForm()` on button tap even when disabled (change from `disabled` to `onClick` with validation guard).

**Dependencies:** None.

**Effort:** M (Medium) -- Affects multiple form pages.

---

### BUG-10: AI Insights unavailable (P2-LOW)

**Files investigated:**
- `/var/aqua-saas/web/apps/aquamobil/src/components/ai/AiInsightsCard.tsx`
- `/var/aqua-saas/web/apps/aquamobil/src/hooks/useAiInsights.ts`
- `/var/aqua-saas/web/apps/aquamobil/src/graphql/ai-insights.queries.ts`

**Root cause hypothesis:**
The `useAiDashboardInsights` hook queries `farmDashboardInsights` from the backend. The backend returns null when `MCP_ENABLED=false` or when the AI/MCP service is unreachable. The `AiInsightsCard` component correctly shows "AI insights currently unavailable" in this case.

This is **working as designed**. The AI service (MCP-based) needs to be deployed and configured with `MCP_ENABLED=true` for insights to appear. This is not a code bug -- it's a deployment/configuration issue.

**Architectural fix:**
1. Verify the ai-service is deployed and accessible from the farm-service.
2. Set `MCP_ENABLED=true` in the farm-service environment.
3. No code changes needed -- the graceful degradation is correctly implemented.

**Dependencies:** Requires ai-service deployment.

**Effort:** S (Small) -- Deployment configuration only.

---

### BUG-11: Water Quality equipment list empty (P2-LOW)

**Files investigated:**
- `/var/aqua-saas/web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx`

**Root cause hypothesis:**
The WaterQualityRecordPage fetches equipment list from a GraphQL query. If BUG-01 (HEAD /graphql 503) causes the app to think it's offline, the equipment query would either fail or return stale cached data. For a new installation with no cache, this means an empty list.

However, this could also be caused by:
1. No equipment being configured in the tenant's database.
2. The equipment query resolver not being wired through the gateway.
3. Missing data seeding for the demo tenant.

**Architectural fix:**
1. Fix BUG-01 first -- this likely resolves the equipment list issue.
2. If the list is still empty after BUG-01 fix, verify the equipment query resolver exists in the backend and equipment data exists in the database for the tenant.
3. Add an empty state message: "No equipment configured. Contact your administrator."

**Dependencies:** BUG-01 (likely). May also need database seeding.

**Effort:** S (Small) -- Mostly downstream of BUG-01.

---

### BUG-12: Messages contacts empty (P2-LOW)

**Files investigated:**
- `/var/aqua-saas/web/apps/aquamobil/src/graphql/messaging-operations.ts`

**Root cause hypothesis:**
In a single-user system (or freshly deployed tenant), there are no other users to message. The "New Chat" page would show an empty contacts list because the `UserPresence` or tenant user query returns only the current user, and the UI filters out self-contacts.

This is **expected behavior for a single-user tenant**. The messaging feature requires at least 2 users to be useful.

**Architectural fix:**
1. Show a helpful empty state: "No contacts available. Invite team members from the admin panel."
2. If the messaging service has a bot/system user, show it as an available contact for AI assistant chat.
3. No fundamental code fix needed -- this is a data/deployment issue.

**Dependencies:** None (UX improvement).

**Effort:** S (Small)

---

### BUG-13: Last synced: Never (P2-LOW)

**Files investigated:**
- `/var/aqua-saas/web/apps/aquamobil/src/hooks/useOfflineQueue.tsx`
- `/var/aqua-saas/web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx`

**Root cause hypothesis:**
The SyncStatusPage does NOT display a "Last synced" timestamp anywhere in its current implementation. The page shows: connection status, pending count, pending operations list, and "All Synced!" when empty. There is no "Last synced: X" field.

The "Last synced: Never" text likely comes from a different part of the app -- possibly the MobileLayout offline banner, or a dashboard widget. Looking at the code, none of the investigated files display "Last synced: Never".

This is likely related to BUG-01: If the HEAD /graphql probe always returns 503, `useNetworkStatus` reports the app as offline. The app never syncs successfully, so any "last synced" timestamp remains null/undefined, displayed as "Never".

**Architectural fix:**
1. Fix BUG-01 first -- once connectivity is properly detected, sync will succeed and the timestamp will be populated.
2. Add a `lastSyncedAt` field to the OfflineProvider context that records the timestamp of the last successful sync.
3. Display it on the SyncStatusPage.

**Dependencies:** BUG-01 (primary), BUG-06 (related state management).

**Effort:** S (Small)

---

## 2. Implementation Waves (Parallel Groups)

### Wave 1: Foundation (MUST be sequential -- unblocks everything)

| Bug | Title | Effort | Rationale |
|-----|-------|--------|-----------|
| BUG-01 | HEAD /graphql 503 | M | Root blocker. Fixes connectivity detection, unblocks BUG-11, BUG-13 |

### Wave 2: Core Functionality (Parallel -- no interdependencies)

| Bug | Title | Effort | Rationale |
|-----|-------|--------|-----------|
| BUG-02 | Leave button wrong route | S | Independent frontend routing fix |
| BUG-03 | Stock In wizard validation | S | Independent frontend UX fix |
| BUG-04 | Write Off renders Stock In | S | Independent query param investigation |
| BUG-06 | Sync page contradictory state | S | Independent state management fix |

### Wave 3: Mutation/Cache Fixes (Parallel -- share common pattern)

| Bug | Title | Effort | Rationale |
|-----|-------|--------|-----------|
| BUG-07 | Clock In UI not updating | M | Optimistic update pattern |
| BUG-09 | Harvest/Transfer silent validation | M | Form validation pattern |
| BUG-08 | Messages badge count | M | Cache/query consistency |

### Wave 4: Backend + Low Priority (Parallel -- independent tracks)

| Bug | Title | Effort | Rationale |
|-----|-------|--------|-----------|
| BUG-05 | useWarehouseSummary 400 | L | Backend resolver needed |
| BUG-10 | AI Insights unavailable | S | Deployment config |
| BUG-11 | WQ equipment empty | S | Downstream of BUG-01 |
| BUG-12 | Messages contacts empty | S | UX empty state |
| BUG-13 | Last synced: Never | S | Downstream of BUG-01 |

---

## 3. Dependency Graph

```
BUG-01 ──────┬──── BUG-11 (downstream: connectivity)
             ├──── BUG-13 (downstream: connectivity/sync)
             └──── BUG-05 (partially: if 400 is caused by offline mode)

BUG-06 ──────┬──── BUG-13 (related state management)

BUG-07 ──────┴──── Pattern: optimistic updates (reusable for all mutation pages)

All others: INDEPENDENT
```

---

## 4. Agent Assignments with Prompts

### Wave 1: BUG-01 (HEAD /graphql 503)

**Agent Type:** `researcher` (investigation) then `coder` (fix)

**Researcher Prompt:**
```
ROLE: Backend investigator for NestJS/Apollo Server middleware ordering.

TASK: Determine why HEAD /graphql returns 503 despite the middleware at
apps/gateway-api/src/main.ts:174-185 intercepting HEAD and returning 200.

INVESTIGATION STEPS:
1. Read apps/gateway-api/src/main.ts and trace the full middleware registration order.
2. Read apps/gateway-api/src/app.module.ts to understand when Apollo/GraphQL module loads.
3. Start the gateway in dev mode and run: curl -I http://localhost:3000/graphql
   Observe whether the response is 200 or 503.
4. If 503: Add a temporary console.log('HEAD middleware reached') inside the HEAD handler.
   Re-run curl. If the log does NOT appear, the middleware is registered AFTER Apollo's handler.
5. Check if Apollo Server's NestJS integration registers an Express route (app.post/app.all)
   vs middleware (app.use). Express route handlers take priority over middleware for the same path.
6. Check the NestJS version and Apollo Server version in package.json — middleware ordering
   behavior changed between NestJS v9 and v10, and between Apollo v3 and v4.

OUTPUT: A root cause report with:
- Exact middleware registration order (numbered list)
- Which component (Apollo/NestJS/Express) handles HEAD /graphql
- Recommended fix approach (NestJS middleware class vs controller endpoint vs middleware reorder)
```

**Coder Prompt:**
```
ROLE: NestJS backend engineer fixing HEAD /graphql connectivity probe.

TASK: Ensure HEAD /graphql returns HTTP 200 for mobile connectivity probes.

CONTEXT: AquaMobil's useNetworkStatus sends HEAD /graphql every 30 seconds.
The current middleware at main.ts:174-185 is registered but may execute AFTER
Apollo Server's handler. The researcher investigation found: [INSERT FINDINGS].

IMPLEMENTATION:
1. Based on the researcher's findings, implement the fix using the recommended approach.
2. If using NestJS middleware class:
   - Create apps/gateway-api/src/middleware/head-graphql.middleware.ts
   - Register it in AppModule.configure() for the /graphql route
   - Remove the duplicate middleware from main.ts
3. If using controller endpoint:
   - Add @Head('/graphql') to an existing controller or create a HealthController
   - Return 200 with no body
4. Write a test that sends HEAD /graphql and asserts 200 response.
5. All comments in English.

VERIFICATION:
- curl -I http://localhost:3000/graphql returns 200
- POST /graphql still works for actual GraphQL queries
- No regression in GraphQL Playground
```

---

### Wave 2: BUG-02 (Leave button wrong route)

**Agent Type:** `researcher`

**Prompt:**
```
ROLE: Frontend investigator for AquaMobil routing issues.

TASK: Identify the exact component where the Leave button navigates to /water-quality/record.

INVESTIGATION STEPS:
1. Search the entire web/apps/aquamobil/src/ directory for all instances of "Leave" buttons
   or links that use navigate() or <Link>.
2. Check these files for path configuration:
   - pages/HomePage.tsx (Quick Actions grid)
   - pages/operations/StaffHubPage.tsx (Quick Actions)
   - pages/operations/OperationsHubPage.tsx
   - pages/operations/DailyOpsHubPage.tsx
3. Search for any component that has both "Leave" label AND "/water-quality" path.
4. If no explicit mismatch found, check if there is a dynamic array/config where
   index ordering could cause button-path misalignment after RBAC filtering.
5. Check MobileLayout.tsx bottom tab bar — could the user be tapping the tab bar
   instead of the Leave button?

OUTPUT:
- Exact file and line number where the Leave button is defined
- The path it navigates to
- Root cause of the /water-quality/record redirect
- Recommended fix
```

---

### Wave 2: BUG-03 (Stock In validation)

**Agent Type:** `coder`

**Prompt:**
```
ROLE: Frontend engineer improving Stock In wizard validation UX.

TASK: Add visible validation feedback when the user taps "Next" without selecting
a category on Step 1 of the Stock In wizard.

FILES TO MODIFY:
- web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx

IMPLEMENTATION:
1. Add a state variable: const [showStepError, setShowStepError] = useState(false);
2. In handleNext(), when canAdvance() returns false, set showStepError to true.
3. Clear showStepError when the user makes a selection (inside setSelectedItemType callback).
4. Below the Step 1 category grid, render an error message when showStepError && step === 1:
   <p className="text-red-500 text-sm text-center mt-3">Please select a category to continue</p>
5. Change the Next button from disabled={!canAdvance()} to always enabled, but with
   visual dimming via CSS classes when canAdvance() is false. This ensures the user CAN
   tap it and see the error.
6. Add min-h spacing or margin-bottom to the wizard bottom buttons to prevent overlap
   with the MobileLayout tab bar.
7. All comments in English.

VERIFICATION:
- Navigate to /storage/movement?type=IN
- Tap "Next" without selecting a category
- Error message appears: "Please select a category to continue"
- Select a category, error disappears, Next works normally
```

---

### Wave 2: BUG-04 (Write Off renders Stock In)

**Agent Type:** `researcher`

**Prompt:**
```
ROLE: Frontend investigator for query parameter handling in React Router.

TASK: Determine if /storage/movement?type=WASTE correctly renders the Write Off variant.

INVESTIGATION STEPS:
1. Read web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx lines 124-134.
2. Verify the useSearchParams hook correctly reads ?type= query parameter.
3. Check if the StorageHubPage Write Off button uses navigate('/storage/movement?type=WASTE')
   and whether navigate() preserves query strings.
4. Check if React Router's lazy() loading or Suspense boundary causes query param loss.
5. Reproduce by navigating: StorageHubPage -> Write Off button -> check URL bar and header.
6. If the URL shows ?type=WASTE but the header shows "Stock In", there is a parsing bug.
7. If the URL shows no ?type= parameter, there is a navigation/routing bug.

OUTPUT:
- Whether the bug is reproducible in the current codebase
- If yes: exact line where the query param is lost
- Recommended fix
```

---

### Wave 2: BUG-06 (Sync page contradictory state)

**Agent Type:** `coder`

**Prompt:**
```
ROLE: Frontend engineer fixing state consistency in the sync status page.

TASK: Eliminate the contradictory "1 Pending Operations" + "All Synced!" display
in the SyncStatusPage.

FILES TO MODIFY:
- web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx
- web/apps/aquamobil/src/hooks/useOfflineQueue.tsx (if needed)

ROOT CAUSE: pendingCount and pendingOperations are separate state variables
that can temporarily diverge. The SyncStatusPage uses pendingCount for the
count display but pendingOperations.length for the list/empty-state toggle.

IMPLEMENTATION:
1. In SyncStatusPage.tsx, replace all references to pendingCount with
   pendingOperations.length. This ensures the count and list always agree.
2. Alternatively, in useOfflineQueue.tsx, derive pendingCount from
   pendingOperations: const pendingCount = pendingOperations.length;
   Remove the separate pendingCount state variable.
3. If keeping the separate state for performance reasons (IndexedDB count is O(1)),
   ensure both are set atomically in refreshQueue() by using a single setState call
   or React 18's automatic batching guarantee.
4. All comments in English.

VERIFICATION:
- Queue an operation while offline
- Navigate to /sync
- Verify count matches list length
- Sync the operation
- Verify both count and list update to zero simultaneously
```

---

### Wave 3: BUG-07 (Clock In UI not updating)

**Agent Type:** `coder`

**Prompt:**
```
ROLE: Frontend engineer implementing optimistic UI updates for attendance mutations.

TASK: After a clock-in/clock-out is queued, immediately update the UI to reflect
the new attendance state without waiting for backend sync.

FILES TO MODIFY:
- web/apps/aquamobil/src/pages/attendance/AttendancePage.tsx

CONTEXT: The clock-in mutation goes to the offline queue (addToQueue) and
executes later during sync. But refetchToday() fires immediately after the
success screen, and the backend has no record yet, so the UI reverts.

IMPLEMENTATION:
1. Import useQueryClient from @tanstack/react-query.
2. After addToQueue('clockIn', ...) succeeds, use queryClient.setQueryData()
   to optimistically insert a fake attendance record into the
   ['todaysAttendance', tenantId, employeeId] query cache:
   ```
   queryClient.setQueryData(
     ['todaysAttendance', tenantId, employeeId],
     (old: AttendanceRecord[] | undefined) => [
       ...(old ?? []),
       {
         id: 'optimistic-' + Date.now(),
         employeeId,
         date: new Date().toISOString().split('T')[0],
         clockIn: new Date().toISOString(),
         clockOut: undefined,
         status: 'PRESENT' as const,
         workedMinutes: 0,
         overtimeMinutes: 0,
         lateMinutes: 0,
         isOffshore: false,
       },
     ]
   );
   ```
3. Similarly for clockOut: update the existing record's clockOut field.
4. Remove the refetchToday() call from the setTimeout — the optimistic
   data is already in cache. Real data will arrive on next refetch cycle
   (staleTime 30s) or after sync completes.
5. After sync completes (listen for SYNC_COMPLETE event from service worker),
   invalidate the todaysAttendance query to get server-confirmed data.
6. All comments in English.

VERIFICATION:
- Tap Clock In
- After success screen dismisses, verify UI shows "Clock Out" button (clocked in state)
- Check that the today's record section shows the clock-in time
- When online, verify data eventually syncs to backend and UI stays consistent
```

---

### Wave 3: BUG-08 (Messages badge count)

**Agent Type:** `coder`

**Prompt:**
```
ROLE: Frontend engineer fixing message unread count badge inconsistency.

TASK: Ensure the Messages tab badge count matches the actual unread messages
visible in the channel list.

FILES TO MODIFY:
- web/apps/aquamobil/src/hooks/useUnreadCount.ts
- web/apps/aquamobil/src/pages/messaging/ChannelListPage.tsx (if needed)

IMPLEMENTATION:
1. In useUnreadCount.ts, add error handling: if the totalUnreadMessageCount
   query fails with a network error, return 0 instead of retaining stale data.
2. In ChannelListPage (or wherever channels are loaded), after fetching channels:
   - Calculate the actual unread count by summing channel.unreadCount across
     all visible channels.
   - If this differs from the global totalUnreadMessageCount, use
     queryClient.setQueryData to correct the badge count.
3. When the user opens the Messages tab and sees no channels with unread messages,
   force the badge to 0 via queryClient.setQueryData.
4. If the backend totalUnreadMessageCount resolver is counting messages from
   archived/left channels, that is a backend fix (document it but implement
   the frontend correction regardless).
5. All comments in English.

VERIFICATION:
- With no unread messages, badge should show nothing (0)
- Send a message, badge shows 1
- Read the message, badge returns to 0
```

---

### Wave 3: BUG-09 (Silent validation)

**Agent Type:** `coder`

**Prompt:**
```
ROLE: Frontend engineer adding form validation feedback to harvest and transfer forms.

TASK: Replace silent disabled buttons with active validation feedback on
RecordHarvestPage and RecordTransferPage.

FILES TO MODIFY:
- web/apps/aquamobil/src/pages/harvest/RecordHarvestPage.tsx
- web/apps/aquamobil/src/pages/transfer/RecordTransferPage.tsx

IMPLEMENTATION:
For both pages:
1. Add a [hasAttemptedSubmit, setHasAttemptedSubmit] state variable.
2. Change the "Review" button from disabled={...} to always enabled.
3. In the button onClick, call setHasAttemptedSubmit(true) then validateForm().
4. If validateForm() returns false, do NOT proceed to the confirm step.
   The errors state is now populated and will render inline error messages.
5. Show inline error messages below each field ONLY when hasAttemptedSubmit is true:
   - Tank selector: "Please select a tank"
   - Quantity: "Quantity must be at least 1"
   - Avg Weight (harvest only): "Average weight is required"
   - Destination Tank (transfer only): "Please select a destination tank"
6. Use consistent error styling: text-red-500 text-sm mt-1
7. Clear hasAttemptedSubmit when the user starts editing (first onChange on any field).
8. All comments in English.

VERIFICATION:
- Navigate to /harvest/record
- Tap "Review Harvest" without entering any data
- Error messages appear under empty fields
- Fill in all required fields, errors disappear
- "Review Harvest" proceeds to confirm step
- Repeat for /transfer/record
```

---

### Wave 4: BUG-05 (Warehouse summary resolver)

**Agent Type:** `coder` (backend)

**Prompt:**
```
ROLE: NestJS backend engineer implementing the warehouseSummary GraphQL resolver.

TASK: Create the warehouseSummary query resolver in the storage/sensor service
so the AquaMobil StorageHubPage shows real warehouse KPIs instead of zeros.

CONTEXT: The frontend query GET_WAREHOUSE_SUMMARY is defined in
web/apps/aquamobil/src/graphql/operations.ts (lines 495-519). The backend
currently has NO resolver for this query — confirmed by grep finding zero matches
across the apps/ directory.

INVESTIGATION FIRST:
1. Identify which backend service owns storage domain (likely storage-service or sensor-service).
2. Read the existing storage entity definitions to understand the data model:
   - StorageItem entity (items with currentQty, minQty)
   - StorageMovement entity (movement records)
   - StorageLocation entity
3. Check if these entities exist or if the storage module is in a different service.

IMPLEMENTATION:
1. Define the WarehouseSummary GraphQL type in the service's schema:
   ```graphql
   type LowStockItem {
     id: ID!
     name: String!
     itemType: StorageItemType!
     currentQty: Float!
     minQty: Float!
     unit: String!
   }
   type RecentStockMovement {
     id: ID!
     movementType: StockMovementType!
     itemName: String!
     quantity: Float!
     unit: String!
     createdAt: DateTime!
   }
   type WarehouseSummary {
     totalItems: Int!
     lowStockAlertCount: Int!
     todaysMovementCount: Int!
     lowStockItems: [LowStockItem!]!
     recentMovements: [RecentStockMovement!]!
   }
   extend type Query {
     warehouseSummary: WarehouseSummary!
   }
   ```
2. Create a resolver that:
   - Counts total storage items for the tenant
   - Counts items where currentQty < minQty (low stock)
   - Counts today's movements
   - Returns top 5 low stock items sorted by (currentQty/minQty) ascending
   - Returns top 5 recent movements sorted by createdAt descending
3. Register the resolver in the service module.
4. Ensure the gateway proxies/stitches this query.
5. All comments in English.

VERIFICATION:
- Send the GET_WAREHOUSE_SUMMARY GraphQL query via curl to the gateway
- Response includes totalItems, lowStockAlertCount, todaysMovementCount
- StorageHubPage shows real data instead of zeros
```

---

## 5. File List Per Bug

| Bug | Primary Files | Secondary Files |
|-----|---------------|-----------------|
| BUG-01 | `apps/gateway-api/src/main.ts`, `apps/gateway-api/src/app.module.ts` | `web/apps/aquamobil/src/hooks/useNetworkStatus.ts` |
| BUG-02 | `web/apps/aquamobil/src/pages/HomePage.tsx` | `web/apps/aquamobil/src/App.tsx`, all hub pages with Leave buttons |
| BUG-03 | `web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx` | `web/apps/aquamobil/src/layouts/MobileLayout.tsx` |
| BUG-04 | `web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx` | `web/apps/aquamobil/src/pages/storage/StorageHubPage.tsx` |
| BUG-05 | Backend: storage service entity + resolver (TBD) | `web/apps/aquamobil/src/hooks/useWarehouseSummary.ts`, `web/apps/aquamobil/src/graphql/operations.ts` |
| BUG-06 | `web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx`, `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx` | |
| BUG-07 | `web/apps/aquamobil/src/pages/attendance/AttendancePage.tsx` | `web/apps/aquamobil/src/hooks/useAttendance.ts` |
| BUG-08 | `web/apps/aquamobil/src/hooks/useUnreadCount.ts` | `web/apps/aquamobil/src/layouts/MobileLayout.tsx`, messaging backend |
| BUG-09 | `web/apps/aquamobil/src/pages/harvest/RecordHarvestPage.tsx`, `web/apps/aquamobil/src/pages/transfer/RecordTransferPage.tsx` | |
| BUG-10 | None (deployment config) | `web/apps/aquamobil/src/hooks/useAiInsights.ts` |
| BUG-11 | `web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx` | Downstream of BUG-01 |
| BUG-12 | Messaging channel list page | Messaging backend user query |
| BUG-13 | `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx`, `web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx` | Downstream of BUG-01 |

---

## 6. Execution Summary

| Wave | Bugs | Parallel? | Total Effort | Expected Duration |
|------|------|-----------|--------------|-------------------|
| Wave 1 | BUG-01 | No (sequential) | M | 2-3 hours |
| Wave 2 | BUG-02, BUG-03, BUG-04, BUG-06 | Yes (all parallel) | 4x S | 1-2 hours |
| Wave 3 | BUG-07, BUG-08, BUG-09 | Yes (all parallel) | 3x M | 3-4 hours |
| Wave 4 | BUG-05, BUG-10, BUG-11, BUG-12, BUG-13 | Yes (all parallel) | L + 4x S | 4-5 hours |

**Total estimated time: 10-14 hours across 4 waves.**

---

## 7. Review Checkpoints

After each wave:
1. `reviewer` agent verifies each fix against the root cause analysis.
2. `tester` agent runs the verification steps listed in each agent prompt.
3. No push until reviewer approves.
4. Build verification via GitHub Actions (no local builds).
