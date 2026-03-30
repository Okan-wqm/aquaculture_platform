# ADR-011: Operations Hub Enterprise Restructuring

**Status:** Proposed
**Date:** 2026-03-28
**Decision Makers:** Engineering Lead

---

## 1. Context & Problem Statement

The current `OperationsHubPage.tsx` serves as a flat grid of navigation buttons organized into 4 groups (Daily Ops, Stock Events, Warehouse, Staff). Each button is a dead link to a record form or sub-page with zero contextual data. Workers must navigate into individual pages to understand operational status. There is no at-a-glance intelligence on the operations screen itself.

**Goal:** Transform Operations into a two-tier hub architecture where each of the 4 groups becomes a dedicated enterprise-grade hub page with live KPI summaries, quick actions, and recent activity. The top-level OperationsHubPage becomes a smart landing page linking to these 4 hubs with preview metrics.

---

## 2. Design System Patterns (Observed from Codebase)

The following patterns were extracted from existing pages and must be followed:

| Pattern | Implementation | Source File |
|---------|---------------|-------------|
| Gradient header | `bg-gradient-to-br from-{color}-700 via-{color}-600 to-{color}-500 text-white` | `HomePage.tsx`, `OperationsHubPage.tsx` |
| Curved bottom edge | SVG `<path d="M0 20V0c100 15 200 15 400 0v20z">` | All hub pages |
| KPI stat boxes | `bg-white/10 backdrop-blur-sm rounded-xl p-2.5 text-center` (in header) | `HomePage.tsx`, `MySchedulePage.tsx` |
| Content cards | `bg-white dark:bg-gray-900 rounded-2xl shadow-card p-4 border border-gray-100 dark:border-gray-800` | `AttendancePage.tsx`, `MyLeavesPage.tsx` |
| Action buttons | `bg-gradient-to-br ${gradient} rounded-2xl touch-feedback shadow-card active:scale-[0.97]` | `StorageHubPage.tsx`, `OperationsHubPage.tsx` |
| Section headers | `text-xs font-bold text-gray-400 uppercase tracking-wider` | `HomePage.tsx` |
| Safe area top | `pt-safe-top` on first header element | All pages |
| Bottom spacer | `<div className="h-24" />` for tab bar clearance | All pages |
| Empty states | Icon (size 48, opacity-30) + bold title + subtitle | `OperationsHubPage.tsx`, `MySchedulePage.tsx` |
| Skeleton loading | `<div className="h-{N} rounded-2xl skeleton" />` | `HomePage.tsx`, `MySchedulePage.tsx` |
| Back navigation | `ArrowLeft` button with `navigate(-1)`, `p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback` | `AttendancePage.tsx`, `MyLeavesPage.tsx` |
| Permission check | `useMobilePermissions().canAccess(feature)` | All pages |
| Offline queue | `useOfflineQueue().addToQueue(type, payload)` | `AttendancePage.tsx` |
| GraphQL fetching | `graphqlRequest<T>(QUERY, variables)` from `@/services/authenticated-fetch` | All hooks |
| React Query caching | `useQuery` with `cacheData/getCachedData` offline fallback | `useTanks.ts`, `useMySchedule.ts` |
| Manual state hooks | `useState`+`useCallback` pattern for simpler data hooks | `useAttendance.ts`, `useLeave.ts` |

---

## 3. Files Inventory

### 3.1 New Files to Create

| # | File Path | Purpose | Est. Lines |
|---|-----------|---------|-----------|
| 1 | `src/pages/operations/DailyOpsHubPage.tsx` | Daily operations hub with shift status, task progress, quick actions, activity timeline | ~280 |
| 2 | `src/pages/operations/StockEventsHubPage.tsx` | Stock events hub with batch KPIs, quick actions, recent events list | ~220 |
| 3 | `src/pages/operations/StaffHubPage.tsx` | Staff hub with attendance status, leave balance, schedule preview | ~260 |
| 4 | `src/hooks/useDailyOpsStats.ts` | Aggregation hook: today's feeding count, mortality count, WQ readings count from existing queries | ~90 |
| 5 | `src/hooks/useStockEventsSummary.ts` | Hook: active batches count, recent stock events (last 7 days), pending transfers | ~80 |
| 6 | `src/hooks/useWarehouseSummary.ts` | Hook: total inventory items, low stock alerts, today's movement count | ~80 |
| 7 | `src/hooks/useStaffSummary.ts` | Aggregation hook: combines useAttendance + useLeave + useMySchedule data for hub KPIs | ~70 |

