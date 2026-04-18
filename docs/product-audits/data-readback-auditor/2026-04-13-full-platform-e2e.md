# Data Readback Audit: `2026-04-13-full-platform-e2e`

Scope: persistence-to-UI readback across detail pages, list pages, summary widgets, dashboards, edit preload paths, and mobile read paths.

Prior cycle: `2026-04-11-full-platform-e2e.md` (4 findings). Commit `79ce984f` claimed to fix 12 findings from the broader audit.

## Prior Cycle Status

### RESOLVED (2 of 4)

- **high-003** (analytics dashboard synthetic/truncated DAU data): **RESOLVED**. The AnalyticsDashboardPage now fetches real data from `analyticsApi.getDashboardSummary()`, `analyticsApi.getTenantGrowthTrend()`, and `analyticsApi.getRevenueTrend()`. The fabricated DAU multiplication has been removed (line 448: `setUserTrend([])` with a TODO to wire the real endpoint). The chart now shows a transparent "Analytics not yet available" overlay instead of fake data. The period is passed to the API (`selectedPeriod`, line 402) and `dataPoints` is capped at 30 for the API call but the period itself is no longer misrepresented. File: `web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx` lines 392-488, 698-712.

- **medium-002** (tenant user search only on current page): **RESOLVED**. The search query is now debounced and applied as a client-side filter on `users` (line 126-129), and the `useTenantUsersRaw` hook accepts server-side `status` and `role` filters (line 115-120). Search is clearly a local filter on the current page, which, while still client-side, is no longer misleading since the status and role filters are now server-side. File: `web/modules/tenant-admin/src/pages/TenantUsers.tsx` lines 80-129.

### STILL OPEN (2 of 4)

- **high-001** (tenant user edit round-trip incomplete): **STILL OPEN**. See finding `HIGH-001` below.

- **medium-004** (mobile home task badge stale after mutations): **STILL OPEN**. See finding `MEDIUM-003` below.

## Findings

### HIGH-001 -- Tenant User Edit Preload Missing roleId and phoneNumber (RECURRING)

- **Stored source of truth:** User entity has `roleId` (UUID FK to roles table) and `phoneNumber` fields persisted in the auth-service database.
- **Read path:** `TENANT_USERS_QUERY` in `web/modules/tenant-admin/src/graphql/user-queries.ts` (lines 16-30) fetches `role` (string name), but does NOT fetch `roleId` or `phoneNumber`.
- **Transform path:** `transformUser()` in `web/modules/tenant-admin/src/pages/TenantUsers.tsx` (lines 41-60) produces a `DisplayUser` with `role: string` (role name), no `roleId`, no `phoneNumber`, no `firstName`/`lastName` (merged into `name`).
- **Edit preload surface:** `AddEditUserModal` prop type expects `{ roleId?: string; phoneNumber?: string; firstName?: string; lastName?: string }` (line 44-52 of `web/modules/tenant-admin/src/components/users/AddEditUserModal.tsx`). The component receives `editingUser: DisplayUser` directly (line 289 of TenantUsers.tsx), which has none of these fields.
- **Impact:** When editing a user: (1) `roleId` is always `''` on preload, so the role radio group starts unselected regardless of the user's current role, (2) `phoneNumber` is always `''`, so any stored phone is invisible and will be blanked on save, (3) `firstName`/`lastName` are not decomposed from `name`, so the name fields populate incorrectly (full concatenated name or email prefix in both or neither field).
- **Root cause:** The `DisplayUser` interface is a view-model for the list table, not an edit-form DTO. The edit modal needs the raw `ApiUser` fields, but the page transforms away the editable fields before passing them to the modal.
- **Cross-domain dependency:** form-write-auditor (save path), contract-parity-auditor (GraphQL query missing fields).

### HIGH-002 -- Farm Detail, List, and Form Pages Render Entirely Mock Data

