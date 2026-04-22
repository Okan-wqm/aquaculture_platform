# Table Grid Auditor: `2026-04-13-full-platform-e2e`

**Prior cycle:** `2026-04-11-full-platform-e2e` found 3 findings (HIGH-001, MEDIUM-002, HIGH-003). Commit `79ce984f` claimed to fix 12 findings.

**Scope checked:** All table/grid/list surfaces in `web/shared-ui/**`, `web/modules/admin-panel/**`, `web/modules/hr-module/**`, `web/modules/tenant-admin/**`, `web/modules/farm-module/**`, `web/modules/sensor-module/**`, `web/apps/aquamobil/**`.

## Prior Findings -- Regression Check

### HIGH-001 (prior): Tenant user export button with no handler
**Status: STILL OPEN.** The Export button at `web/modules/tenant-admin/src/pages/TenantUsers.tsx` L227-L229 still renders `<button className="..."><Download ... /> Export</button>` with **no `onClick` handler**. The button is not disabled, not visually marked as inert, and has no export pipeline. The operator sees a fully-styled, enabled export affordance that does nothing when clicked.

### MEDIUM-002 (prior): Tenant user search only filters the current page slice
**Status: STILL OPEN.** `TenantUsers.tsx` L126-L129 still applies `filteredUsers = users.filter(...)` on the local page-slice returned by `useTenantUsersRaw({ limit: 20, offset })`. The `debouncedSearch` value is never sent to the backend query. Operators searching for users outside the current page will not find them.

### HIGH-003 (prior): Sort affordances are false on multiple paginated grid surfaces
**Status: PARTIALLY RESOLVED -- significant remnants remain.** The EmployeesListPage now passes `sortBy`/`sortOrder`/`onSort` to the HR `DataTable` component (L419-L421), and the local HR `DataTable` component (`web/modules/hr-module/src/components/common/DataTable.tsx`) renders sort icons correctly. However, the **sort state still never reaches the backend query** -- see new finding HIGH-001 below. The AuditLogPage and TenantManagementPage findings are analyzed separately below.

---

## New Findings

### HIGH-001: EmployeesListPage sort state never reaches the GraphQL query -- sort is purely cosmetic

**File:** `web/modules/hr-module/src/pages/employees/EmployeesListPage.tsx` L44-L45 (state), L204-L211 (handler), L419-L421 (passed to DataTable)
**File:** `web/modules/hr-module/src/hooks/useEmployees.ts` L87-L106 (query)
**File:** `web/modules/hr-module/src/graphql/employee.operations.ts` L23-L38 (GraphQL operation)

The EmployeesListPage keeps `sortBy` and `sortOrder` in local state and passes them to the local HR `DataTable` component. The `DataTable` component renders sort icons based on these props (L114-L121 in `DataTable.tsx`). However:

1. The `useEmployees` hook at L87 accepts `filter` and `pagination` but **does not accept any sort parameter**.
2. The GraphQL query `GET_EMPLOYEES` at L24 accepts `$filter: EmployeeFilterInput` and `$pagination: EmployeePaginationInput` -- **no sort variable**.
3. The local HR `DataTable` component (`DataTable.tsx`) accepts `sortBy`/`sortOrder`/`onSort` props but **does not sort the `data` array itself**. It only renders sort indicator icons. The data ordering is whatever the server returned.

Result: Clicking a sortable column header toggles the arrow icon, but the table row order does not change. The operator believes sorting occurred, but the data stays in server-default order.

Root cause: The sort contract is incomplete -- sort state exists in the page component but has no path to either the GraphQL query (server-side sort) or a local sort algorithm (client-side sort) in the DataTable component.

Cross-domain: `contract-parity-auditor` for the missing sort contract between UI and backend.

### HIGH-002: AuditLogPage columns are marked sortable but Table receives no sorting prop -- sort is fully inert

**File:** `web/modules/admin-panel/src/pages/AuditLogPage.tsx` L377-L436 (column definitions), L593-L598 (Table render)

Five columns (`createdAt`, `action`, `entityType`, `performedByEmail`, `severity`) are defined with `sortable: true` at L379, L392, L397, L409, L419. However, the `<Table>` component at L593-L598 is rendered as:

```tsx
<Table
  data={logs}
  columns={columns}
  keyExtractor={(log) => log.id}
  emptyMessage="No audit logs found"
/>
```

No `sorting` prop is passed. The shared `Table` component (`web/shared-ui/src/components/Table/Table.tsx` L279) requires a `sorting` prop to enable sort click handlers and visual indicators. Without it, `handleSort` at L337-L346 is never invoked because `sorting?.onChange` is undefined. The column headers may still show a neutral sort icon (L397-L401), but clicking them does nothing.

