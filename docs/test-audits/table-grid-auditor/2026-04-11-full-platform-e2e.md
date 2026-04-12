# Table Grid Auditor: `2026-04-11-full-platform-e2e`

Scope checked: shared grid components in `web/shared-ui/**`, tenant-admin tables and list surfaces in `web/modules/tenant-admin/**`, admin-panel list surfaces in `web/modules/admin-panel/**`, HR list surfaces in `web/modules/hr-module/**`, and the table/list call sites needed to verify sort, filter, pagination, selection, and export truth.

## Findings

### HIGH-001: Tenant user export is rendered as a live action but has no export path
`[TenantUsers.tsx](/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx#L223)` renders an `Export` button with a download icon at `[L227-L230](/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx#L227)`, but the element has no `onClick`, no export handler, and no downstream file-generation flow anywhere else in the page. The user-facing grid therefore advertises exportability without actually exporting the current list, filtered rows, or visible columns.

Root cause:
- The export affordance was added at the page header level, but the page never connected it to a row scope, filter scope, or download pipeline.
- The rest of the page only supports read/query, modal edits, and bulk deactivate; there is no export contract to reconcile against the table state.

Cross-domain dependency:
- `button-action-auditor` for the inert-click surface.
- `file-transfer-auditor` for the missing row/file export pipeline.

### MEDIUM-002: Tenant user search only filters the current page slice, not the full tenant dataset
`[TenantUsers.tsx](/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx#L111)` fetches only one page at a time through `useTenantUsersRaw({ limit, offset, status, role })` at `[L115-L120](/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx#L115)`, then applies `filteredUsers = users.filter(...)` locally at `[L125-L129](/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx#L125)`. That means the search box can only match records already present in the current offset slice, so a tenant user on another page is invisible to search until the operator manually pages into the right slice.

Root cause:
- Search semantics are implemented after server pagination instead of being pushed into the query contract.
- The UI labels the control as tenant-wide user search, but the code only searches the page-local `rawUsers` array.

Cross-domain dependency:
- `list-visibility-auditor` for the page-offset visibility contract.
- `data-readback-auditor` for the server/query semantics behind the slice.

### HIGH-003: Sort affordances are false on multiple paginated grid surfaces because sort state never reaches the data contract
The shared `[Table.tsx](/var/aqua-saas/web/shared-ui/src/components/Table/Table.tsx#L279)` and `[DataTable.tsx](/var/aqua-saas/web/shared-ui/src/components/DataTable/DataTable.tsx#L387)` components only change row order when a caller supplies sort state and a handler; they do not sort paginated data on their own. That contract is broken on multiple real list surfaces:

- `[EmployeesListPage.tsx](/var/aqua-saas/web/modules/hr-module/src/pages/employees/EmployeesListPage.tsx#L44)` keeps `sortBy` / `sortOrder` in local state, but `[useEmployees.ts](/var/aqua-saas/web/modules/hr-module/src/hooks/useEmployees.ts#L87)` only accepts `filter` and `pagination`, and the query variables at `[L95-L105](/var/aqua-saas/web/modules/hr-module/src/hooks/useEmployees.ts#L95)` never receive sort fields. The header state changes at `[EmployeesListPage.tsx#L204-L211](/var/aqua-saas/web/modules/hr-module/src/pages/employees/EmployeesListPage.tsx#L204)` and is passed to the table at `[L409-L421](/var/aqua-saas/web/modules/hr-module/src/pages/employees/EmployeesListPage.tsx#L409)`, but the backend page order never changes.
- `[AuditLogPage.tsx](/var/aqua-saas/web/modules/admin-panel/src/pages/AuditLogPage.tsx#L377)` marks `createdAt`, `action`, `entityType`, `performedByEmail`, and `severity` as sortable, but the rendered `[Table](/var/aqua-saas/web/modules/admin-panel/src/pages/AuditLogPage.tsx#L593)` receives no `sorting` prop at all, so the sort affordance is inert.
- `[TenantManagementPage.tsx](/var/aqua-saas/web/modules/admin-panel/src/pages/TenantManagementPage.tsx#L226)` marks tenant `name`, `tier`, `status`, and `createdAt` sortable, but the rendered `[Table](/var/aqua-saas/web/modules/admin-panel/src/pages/TenantManagementPage.tsx#L436)` also receives no `sorting` prop or backend sort contract.

Root cause:
- Several list pages expose sortable headers without wiring the sort to either a backend query argument or a client-side reorder step.
- The UI therefore changes the arrow/icon state at best, while the actual row order stays whatever the API returned.

Cross-domain dependency:
- `data-readback-auditor` for paginated read-model truth.
- `list-visibility-auditor` for post-filter/post-sort visible-state drift.
- `contract-parity-auditor` for the missing sort contract between UI and query layer.

## Result

No CRITICAL defects were confirmed in this pass. The most important problems are the inert export affordance on tenant users, the page-local search scope, and the repeated false-sort contract on paginated list surfaces.