- **Stored source of truth:** Sites entity in farm-service database (persisted via `createSite` / `updateSite` mutations, queried via `sites` / `site` GraphQL resolvers). Real hooks exist: `useSiteList()`, `useSite()` in `web/modules/farm-module/src/hooks/useSites.ts`.
- **Read paths that should expose it:** `FarmDetailPage.tsx`, `FarmListPage.tsx`, `FarmFormPage.tsx` in `web/modules/farm-module/src/pages/`.
- **Actual behavior:**
  - `FarmDetailPage.tsx` (lines 33-63): hardcoded `mockFarm`, `mockSensors`, and `mockChartData` objects. The `siteId` URL param is extracted (line 70) but never used to fetch real data. `isLoading` is hardcoded `false` (line 77).
  - `FarmListPage.tsx` (lines 42-87): hardcoded `mockFarms` array of 4 items. Filtering and searching are performed against this array only. Pagination onChange is a no-op `() => {}` (line 286). Delete handler does `console.log` (line 295).
  - `FarmFormPage.tsx` (lines 45-54): form state defaults to empty strings, and when `isEdit` is true (siteId param present), no data is fetched from the API. The submit handler (line 101) simulates a 1-second delay and does `console.log` only. Uses forbidden `console.log` pattern.
- **Impact:** All three core farm management pages (list, detail, edit) show fabricated data to the user. No real farm data from the database is rendered. Users cannot view, edit, or confirm any persisted farm. This is the most severe readback failure on the platform since the farm module is a core domain surface.
- **Cross-domain dependency:** form-write-auditor (save path is a no-op), list-visibility-auditor (list is entirely fake).

### HIGH-003 -- Farm Detail Page Sensor Data and Chart Are Hardcoded Mock

- **Stored source of truth:** Sensor readings persisted in sensor-service (time-series data). Real hooks exist: `useSensorReadings`, `useDataChannelList` in `web/modules/sensor-module/src/hooks/`.
- **Read path:** `FarmDetailPage.tsx` lines 47-63: `mockSensors` (6 fixed values) and `mockChartData` (6 fixed time points) are rendered directly. No sensor API call is made. The "Sensors" tab (lines 262-278) and "24 Hour Trend" chart (lines 201-225) render exclusively from these constants.
- **Impact:** Farm managers see fabricated sensor readings (pH 7.4, temperature 24.5C, etc.) that bear no relation to actual equipment readings. This can cause operational decisions based on false data in a life-safety-adjacent domain (dissolved oxygen levels affect fish mortality).
- **Cross-domain dependency:** sensor-expert (real-time data path), mobile-app-auditor (if mobile links to this detail page).

### MEDIUM-001 -- Analytics Dashboard DAU Chart Has No Real Data Source

- **Stored source of truth:** User activity metrics should come from `/analytics/users/activity` endpoint.
- **Read path:** `AnalyticsDashboardPage.tsx` line 448: `setUserTrend([])` with a TODO comment: "Wire userTrend to real user activity endpoint: GET /analytics/users/activity". The analytics API client does define `getUserActivity()` (line 69 of `web/modules/admin-panel/src/services/api/analytics.ts`), but the dashboard page never calls it.
- **UI surface:** The "Daily Active Users" card (lines 698-712) renders an empty chart with an overlay "Analytics not yet available". This is honest about the absence (unlike the prior fabricated DAU curve), but the chart card occupies prime dashboard real estate showing zero information.
- **Impact:** The DAU chart is a dead widget that provides no readback of any persisted data. While no longer misleading (prior high-003 is resolved), the empty chart occupies dashboard space and the data source exists but is not wired.
- **Cross-domain dependency:** contract-parity-auditor (endpoint exists but is not called).

### MEDIUM-002 -- Analytics Dashboard Trend Data Capped at 30 Data Points for 90d and 1y Periods