Root cause: The page defines sortable columns but never wires a sorting state or callback.

Cross-domain: `contract-parity-auditor` for the missing sort contract.

### HIGH-003: TenantManagementPage columns are marked sortable but Table receives no sorting prop -- sort is fully inert

**File:** `web/modules/admin-panel/src/pages/TenantManagementPage.tsx` L226-L326 (column definitions), L436-L441 (Table render)

Four columns (`name`, `tier`, `status`, `createdAt`) are defined with `sortable: true` at L249, L268, L275, L306. The `<Table>` at L436-L441 receives no `sorting` prop:

```tsx
<Table
  data={tenants}
  columns={columns}
  keyExtractor={(tenant) => tenant.id}
  emptyMessage="No tenants found"
/>
```

Additionally, the page does not maintain any sort state (`useState` for sortBy/sortOrder). The backend `tenantsApi.list()` at L73-L80 does not receive a sort parameter. Sort is advertised but completely inert.

Root cause: Same as HIGH-002 -- sortable column declarations with no wiring.

### HIGH-004: UserManagementPage columns are marked sortable but Table receives no sorting prop

**File:** `web/modules/admin-panel/src/pages/UserManagementPage.tsx` L373-L441 (column definitions), L559-L564 (Table render)

Five columns (`name`, `role`, `tenantName`, `isActive`, `lastLoginAt`) are declared `sortable: true` at L377, L388, L395, L403, L413. The `<Table>` at L559-L564 receives no `sorting` prop. No sort state exists in the component. The backend `usersApi.list()` at L96-L103 does not accept sort parameters. Sort affordances are fully false.

Root cause: Identical to HIGH-002 and HIGH-003.

### HIGH-005: FarmListPage columns are marked sortable but Table receives no sorting prop, and data is hardcoded mock

**File:** `web/modules/farm-module/src/pages/FarmListPage.tsx` L42-L87 (mock data), L112-L211 (columns), L282-L288 (Table render)

Six columns (`name`, `type`, `location`, `status`, `capacity`, `sensorCount`, `lastUpdated`) declare `sortable: true`. The `<Table>` at L282-L288 receives no `sorting` prop. The data source is a hardcoded `mockFarms` array (L42-L87), so there is no backend query at all. Search and type/status filters are applied client-side on the mock array at L101-L109.

The pagination prop at L286 is set to `{ current: 1, pageSize: 10, total: filteredFarms.length, onChange: () => {} }` -- the `onChange` is a no-op, making pagination non-functional even for mock data.

Root cause: Mock data with no sort wiring and inert pagination.

### MEDIUM-006: EmployeesListPage Export button is inert -- no onClick handler

**File:** `web/modules/hr-module/src/pages/employees/EmployeesListPage.tsx` L274-L277

```tsx
<button className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 ...">
  <Download className="h-4 w-4" />
  Export
</button>
```

The button has no `onClick` handler, no `disabled` attribute, and no visual indication that the feature is unavailable. The operator sees a fully enabled Export button that does nothing.

Cross-domain: `button-action-auditor` for inert click surface, `file-transfer-auditor` for missing export pipeline.

### MEDIUM-007: AttendancePage Export button is inert -- no onClick handler

**File:** `web/modules/hr-module/src/pages/AttendancePage.tsx` L274-L277

Same pattern as MEDIUM-006: an Export button with `<Download>` icon, no `onClick`, no disabled state. The attendance records DataTable at L336-L346 does not have export functionality.

### MEDIUM-008: CertificationDashboardPage Export button is inert -- no onClick handler

**File:** `web/modules/hr-module/src/pages/training/CertificationDashboardPage.tsx` L431-L434

Same pattern: Export button with no `onClick` handler. No export pipeline exists for certifications.

### MEDIUM-009: CertificationDashboardPage search is client-side on server-paginated data

**File:** `web/modules/hr-module/src/pages/training/CertificationDashboardPage.tsx` L404-L414

The certification list uses server-side pagination via `useAllCertifications(certFilter, pagination)` at L248-L251. The search filter at L405-L414 is applied client-side with `allCertifications.filter(...)`. Because `allCertifications` is only the current page slice (L252), search will only match certifications on the current page. Certifications on other pages are invisible to search.

Root cause: Search semantics applied after server pagination instead of being pushed into the query contract.

Cross-domain: `list-visibility-auditor` for page-offset visibility contract.

### MEDIUM-010: HR DataTable sort is display-only -- clicking sortable headers updates icons but never reorders data

