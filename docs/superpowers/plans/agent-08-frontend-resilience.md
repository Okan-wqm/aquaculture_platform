# Agent 8: Frontend Resilience Architect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add error boundaries, server-side pagination, fix polling, remove dead code, deduplicate utilities, fix locale.

**Tech Stack:** React 18, TanStack Query, TypeScript

**Owned files:** `web/modules/tenant-admin/src/pages/`, `web/modules/tenant-admin/src/hooks/`

---

### Task 1: Wrap Routes with PageErrorBoundary

- [ ] **Step 1: Read Module.tsx and ErrorBoundary component**
- [ ] **Step 2: Import and wrap each Route**
```tsx
// In Module.tsx, wrap each route element:
<Route path="/tenant" element={<PageErrorBoundary><TenantDashboard /></PageErrorBoundary>} />
<Route path="/tenant/users" element={<PageErrorBoundary><TenantUsers /></PageErrorBoundary>} />
// ... for all 14 routes
```
- [ ] **Step 3: Commit**

### Task 2: Server-Side Pagination for TenantUsers

- [ ] **Step 1: Read TenantUsers.tsx — find disabled pagination buttons**
- [ ] **Step 2: Wire limit/offset to backend query**
```typescript
const [page, setPage] = useState(0);
const pageSize = 20;
const { data, isLoading } = useQuery({
  queryKey: ['tenantUsers', page, pageSize, filters],
  queryFn: () => apiClient.graphql(TENANT_USERS_QUERY, {
    limit: pageSize,
    offset: page * pageSize,
    status: filters.status,
    role: filters.role,
  }),
});
```
- [ ] **Step 3: Enable Previous/Next buttons**
- [ ] **Step 4: Update existing TenantUsers tests**
- [ ] **Step 5: Commit**

### Task 3: Refactor useDevicePolling

- [ ] **Step 1: Read useDevicePolling.ts**
- [ ] **Step 2: Replace setInterval with refetchInterval**
```typescript
export function useDevicePolling(deviceId: string | null, intervalMs = 5000) {
  return useQuery({
    queryKey: ['edgeDevice', deviceId],
    queryFn: () => apiClient.graphql(EDGE_DEVICE_QUERY, { id: deviceId }),
    enabled: !!deviceId,
    refetchInterval: intervalMs,
    refetchIntervalInBackground: false,
  });
}
```
- [ ] **Step 3: Remove manual setInterval/useRef/useState logic**
- [ ] **Step 4: Commit**

### Task 4: Remove Dead Standalone Layout Code

- [ ] **Step 1: Verify files are not imported anywhere**
```bash
grep -rn 'TenantAdminLayout\|TenantAdminHeader\|TenantAdminSidebar' web/modules/tenant-admin/src/ --include='*.tsx' --include='*.ts'
```
- [ ] **Step 2: Delete files**
Delete: `TenantAdminLayout.tsx` (166 lines), `TenantAdminHeader.tsx` (152 lines), `TenantAdminSidebar.tsx` (475 lines)
- [ ] **Step 3: Commit**

### Task 5: Extract Shared formatRelativeTime

- [ ] **Step 1: Find all duplicates**
- [ ] **Step 2: Create shared utility**
```typescript
// web/modules/tenant-admin/src/utils/date-utils.ts
export function formatRelativeTime(date: string | Date): string {
  const now = new Date();
  const then = new Date(date);
  const diffMs = now.getTime() - then.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(then);
}
```
- [ ] **Step 3: Replace all inline duplicates with import**
- [ ] **Step 4: Commit**

### Task 6: Fix Dashboard Mixed Fetch + Hard-Coded Locale

- [ ] **Step 1: Read TenantDashboard.tsx**
- [ ] **Step 2: Replace manual useState/useEffect/fetch with TanStack Query hooks**
- [ ] **Step 3: Replace all `'tr-TR'` with `undefined` (uses browser default) or user preference**
```typescript
// BEFORE:
date.toLocaleDateString('tr-TR')
// AFTER:
date.toLocaleDateString(undefined, { dateStyle: 'medium' })
```
- [ ] **Step 4: Apply locale fix across ALL pages** (search for `'tr-TR'`)
- [ ] **Step 5: Commit**

### Task 7: Discovery Pass
