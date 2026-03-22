# Agent 7: Frontend API Architect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Consolidate dual API layers, centralize all GraphQL queries, deduplicate query variants, normalize import paths.

**Tech Stack:** React 18, TanStack Query, GraphQL, TypeScript

**Owned files:** `web/modules/tenant-admin/src/services/`

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Create | `web/modules/tenant-admin/src/services/api-client.ts` | Unified TenantApiClient |
| Create | `web/modules/tenant-admin/src/graphql/tenant-queries.ts` | Tenant query definitions |
| Create | `web/modules/tenant-admin/src/graphql/user-queries.ts` | User query definitions |
| Create | `web/modules/tenant-admin/src/graphql/role-queries.ts` | Role query definitions |
| Create | `web/modules/tenant-admin/src/graphql/module-queries.ts` | Module query definitions |
| Create | `web/modules/tenant-admin/src/graphql/device-queries.ts` | Device query definitions |
| Create | `web/modules/tenant-admin/src/graphql/billing-queries.ts` | Billing/audit/activity queries |
| Create | `web/modules/tenant-admin/src/graphql/index.ts` | Barrel export |
| Delete | `web/modules/tenant-admin/src/services/tenant-api.service.ts` | Replaced by api-client.ts |
| Delete | `web/modules/tenant-admin/src/services/tenantApi.ts` | Replaced by api-client.ts |
| Delete | `web/modules/tenant-admin/src/services/graphql-queries.ts` | Replaced by graphql/ directory |
| Modify | `web/modules/tenant-admin/src/services/index.ts` | Update exports |
| Modify | `web/modules/tenant-admin/src/pages/index.ts` | Export all 14 pages |
| Modify | All pages/hooks with inline queries | Import from graphql/ |

---

### Task 1: Create Unified TenantApiClient

- [ ] **Step 1: Read both existing API services**
Read: `web/modules/tenant-admin/src/services/tenant-api.service.ts`
Read: `web/modules/tenant-admin/src/services/tenantApi.ts`

- [ ] **Step 2: Create unified client**
```typescript
// web/modules/tenant-admin/src/services/api-client.ts
import { getAccessToken, getTenantId } from '@aquaculture/shared-ui';

class TenantApiClient {
  private async getHeaders(): Promise<Record<string, string>> {
    const token = await getAccessToken();
    const tenantId = getTenantId();
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
    };
  }

  async graphql<T>(query: string, variables?: Record<string, any>): Promise<T> {
    const headers = await this.getHeaders();
    const response = await fetch('/graphql', {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ query, variables }),
    });
    const json = await response.json();
    if (json.errors?.length) {
      throw new Error(json.errors[0].message);
    }
    return json.data;
  }

  async rest<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers = await this.getHeaders();
    const response = await fetch(path, {
      ...options,
      headers: { ...headers, ...options.headers },
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(error.message || `HTTP ${response.status}`);
    }
    return response.json();
  }
}

export const apiClient = new TenantApiClient();
```

- [ ] **Step 3: Commit**

### Task 2: Centralize All GraphQL Queries

- [ ] **Step 1: Extract all inline queries from pages/hooks into graphql/ directory**

Scan every file for GraphQL query/mutation strings. Move each to the appropriate domain file.

Key deduplication: `TENANT_USERS_QUERY` exists in 3 files — create ONE parameterized version:
```typescript
// web/modules/tenant-admin/src/graphql/user-queries.ts
export const TENANT_USERS_QUERY = `
  query TenantUsers($status: String, $role: String, $limit: Int, $offset: Int) {
    tenantUsers(status: $status, role: $role, limit: $limit, offset: $offset) {
      id
      email
      firstName
      lastName
      role
      isActive
      isEmailVerified
      createdAt
      lastLoginAt
    }
  }
`;
```

- [ ] **Step 2: Update all imports in pages/hooks to use centralized queries**
- [ ] **Step 3: Delete old service files**
- [ ] **Step 4: Fix barrel exports**

Update `pages/index.ts` to export all 14 pages.

- [ ] **Step 5: Normalize import paths — use only `@aquaculture/shared-ui`**

Search and replace `@platform/shared-ui` → `@aquaculture/shared-ui` across all tenant-admin files.

- [ ] **Step 6: Commit**
```bash
git commit -m "refactor(tenant-admin): consolidate API layer + centralize GraphQL queries"
```

### Task 3: Discovery Pass
- [ ] Scan for any remaining inline GraphQL strings
- [ ] Scan for any import of deleted files
- [ ] Log discoveries