**File:** `web/modules/hr-module/src/components/common/DataTable.tsx` L51-L296

The HR DataTable component accepts `sortBy`, `sortOrder`, and `onSort` props. When a sortable column header is clicked (L160), it calls `onSort?.(column.key)`. The `renderSortIcon` function (L114-L121) shows the correct icon based on `sortBy`/`sortOrder` state. However, the component **never sorts the `data` array**. It renders `data.map(...)` at L207 in the order received. Unlike the shared-ui `DataTable` component which has a `processedData` with client-side sort (L474-L493 in `web/shared-ui/src/components/DataTable/DataTable.tsx`), the HR DataTable does not sort at all.

This means every HR page using the HR DataTable with sortable columns (EmployeesListPage, LeavesPage, PayrollPage, CrewAssignmentsPage, OffshoreRotationsPage, CertificationDashboardPage, AttendancePage) has cosmetic-only sort. The `onSort` callback updates the parent component's state (changing the icon direction), but the row order never changes.

Root cause: The HR DataTable was written as a render-only wrapper without sort logic, and no caller compensates by sorting data before passing it in.

### MEDIUM-011: PayrollPage search is client-side on server-paginated data

**File:** `web/modules/hr-module/src/pages/PayrollPage.tsx` L534-L548

The payroll list uses server-side pagination via `usePayrolls(filter)` at L503. The client-side search at L534-L548 filters `displayData` (the current page slice) using `searchQuery`. Payroll records on other pages are invisible to search.

Root cause: Same pattern as MEDIUM-009 -- search after pagination.

### MEDIUM-012: OffshoreRotationsPage DataTable receives client-filtered activeRotations array but passes its length as total -- pagination is misleading

**File:** `web/modules/hr-module/src/pages/crew/OffshoreRotationsPage.tsx` L451-L461

```tsx
<DataTable
  data={activeRotations}
  columns={rotationColumns}
  ...
  total={activeRotations.length}
  page={pagination.page || 1}
  pageSize={pagination.limit || 20}
  onPageChange={handlePageChange}
/>
```

`activeRotations` is a client-side filter of the `rotations` array (L188). The DataTable does not internally slice the `data` array (per HR DataTable source at L207, it renders all rows in `data`). But `total` equals `activeRotations.length` and `onPageChange` updates `pagination.page`, which does nothing because the DataTable renders the full `activeRotations` array regardless. Pagination controls appear when `activeRotations.length > 20` but clicking them has no effect on what is displayed.

Root cause: DataTable pagination expects the caller to slice data, but the caller passes the full array.

### LOW-013: TenantManagementPage pagination is separate from Table -- pagination bar is custom HTML, not from the Table component

**File:** `web/modules/admin-panel/src/pages/TenantManagementPage.tsx` L436-L457

The shared `Table` component at L436-L441 receives no `pagination` prop. Pagination is implemented as custom HTML at L445-L457 separate from the table. This means the table's built-in "X-Y / Z records" display and page size selector are not available. The pagination does work functionally (changing `page` state triggers a new `fetchTenants` call), but the table and its pagination are disconnected components.

### LOW-014: TenantManagementPage selection uses inline checkboxes in column definitions, bypassing Table's built-in selection

**File:** `web/modules/admin-panel/src/pages/TenantManagementPage.tsx` L226-L245

Selection is implemented by rendering `<input type="checkbox">` elements inside the first column's `render` function, with a custom `selectedIds` Set state. The shared Table's `selectable`, `selectedRows`, and `onSelectionChange` props are not used. This works but duplicates selection logic and means the Table's `allSelected`/`someSelected` checkbox state management is bypassed.

### LOW-015: InvoicesPage fetches up to 100 records without server-side pagination

**File:** `web/modules/admin-panel/src/pages/InvoicesPage.tsx` L90-L94

```tsx
const data = await billingApi.getInvoices({
  status: statusFilter !== 'all' ? statusFilter : undefined,
  search: searchTerm || undefined,
  limit: 100,
});
```

The page fetches up to 100 invoices and renders them in a custom table without pagination. If a tenant has more than 100 invoices, records beyond the limit are silently dropped. No UI indication that results are truncated.

### MEDIUM-016: Shared DataTable CSV export only exports the current page when using server-side pagination

**File:** `web/shared-ui/src/components/DataTable/DataTable.tsx` L520-L550

The built-in CSV export at L521-L549 exports `processedData`, which is derived from the `data` prop (L474). When `serverSidePagination` is true, `data` contains only the current page. The exported CSV therefore contains only the visible page, not the full dataset. There is no UI disclosure that the export is page-scoped rather than full-dataset.