**Total new files: 7**

### 3.2 Existing Files to Modify

| # | File Path | Change Description |
|---|-----------|-------------------|
| 1 | `src/pages/operations/OperationsHubPage.tsx` | Rewrite: replace flat card grid with 4 rich summary cards linking to hub pages. Each card shows 2-3 metrics from the corresponding hub. Keep existing group permission logic. |
| 2 | `src/pages/storage/StorageHubPage.tsx` | Enhance: add KPI header section (total items, low stock alerts, today's movements), add recent movements list below action grid. Keep existing action buttons intact. |
| 3 | `src/App.tsx` | Add 4 new lazy-loaded page imports and 4 new `<Route>` entries for `/operations/daily`, `/operations/stock`, `/operations/warehouse`, `/operations/staff`. |
| 4 | `src/layouts/MobileLayout.tsx` | Add new hub paths (`/operations/daily`, `/operations/stock`, `/operations/warehouse`, `/operations/staff`) to Operations tab `childPaths` array. |
| 5 | `src/graphql/operations.ts` | Add new queries: `GET_TODAYS_ACTIVITY_TIMELINE`, `GET_STOCK_EVENTS_SUMMARY`, `GET_WAREHOUSE_SUMMARY`, `GET_TODAYS_FEEDING_STATS`. |
| 6 | `src/types/index.ts` | Add types: `DailyOpsStats`, `StockEventSummary`, `WarehouseSummary`, `ActivityTimelineEntry`, `StockEvent`. |

**Total files modified: 6**

### 3.3 Existing Files Unchanged (Dependencies Only)

These files are consumed by the new hub pages but require zero modifications:

- `src/hooks/useAttendance.ts` -- reused by StaffHubPage and DailyOpsHubPage
- `src/hooks/useLeave.ts` -- reused by StaffHubPage
- `src/hooks/useMySchedule.ts` -- reused by StaffHubPage
- `src/hooks/useTanks.ts` -- reused by StockEventsHubPage (batch count)
- `src/hooks/useMyTasks.ts` -- reused by DailyOpsHubPage (task checklist)
- `src/hooks/useMobilePermissions.ts` -- reused by all hub pages
- `src/hooks/useOfflineQueue.tsx` -- reused by all hub pages (online status)
- `src/services/authenticated-fetch.ts` -- used by new hooks

---

## 4. New Routes

| Route | Component | FeatureRoute Guard | Parent Tab |
|-------|-----------|-------------------|------------|
| `/operations/daily` | `DailyOpsHubPage` | `attendance` (lowest-common permission in daily ops group) | Operations |
| `/operations/stock` | `StockEventsHubPage` | `cull` (any stock event permission) | Operations |
| `/operations/warehouse` | `StorageHubPage` (existing, remounted at new URL) | `storage` | Operations |
| `/operations/staff` | `StaffHubPage` | `attendance` | Operations |

**Backward compatibility:**
- `/storage` continues to work (existing route kept, renders same `StorageHubPage`)
- `/operations` continues to work (renders refactored landing page)
- All existing deep links (`/feeding/record`, `/mortality/record`, etc.) are unchanged

---

## 5. New Hooks

### 5.1 `useDailyOpsStats`

```typescript
// Aggregates data from multiple existing sources for the DailyOpsHubPage KPI strip.
// Does NOT make new backend calls -- reuses existing query results.

interface DailyOpsStats {
  isClockedIn: boolean;
  clockedInSince: string | null;       // ISO datetime
  tanksFedToday: number;               // from GET_TODAYS_FEEDING_PLAN (count status=COMPLETED)
  totalTanksToFeed: number;            // from GET_TODAYS_FEEDING_PLAN (total count)
  mortalityCountToday: number;         // NEW query needed
  wqReadingsToday: number;             // NEW query needed
  todaysTasksCompleted: number;        // from useMyTasks (completed today filter)
  todaysTasksTotal: number;            // from useMyTasks (today filter)
}

// Internally calls:
// - useTodaysAttendance() (existing)
// - graphqlRequest(GET_TODAYS_FEEDING_PLAN) (existing query)
// - graphqlRequest(GET_TODAYS_DAILY_OPS_COUNTS) (NEW query - lightweight count aggregation)
// - useMyTasks('today') (existing)
```

### 5.2 `useStockEventsSummary`

```typescript
interface StockEventsSummary {
  activeBatchCount: number;             // from useTanks (count where batchMetrics != null)
  thisWeekEventsCount: number;          // NEW query
  pendingTransferCount: number;         // NEW query
  recentEvents: StockEvent[];           // NEW query (last 7 days, limit 10)
}

// Internally calls:
// - useTanks() for activeBatchCount (already cached, no extra network call)
// - graphqlRequest(GET_STOCK_EVENTS_SUMMARY) (NEW query - single aggregation endpoint)
```

### 5.3 `useWarehouseSummary`

```typescript
interface WarehouseSummary {
  totalItems: number;                   // NEW query
  lowStockAlertCount: number;           // NEW query
  todaysMovementCount: number;          // NEW query
  lowStockItems: LowStockItem[];        // NEW query (limit 5)
  recentMovements: StockMovement[];     // NEW query (limit 5)
}

// Single NEW query: GET_WAREHOUSE_SUMMARY
```

### 5.4 `useStaffSummary`

```typescript
interface StaffSummary {
  isClockedIn: boolean;                 // from useTodaysAttendance (existing)
  clockedInSince: string | null;
  totalLeaveRemaining: number;          // from useMyLeaveBalances (sum of remainingDays)
  nextScheduledShift: WeeklyPlanEntry | null;  // from useMySchedule (first future work entry)
  schedulePreview: WeeklyPlanEntry[];   // from useMySchedule (next 3 days)
}

// Internally calls only existing hooks:
// - useTodaysAttendance()
// - useMyLeaveBalances()
// - useMySchedule()
// No new backend queries needed.
```

---

## 6. GraphQL Queries Needed

### 6.1 New Queries (Backend Must Implement)

```graphql
# Query 1: Lightweight count aggregation for DailyOps KPIs
# Backend: sensor-service + farm-service resolvers
query GetTodaysDailyOpsCounts {
  todaysDailyOpsCounts {
    mortalityCount
    wqReadingsCount
  }
}

# Query 2: Stock events aggregation
# Backend: farm-service resolver
query GetStockEventsSummary($daysBack: Int = 7, $limit: Int = 10) {
  stockEventsSummary(daysBack: $daysBack) {
    thisWeekEventsCount
    pendingTransferCount
    recentEvents(limit: $limit) {
      id
      type            # CULL | HARVEST | TRANSFER | MORTALITY
      tankName
      quantity
      createdAt
      note
    }
  }
}

# Query 3: Warehouse summary
# Backend: storage-service resolver
query GetWarehouseSummary {
  warehouseSummary {
    totalItems
    lowStockAlertCount
    todaysMovementCount
    lowStockItems {
      id
      name
      itemType
      currentQty
      minQty
      unit
    }
    recentMovements {
      id
      movementType
      itemName
      quantity
      unit
      createdAt
    }
  }
}
```

### 6.2 Existing Queries Reused (No Backend Changes)

- `GET_TODAYS_FEEDING_PLAN` -- used by DailyOpsHubPage to calculate fed/total tanks
- `GET_TODAYS_ATTENDANCE` -- used by DailyOpsHubPage and StaffHubPage for clock-in status
- `GET_MY_ATTENDANCE_SUMMARY` -- used by StaffHubPage for monthly stats
- `GET_MY_LEAVE_BALANCES` -- used by StaffHubPage for remaining leave days
- `weeklyPlans` (via `useMySchedule`) -- used by StaffHubPage for schedule preview
- `GET_MY_TASKS` / `GET_TODAYS_TASKS` -- used by DailyOpsHubPage for task checklist

---

## 7. Component Structure Per Page

### 7.1 DailyOpsHubPage (`/operations/daily`)

```
DailyOpsHubPage
|-- Gradient Header (from-orange-600 to-amber-500, Clock icon)
|   |-- Back button -> /operations
|   |-- Title: "Daily Operations"
|   |-- Subtitle: shift status text ("Clocked in since 08:15" / "Not clocked in")
|   |-- KPI Strip (4 cols)
|       |-- Shift Status (green dot / gray dot)
|       |-- Tanks Fed (X/Y)
|       |-- Mortality Count
|       |-- WQ Readings
|-- Curved SVG edge
|-- Shift Checklist Card (if tasks exist)
|   |-- Section header: "Today's Checklist"
|   |-- Progress bar (completed/total)
|   |-- List of today's tasks with checkmarks (max 5)
|-- Quick Actions Grid (2 cols)
|   |-- Clock In/Out (context-aware: green if not clocked in, red if clocked in)
|   |-- Mortality Check
|   |-- Water Quality
|   |-- Feeding
|-- Activity Timeline Card
|   |-- Section header: "Today's Activity"
|   |-- Chronological list of last 5 actions today
|   |-- Empty state: "No activity recorded yet"
|-- Bottom spacer (h-24)
```

**Permission mapping:** Each quick action button is individually permission-filtered using `canAccess()`. The page itself renders if the user has ANY of: `attendance`, `mortality`, `waterQuality`, `feeding`.

### 7.2 StockEventsHubPage (`/operations/stock`)

```
StockEventsHubPage
|-- Gradient Header (from-purple-700 to-violet-500, Boxes icon)
|   |-- Back button -> /operations
|   |-- Title: "Stock Events"
|   |-- KPI Strip (3 cols)
|       |-- Active Batches (from useTanks)
|       |-- This Week's Events
|       |-- Pending Transfers
|-- Curved SVG edge
|-- Quick Actions Grid (2 cols, 1 row)
|   |-- Culling (permission: cull)
|   |-- Harvest (permission: harvest)
|   |-- Transfer (permission: transfer)
|-- Recent Stock Events Card
|   |-- Section header: "Recent Events (7 Days)"
|   |-- List of events with type icon, tank name, quantity, timestamp
|   |-- Each event has type-colored left border (red=mortality, amber=cull, violet=harvest, blue=transfer)
|   |-- Empty state: "No stock events this week"
|-- Bottom spacer (h-24)
```

### 7.3 Enhanced StorageHubPage (`/operations/warehouse` AND `/storage`)

```
StorageHubPage (enhanced)
|-- Gradient Header (from-teal-700 to-teal-500, Warehouse icon) [EXISTING]
|   |-- KPI Strip (3 cols) [NEW]
|       |-- Total Items
|       |-- Low Stock Alerts (red if > 0)
|       |-- Today's Movements
|-- Curved SVG edge [EXISTING]
|-- Quick Actions Grid (2 cols) [EXISTING - unchanged]
|   |-- Stock In, Stock Out, Transfer, Write Off, View Stock
|-- Low Stock Alerts Card [NEW]
|   |-- Section header: "Low Stock Alerts"
|   |-- List of items below minimum threshold (max 5)
|   |-- Each item: name, current qty / min qty, red progress bar
|   |-- Hidden if count == 0
|-- Recent Movements Card [NEW]
|   |-- Section header: "Recent Movements"
|   |-- List of last 5 movements with type icon (IN=green, OUT=red, WASTE=gray), item name, qty, time
|   |-- Empty state: "No movements today"
|-- Bottom spacer (h-24)
```

### 7.4 StaffHubPage (`/operations/staff`)

```
StaffHubPage
|-- Gradient Header (from-indigo-700 to-indigo-500, Users icon)
|   |-- Back button -> /operations
|   |-- Title: "Staff"
|   |-- Subtitle: attendance status text
|   |-- KPI Strip (3 cols)
|       |-- Attendance Status (Clocked In / Off Duty)
|       |-- Leave Balance (total remaining days across all types)
|       |-- This Week (X work days)
|-- Curved SVG edge
|-- Quick Actions Grid (2 cols, 1 row)
|   |-- Clock In/Out (attendance) -- context-aware button
|   |-- Leave Request (leave) -> /leave
|   |-- My Schedule (schedule) -> /schedule
|   |-- My Leaves (leave) -> /leave
|-- Schedule Preview Card
|   |-- Section header: "Upcoming Schedule"
|   |-- Next 3 days from schedule (compact DayCard format)
|   |-- Empty state: "No schedule published"
|-- Leave Balance Card
|   |-- Section header: "Leave Balance"
|   |-- Top leave type with highest remaining days
|   |-- Mini progress bar
|   |-- "View All" link -> /leave
|-- Bottom spacer (h-24)
```

### 7.5 Refactored OperationsHubPage (`/operations`)

```
OperationsHubPage (landing page)
|-- Gradient Header (from-ocean-700 to-ocean-500, ClipboardList icon) [EXISTING STYLE]
|   |-- Title: "Operations"
|-- Curved SVG edge
|-- Hub Summary Cards (vertical stack, 4 cards)
|   |-- Daily Ops Card -> /operations/daily
|   |   |-- Header: gradient pill "Daily Operations" (from-orange-500 to-amber-500)
|   |   |-- Metrics row: Shift status, Tanks fed X/Y, Tasks X/Y
|   |   |-- Chevron right indicator
|   |   |-- RBAC: visible if canAccess(attendance|mortality|waterQuality|feeding)
|   |-- Stock Events Card -> /operations/stock
|   |   |-- Header: gradient pill "Stock Events" (from-purple-500 to-violet-500)
|   |   |-- Metrics row: Active batches, This week events, Pending transfers
|   |   |-- RBAC: visible if canAccess(cull|harvest|transfer)
|   |-- Warehouse Card -> /operations/warehouse
|   |   |-- Header: gradient pill "Warehouse" (from-teal-500 to-teal-600)
|   |   |-- Metrics row: Total items, Low stock alerts, Today movements
|   |   |-- RBAC: visible if canAccess(storage)
|   |-- Staff Card -> /operations/staff
|   |   |-- Header: gradient pill "Staff" (from-indigo-500 to-indigo-600)
|   |   |-- Metrics row: Attendance status, Leave remaining, Schedule
|   |   |-- RBAC: visible if canAccess(attendance|leave|schedule)
|-- Empty state (if no cards visible)
|-- Bottom spacer (h-24)
```

---

## 8. Implementation Order (Phases)

### Phase 1: Foundation (Types, Queries, Hooks)

**Files touched:** `types/index.ts`, `graphql/operations.ts`, 4 new hook files

1. Add new TypeScript types to `src/types/index.ts`
2. Add new GraphQL query strings to `src/graphql/operations.ts`
3. Create `src/hooks/useStaffSummary.ts` (depends only on existing hooks -- no new backend queries)
4. Create `src/hooks/useDailyOpsStats.ts` (partial -- clock-in and tasks work immediately, feeding/mortality/WQ counts will need backend or use graceful fallback)
5. Create `src/hooks/useStockEventsSummary.ts` (partial -- batch count from useTanks works immediately, event list needs backend)
6. Create `src/hooks/useWarehouseSummary.ts` (needs backend, design with graceful null fallback)

**Dependency:** Hooks MUST be designed with graceful fallback -- all KPI values nullable/defaulting to 0 or `null` when the backend query doesn't exist yet. This allows frontend to ship before backend.

### Phase 2: Hub Pages (New Pages)

**Files touched:** 3 new page files, 1 modified page file

1. Create `src/pages/operations/StaffHubPage.tsx` (easiest -- fully backed by existing hooks)
2. Create `src/pages/operations/DailyOpsHubPage.tsx`
3. Create `src/pages/operations/StockEventsHubPage.tsx`
4. Enhance `src/pages/storage/StorageHubPage.tsx` with KPI header + low stock + recent movements

**Each page must include:**
- Loading skeleton state
- Empty/offline state
- Error state (catch and display, do not crash)
- Permission check on individual actions
- Offline awareness banner

### Phase 3: Routing & Landing Page

**Files touched:** `App.tsx`, `MobileLayout.tsx`, `OperationsHubPage.tsx`

1. Add lazy imports and routes in `App.tsx`
2. Add new childPaths to Operations tab in `MobileLayout.tsx`
3. Rewrite `OperationsHubPage.tsx` as the smart landing page with summary cards
4. Wire up navigation from landing page cards to hub pages

### Phase 4: Backend Queries (Requires Backend Work)

**Backend services to update:**

| Query | Backend Service | Priority |
|-------|----------------|----------|
| `todaysDailyOpsCounts` | farm-service (mortality), sensor-service (WQ) | P2 -- frontend has partial data without this |
| `stockEventsSummary` | farm-service | P2 -- frontend shows "no events" gracefully |
| `warehouseSummary` | config-service (storage module) | P1 -- warehouse hub KPIs depend on this entirely |

**Note:** Phase 2/3 can ship independently. The hub pages will show "0" or "No data" for metrics that need new backend queries, then light up as backend resolvers are deployed.

---

## 9. Routing Table (Complete)

```
/operations                     -> OperationsHubPage (landing, 4 summary cards)
/operations/daily               -> DailyOpsHubPage
/operations/stock               -> StockEventsHubPage
/operations/warehouse           -> StorageHubPage (enhanced, also serves /storage)
/operations/staff               -> StaffHubPage

# Existing routes (unchanged)
/storage                        -> StorageHubPage (kept for backward compat)
/storage/movement               -> StockMovementPage
/storage/transfer               -> StockTransferPage
/storage/view                   -> StockViewPage
/attendance                     -> AttendancePage
/leave                          -> MyLeavesPage
/leave/request                  -> LeaveRequestPage
/schedule                       -> MySchedulePage
/feeding/record                 -> RecordFeedingPage
/mortality/record               -> RecordMortalityPage
/cull/record                    -> RecordCullPage
/harvest/record                 -> RecordHarvestPage
/transfer/record                -> RecordTransferPage
/water-quality/record           -> WaterQualityRecordPage
```

---

## 10. MobileLayout childPaths Update

Current `childPaths` for Operations tab:
```typescript
['/feeding', '/mortality', '/cull', '/harvest', '/transfer', '/water-quality', '/storage', '/attendance', '/leave', '/schedule']
```

New `childPaths` (add hub sub-routes):
```typescript
['/feeding', '/mortality', '/cull', '/harvest', '/transfer', '/water-quality', '/storage', '/attendance', '/leave', '/schedule', '/operations/daily', '/operations/stock', '/operations/warehouse', '/operations/staff']
```

Note: The hub sub-routes already match via `location.pathname.startsWith('/operations')` in the `isActive` function, so technically only the non-`/operations`-prefixed paths need to be in `childPaths`. However, adding them explicitly ensures clarity and future-proofs against refactors of the active-state detection logic. Actually, re-reading the `isActive` logic:

```typescript
if (tab.path !== '/' && location.pathname.startsWith(tab.path)) return true;
```

Since `tab.path` for Operations is `/operations`, any path starting with `/operations` (including `/operations/daily`) already matches. So the `childPaths` update is NOT strictly needed for the new hub routes. However, the existing childPaths for non-`/operations`-prefixed routes must remain.

**Decision:** No change to `childPaths` needed. The existing logic already handles `/operations/*` routes.

---

## 11. Permission Strategy

### FeatureRoute Guards (New Routes)

| Route | FeatureRoute `feature` | Rationale |
|-------|----------------------|-----------|
| `/operations/daily` | None (multi-feature) | Page internally hides individual actions. Using a single feature guard would block users who have some but not all daily ops permissions. |
| `/operations/stock` | None (multi-feature) | Same rationale. |
| `/operations/warehouse` | `storage` | Single-feature hub. |
| `/operations/staff` | None (multi-feature) | Contains attendance + leave + schedule. |

**Alternative approach (recommended):** Create a lightweight wrapper that checks if the user has ANY of the hub's features, using the same pattern as the Operations tab in MobileLayout:

```typescript
function MultiFeatureRoute({ features, children }: { features: MobileFeature[]; children: ReactNode }) {
  const { canAccess, isLoaded } = useMobilePermissions();
  if (!isLoaded) return <PageLoader />;
  if (!features.some(f => canAccess(f))) return <Navigate to="/operations" replace />;
  return <>{children}</>;
}

// Usage:
<Route path="/operations/daily" element={
  <MultiFeatureRoute features={['attendance', 'mortality', 'waterQuality', 'feeding']}>
    <DailyOpsHubPage />
  </MultiFeatureRoute>
} />
```

This is cleaner than wrapping in a single `FeatureRoute` which only checks one feature.

---

## 12. Offline & Caching Strategy

| Data Source | Cache Strategy | TTL | Fallback |
|-------------|---------------|-----|----------|
| Tank/batch data | React Query + IndexedDB | 1 min stale / 1 hr gc | IndexedDB cache |
| Today's attendance | Manual fetch, no persistent cache | Per-session | Empty array |
| Leave balances | Manual fetch, no persistent cache | Per-session | Empty array |
| Schedule | React Query + IndexedDB | 5 min stale / 30 min gc | IndexedDB cache |
| Tasks | Manual fetch + IndexedDB | 30 min TTL | IndexedDB cache |
| Feeding plan | Manual fetch, no persistent cache | Per-session | Empty array |
| Stock events summary | NEW: React Query + IndexedDB | 5 min stale / 30 min gc | IndexedDB cache |
| Warehouse summary | NEW: React Query + IndexedDB | 5 min stale / 30 min gc | IndexedDB cache |
| Daily ops counts | NEW: React Query + IndexedDB | 2 min stale / 15 min gc | Default zeros |

All new hooks should follow the `useTanks` pattern: try network first, fall back to IndexedDB on failure. KPI values should default to `0` or `null` rather than throwing errors, so the page always renders.

---

## 13. Estimated Component Sizes

| Component | Lines | Complexity |
|-----------|-------|-----------|
| `DailyOpsHubPage.tsx` | ~280 | Medium (aggregates multiple data sources) |
| `StockEventsHubPage.tsx` | ~220 | Low-Medium (single data source + tanks) |
| `StaffHubPage.tsx` | ~260 | Medium (aggregates 3 existing hooks) |
| `OperationsHubPage.tsx` (rewrite) | ~250 | Medium (4 summary cards with metrics) |
| `StorageHubPage.tsx` (enhanced) | ~250 | Low (add sections to existing page) |
| `useDailyOpsStats.ts` | ~90 | Low |
| `useStockEventsSummary.ts` | ~80 | Low |
| `useWarehouseSummary.ts` | ~80 | Low |
| `useStaffSummary.ts` | ~70 | Low |

**Total new/modified code:** ~1,580 lines across 11 files (7 new + 4 modified).

All files stay well under the 500-line limit from CLAUDE.md.

---

## 14. Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| New backend queries not ready when frontend ships | High | All hooks designed with graceful null/zero fallback. Pages render with "0" or "No data" states. |
| Performance regression from additional GraphQL calls on hub pages | Medium | Use React Query deduplication. DailyOpsHubPage and StaffHubPage share `useTodaysAttendance` -- only one network call due to shared query key. |
| Breaking existing `/storage` route | Low | StorageHubPage is enhanced in-place. `/storage` route kept. `/operations/warehouse` renders same component. |
| Permission model too coarse for multi-feature hubs | Low | `MultiFeatureRoute` pattern checks ANY feature, not ALL. Individual actions within hubs are per-feature filtered. |

---

## 15. Testing Strategy

Each new component should have:

1. **Rendering test:** Renders without crashing with mocked providers
2. **Permission test:** Hidden elements when `canAccess` returns false
3. **Empty state test:** Correct empty state when data arrays are empty
4. **Loading state test:** Skeleton elements shown while loading
5. **Navigation test:** Quick action buttons navigate to correct paths
6. **Offline test:** "Offline" indicator shown when `isOnline` is false

Test files location: `src/hooks/__tests__/` for hooks, co-located `__tests__/` for pages.

---

## 16. Summary of All Changes

**New files (7):**
- `/var/aqua-saas/web/apps/aquamobil/src/pages/operations/DailyOpsHubPage.tsx`
- `/var/aqua-saas/web/apps/aquamobil/src/pages/operations/StockEventsHubPage.tsx`
- `/var/aqua-saas/web/apps/aquamobil/src/pages/operations/StaffHubPage.tsx`
- `/var/aqua-saas/web/apps/aquamobil/src/hooks/useDailyOpsStats.ts`
- `/var/aqua-saas/web/apps/aquamobil/src/hooks/useStockEventsSummary.ts`
- `/var/aqua-saas/web/apps/aquamobil/src/hooks/useWarehouseSummary.ts`
- `/var/aqua-saas/web/apps/aquamobil/src/hooks/useStaffSummary.ts`

**Modified files (6):**
- `/var/aqua-saas/web/apps/aquamobil/src/pages/operations/OperationsHubPage.tsx` (rewrite as landing page)
- `/var/aqua-saas/web/apps/aquamobil/src/pages/storage/StorageHubPage.tsx` (enhance with KPIs)
- `/var/aqua-saas/web/apps/aquamobil/src/App.tsx` (add routes)
- `/var/aqua-saas/web/apps/aquamobil/src/layouts/MobileLayout.tsx` (no change needed -- existing logic covers sub-routes)
- `/var/aqua-saas/web/apps/aquamobil/src/graphql/operations.ts` (add 3 new queries)
- `/var/aqua-saas/web/apps/aquamobil/src/types/index.ts` (add 5-6 new interfaces)

**Backend work required (separate PRs):**
- farm-service: `todaysDailyOpsCounts` query, `stockEventsSummary` query
- config-service (storage): `warehouseSummary` query
