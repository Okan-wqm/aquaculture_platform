# Data Readback Audit: `2026-04-11-full-platform-e2e`

Scope: persistence-to-UI readback across detail pages, list pages, summary widgets, dashboards, edit preload paths, and mobile read paths.

## Findings

- `high-001` Tenant user edit round-trip is incomplete, so existing user records cannot be faithfully reloaded and saved back.
  - Root cause: the edit modal expects `roleId` and `phoneNumber` in its preload state, but the tenant users list query does not return either field, and the save mutation path never sends `phoneNumber` back to the API.
  - Evidence: [`web/modules/tenant-admin/src/pages/TenantUsers.tsx`](/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx#L41-L59), [`web/modules/tenant-admin/src/pages/TenantUsers.tsx`](/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx#L141-L160), [`web/modules/tenant-admin/src/components/users/AddEditUserModal.tsx`](/var/aqua-saas/web/modules/tenant-admin/src/components/users/AddEditUserModal.tsx#L108-L118), [`web/modules/tenant-admin/src/components/users/AddEditUserModal.tsx`](/var/aqua-saas/web/modules/tenant-admin/src/components/users/AddEditUserModal.tsx#L312-L329), [`web/modules/tenant-admin/src/graphql/user-queries.ts`](/var/aqua-saas/web/modules/tenant-admin/src/graphql/user-queries.ts#L15-L28), [`web/modules/tenant-admin/src/lib/api.ts`](/var/aqua-saas/web/modules/tenant-admin/src/lib/api.ts#L163-L206).
  - Impact: editing an existing user can blank or misapply the role, and phone number edits are rendered but not persisted. This is a direct readback/writeback contract failure on a critical admin surface.
  - Cross-domain dependency: GraphQL schema contract, React modal preload state, and mutation payload composition.

- `medium-002` Tenant user search only runs against the current server page, so off-page matches are invisible and the empty state can be misleading.
  - Root cause: the page fetches one paginated slice from the server, then applies search only in-memory on that slice. The UI presents this as the user list search, but it is not a full-tenant search.
  - Evidence: [`web/modules/tenant-admin/src/pages/TenantUsers.tsx`](/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx#L110-L129), [`web/modules/tenant-admin/src/pages/TenantUsers.tsx`](/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx#L272-L283), [`web/modules/tenant-admin/src/hooks/useTenantData.ts`](/var/aqua-saas/web/modules/tenant-admin/src/hooks/useTenantData.ts#L163-L173), [`web/modules/tenant-admin/src/hooks/useTenantData.ts`](/var/aqua-saas/web/modules/tenant-admin/src/hooks/useTenantData.ts#L525-L543).
  - Impact: searching for a real user can return "No users found" even though the match exists on another page. That is a false-negative readback result on a list surface.
  - Cross-domain dependency: server pagination, client-side filtering, and table empty-state logic.

- `high-003` Analytics dashboard shows synthetic and truncated trend data as if it were real readback.
  - Root cause: the "Daily Active Users" chart is built by multiplying tenant growth data by `avgUsersPerTenant`, not by querying user activity. In the same flow, the selected period is capped at 30 points even when the UI offers 90d and 1y ranges.
  - Evidence: [`web/modules/admin-panel/src/services/api/analytics.ts`](/var/aqua-saas/web/modules/admin-panel/src/services/api/analytics.ts#L28-L29), [`web/modules/admin-panel/src/services/api/analytics.ts`](/var/aqua-saas/web/modules/admin-panel/src/services/api/analytics.ts#L65-L69), [`web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx`](/var/aqua-saas/web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx#L395-L403), [`web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx`](/var/aqua-saas/web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx#L433-L449), [`web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx`](/var/aqua-saas/web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx#L698-L710).
  - Impact: the dashboard can present a fabricated DAU curve and a partial window of the selected period, which undermines executive reporting and any decisioning based on that chart.
  - Cross-domain dependency: analytics API availability, dashboard aggregation code, and chart labeling.

- `medium-004` Mobile home task badge can stay stale after task mutations.
  - Root cause: `useMyTasks()` fetches only once per component lifetime via `hasFetchedRef`, and task mutations in `useTaskActions()` never invalidate or refetch the task query. The Home page then renders `todayTasks.length` directly from that cached slice.
  - Evidence: [`web/apps/aquamobil/src/hooks/useMyTasks.ts`](/var/aqua-saas/web/apps/aquamobil/src/hooks/useMyTasks.ts#L33-L79), [`web/apps/aquamobil/src/hooks/useTaskActions.ts`](/var/aqua-saas/web/apps/aquamobil/src/hooks/useTaskActions.ts#L11-L52), [`web/apps/aquamobil/src/pages/HomePage.tsx`](/var/aqua-saas/web/apps/aquamobil/src/pages/HomePage.tsx#L99-L113).
  - Impact: after completing or starting tasks elsewhere in the app, the home screen can keep showing the old pending count until a full remount or manual refetch, which is a stale readback on a primary mobile surface.
  - Cross-domain dependency: task mutation flow, local cache lifecycle, and the home dashboard count.

## Notes

- No runtime test execution was performed for this audit.
- The findings above are limited to readback fidelity and edit-preload contract gaps; unrelated code changes were not reverted.