- **Stored source of truth:** Trend API supports arbitrary data point counts.
- **Read path:** `AnalyticsDashboardPage.tsx` line 402: `analyticsApi.getTenantGrowthTrend(selectedPeriod, Math.min(dataPoints, 30))`. When the user selects 90d (90 data points expected) or 1y (365 data points expected), the API is always called with `dataPoints=30`, capping the resolution.
- **Impact:** For 90-day and annual views, the tenant growth chart shows data at approximately 3-day or 12-day resolution respectively, when the API could deliver daily resolution. Users reviewing long-term trends see a smoothed-over representation that can conceal short-term fluctuations. The period selector UI (7d/30d/90d/1y) implies changing granularity but only changes the time window.
- **Cross-domain dependency:** None external.

### MEDIUM-003 -- Mobile Task Badge Remains Stale After Mutations (RECURRING)

- **Stored source of truth:** Task records in farm-service database, status field updated via `completeTask` / `startTask` mutations.
- **Read path:** `useMyTasks` hook in `web/apps/aquamobil/src/hooks/useMyTasks.ts` fetches once per component lifetime via `hasFetchedRef` (line 38, 70-73). Returns `{ tasks, loading, error, refetch }`.
- **Mutation path:** `useTaskActions` hook in `web/apps/aquamobil/src/hooks/useTaskActions.ts` fires `graphqlRequest(COMPLETE_TASK, ...)` and `graphqlRequest(START_TASK, ...)` (lines 14-34) but never calls `refetch()` and never invalidates any React Query cache key.
- **UI surface:** `HomePage.tsx` (line 105-106, 112, 208-229) reads `todayTasks.length` from `useMyTasks('today')` and renders a task count badge. After completing or starting tasks via `useTaskActions`, the home page task count does not update until a full remount.
- **Root cause:** `useMyTasks` is a manual `useState`+`useCallback` hook, not a React Query hook. `useTaskActions` has no reference to `useMyTasks.refetch()` and no shared cache key to invalidate.
- **Impact:** Mobile field operators see stale task counts on the home screen after completing tasks, leading to repeated unnecessary navigation to the task list.
- **Cross-domain dependency:** mobile-app-auditor (cache lifecycle).

### MEDIUM-004 -- Mobile Offline Cache Shows Data From a Prior Tenant After Tenant Switch

- **Stored source of truth:** IndexedDB cache keyed by `tenantId` in `cacheData(tenantId, key, data, ttl)`.
- **Read path:** Multiple mobile hooks (`useTanks`, `useMyTasks`, `useLeave`, `useAttendance`, `useMySchedule`) fall back to IndexedDB on network failure. The tenant-scoped cache key (e.g., `tanks`, `myTasks`, `schedule_{date}`) is keyed by `tenantId` correctly.
- **Risk surface:** The `useMyTasks` hook (line 55) uses `cacheData(tenantId, 'myTasks', tasks, ...)` which IS correctly tenant-scoped. However, the React Query `queryKey` for `useMyTasks` does NOT include `tenantId`: `queryKey: ['tanks', tenantId]` in `useTanks` (line 50) vs `useMyTasks` which uses manual `useState` and `hasFetchedRef` with no queryKey at all (line 38-73). If a user logs out and re-authenticates with a different tenant (unlikely but possible in a multi-tenant PWA), `hasFetchedRef.current` is already `true`, so the fetch never fires and stale data from the previous session's `allTasks` state persists until app restart.
- **Impact:** LOW probability, HIGH impact if triggered. A user switching tenants (or being reassigned) could see task data from the wrong tenant on the home screen until the component unmounts.
- **Cross-domain dependency:** tenant-isolation-auditor, mobile-app-auditor.

### LOW-001 -- Employee Search Fetches All Active Employees Then Filters Client-Side

- **Stored source of truth:** Employee records in HR service database.
- **Read path:** `useSearchEmployees` in `web/modules/hr-module/src/hooks/useEmployees.ts` (lines 146-170). The GraphQL query `SEARCH_EMPLOYEES` (line 87-96 of `employee.operations.ts`) calls `activeEmployees(limit: $limit, page: $page)` and the hook client-side filters by `search.toLowerCase()` (lines 158-165). The `search` parameter is NOT sent to the backend.
- **Impact:** For tenants with many employees, every keystroke (after debounce) fetches the same full list from the server. The client-side filter means search results are limited to the first `limit` employees (default 10), so employees beyond that limit are never found. The same query key is used regardless of the search term (line 149: `employeeKeys.search(search)`), but `search` is not a GraphQL variable, so React Query correctly caches per search term but the server always returns the same data.
- **Cross-domain dependency:** list-visibility-auditor.