This affects any caller using the shared DataTable with `serverSidePagination` + `exportable` without providing a custom `onExport` handler.

Root cause: The export function operates on the local data array without fetching the full server-side dataset.

Cross-domain: `file-transfer-auditor` for the export scope contract.

### MEDIUM-017: CrewAssignmentsPage client-side pagination on enrichedAssignments -- page change does not affect the displayed table

**File:** `web/modules/hr-module/src/pages/crew/CrewAssignmentsPage.tsx` L252-L258

The page slices `enrichedAssignments` into `pagedAssignments` (L255-L258), but the comment at L249-L251 says "DataTable doesn't slice internally, so paginate client-side by slicing the array ourselves." However, the DataTable render is not visible in the read range. If the DataTable receives `pagedAssignments` as `data`, the pagination is functional. If it receives `enrichedAssignments`, the slicing at L255 is dead code.

Let me verify: The assignments tab DataTable is rendered with `data` set from the visible context. Given the BUG-008 comment and the `pagedAssignments` variable, this appears to be correctly wired. **Downgraded to informational -- verified client-side pagination is functional here.**

## Summary Table

| ID | Severity | Surface | Issue |
|----|----------|---------|-------|
| HIGH-001 | HIGH | EmployeesListPage | Sort state never reaches GraphQL -- cosmetic only |
| HIGH-002 | HIGH | AuditLogPage | Sortable columns but no `sorting` prop to Table |
| HIGH-003 | HIGH | TenantManagementPage | Sortable columns but no `sorting` prop to Table |
| HIGH-004 | HIGH | UserManagementPage | Sortable columns but no `sorting` prop to Table |
| HIGH-005 | HIGH | FarmListPage | Mock data, no sort wiring, inert pagination onChange |
| MEDIUM-006 | MEDIUM | EmployeesListPage | Export button inert (no onClick) |
| MEDIUM-007 | MEDIUM | AttendancePage | Export button inert (no onClick) |
| MEDIUM-008 | MEDIUM | CertificationDashboardPage | Export button inert (no onClick) |
| MEDIUM-009 | MEDIUM | CertificationDashboardPage | Search only filters current page slice |
| MEDIUM-010 | MEDIUM | HR DataTable component | Sort is display-only -- never reorders data |
| MEDIUM-011 | MEDIUM | PayrollPage | Search only filters current page slice |
| MEDIUM-012 | MEDIUM | OffshoreRotationsPage | Pagination controls are non-functional |
| LOW-013 | LOW | TenantManagementPage | Pagination separate from Table component |
| LOW-014 | LOW | TenantManagementPage | Selection bypasses Table's built-in selection |
| LOW-015 | LOW | InvoicesPage | 100-record limit with no pagination or truncation warning |
| MEDIUM-016 | MEDIUM | Shared DataTable | CSV export only exports current page under server-side pagination |
| MEDIUM-017 | INFO | CrewAssignmentsPage | Client-side pagination -- verified functional |

### Prior findings still open:
- **HIGH-001 (prior)** = TenantUsers export button inert -- still open
- **MEDIUM-002 (prior)** = TenantUsers search filters current page only -- still open

## Systemic Pattern

The dominant defect is **false sort affordance on paginated server-side data**. This affects at least 8 list surfaces across 3 modules (admin-panel, hr-module, farm-module). There are two root causes:

1. **Admin-panel pages** (AuditLog, TenantManagement, UserManagement): Use the shared `Table` component but never pass the `sorting` prop. The shared Table correctly requires `sorting.onChange` to enable sorting, so the sort headers are rendered but clicking them is inert.

2. **HR module pages** (Employees, Payroll, Attendance, Leaves, Certifications, Crew, Rotations): Use a local `DataTable` wrapper (`web/modules/hr-module/src/components/common/DataTable.tsx`) that accepts `sortBy`/`onSort` props but never sorts the data. Sort icons toggle correctly, but row order never changes. Additionally, the `useEmployees` GraphQL hook and the `GET_EMPLOYEES` query do not accept sort parameters, so even if client-side sort were added to the DataTable, server-side sort would still be missing for paginated datasets.

**Recommendation:** Either (a) push sort into the backend queries (`EmployeeSortInput` with field + direction) for server-side paginated data, or (b) add client-side sort to the HR DataTable component for datasets that are fully loaded client-side. For admin-panel pages, wire the `sorting` prop on the shared Table to either local state with a backend sort parameter or a client-side sort step.

The secondary pattern is **inert export buttons** across 4 surfaces (TenantUsers, EmployeesList, Attendance, Certifications). These are all styled, enabled buttons with no `onClick` handler.