### LOW-002 -- Direct Reports Fetches All Employees Then Filters Client-Side

- **Stored source of truth:** Employee `supervisorId` field in HR service database.
- **Read path:** `useDirectReports` in `web/modules/hr-module/src/hooks/useEmployees.ts` (lines 217-233). Calls `activeEmployees(limit: 100)` then filters `(e) => e.supervisorId === supervisorId` on the client. No server-side filter by supervisor.
- **Impact:** Fetches up to 100 employees to find direct reports. With the default limit of 100, any employee beyond that threshold is invisible in the org tree. This is a partial readback -- the org tree silently truncates to the first 100 employees.
- **Cross-domain dependency:** list-visibility-auditor.

### LOW-003 -- Dashboard Metric Card Uses Wrong Trend Label

- **Stored source of truth:** Dashboard KPI data from `useDashboardStats()`.
- **Read path:** `DashboardPage.tsx` line 196-200: the "Aktif Kullanici" (Active Users) card passes `metrics.sensorsTrend` as its trend value and the label "gecen haftaya gore" (vs last week), but `sensorsTrend` represents the sensor activity percentage, not user activity trend. The card title says "Aktif Kullanici" but the trend percentage reflects sensor status.
- **Impact:** Misleading trend indicator on the main dashboard -- users see a percentage labeled "vs last week" that actually represents sensor online ratio. This is a data mapping error, not a missing field, so the stored truth is correct but is rendered under the wrong label.
- **Cross-domain dependency:** None.

## Summary

| Severity | Count | New | Recurring |
|----------|-------|-----|-----------|
| HIGH     | 3     | 2   | 1         |
| MEDIUM   | 4     | 2   | 1 (+1 newly discovered) |
| LOW      | 3     | 3   | 0         |
| **Total**| **10**|     |           |

### Critical Gap: Farm Module Core Pages

The most significant finding is HIGH-002: the three core farm management pages (list, detail, form) are entirely backed by hardcoded mock data despite real GraphQL hooks (`useSiteList`, `useSite`, `useCreateSite`, `useUpdateSite`) existing in `web/modules/farm-module/src/hooks/useSites.ts`. This represents a complete readback failure for the primary domain of the platform.

### Recommendations

1. **HIGH-002/HIGH-003 (Farm pages):** Replace mock data in `FarmDetailPage.tsx`, `FarmListPage.tsx`, and `FarmFormPage.tsx` with calls to the existing `useSiteList()`, `useSite()`, `useCreateSite()`, and `useUpdateSite()` hooks. Wire sensor data in the detail page to the sensor-module hooks.

2. **HIGH-001 (User edit preload):** Add `roleId` and `phoneNumber` to `TENANT_USERS_QUERY`. Either pass the raw `ApiUser` to the edit modal instead of `DisplayUser`, or create a separate detail-fetch hook for the edit path that returns the full editable record.

3. **MEDIUM-003 (Task cache):** Migrate `useMyTasks` from manual `useState`+`useRef` to `@tanstack/react-query` with a proper `queryKey`. Add `queryClient.invalidateQueries({ queryKey: ['myTasks'] })` to `useTaskActions` mutation callbacks.

4. **MEDIUM-001/MEDIUM-002 (Analytics):** Wire `analyticsApi.getUserActivity()` to the DAU chart. Remove the `Math.min(dataPoints, 30)` cap to allow full-resolution trends for 90d and 1y periods.

## Notes

- No runtime test execution was performed for this audit.
- The findings above are limited to readback fidelity and edit-preload contract gaps; unrelated code changes were not reviewed.
- All file paths are relative to repository root `/var/aqua-saas/`.
