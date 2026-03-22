# Agent 13: E2E Workflow Tests — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Write 11 end-to-end workflow tests covering all tenant admin business flows.

**Tech Stack:** Playwright Test, GraphQL, REST

**Depends on:** Agent 11 (test infrastructure)

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Create | `e2e/tests/workflow/dashboard.spec.ts` | Dashboard data verification |
| Create | `e2e/tests/workflow/user-crud.spec.ts` | Full user lifecycle |
| Create | `e2e/tests/workflow/role-management.spec.ts` | Role CRUD + assignment |
| Create | `e2e/tests/workflow/module-assignment.spec.ts` | Module manager flows |
| Create | `e2e/tests/workflow/tenant-settings.spec.ts` | Settings persistence |
| Create | `e2e/tests/workflow/audit-log.spec.ts` | Audit trail verification |
| Create | `e2e/tests/workflow/billing.spec.ts` | Billing data display |
| Create | `e2e/tests/workflow/messaging.spec.ts` | Messages + support |
| Create | `e2e/tests/workflow/database-explorer.spec.ts` | DB explorer functionality |

---

### Task 1: Dashboard Workflow

```typescript
// e2e/tests/workflow/dashboard.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Tenant Dashboard', () => {
  test('Dashboard loads with real statistics', async ({ request }) => {
    const response = await request.post('/graphql', {
      data: { query: '{ tenantStats { totalUsers activeUsers totalModules monthlyGrowthPercent activeSessions } }' },
      headers: authHeaders,
    });
    const data = await response.json();
    const stats = data.data.tenantStats;

    expect(stats.totalUsers).toBeGreaterThanOrEqual(0);
    expect(stats.monthlyGrowthPercent).not.toBe(15); // Was hardcoded as 15
    expect(stats.activeSessions).toBeGreaterThanOrEqual(0);
    expect(stats.activeSessions).not.toBe(stats.activeUsers); // Was equated
  });
});
```

- [ ] **Step 1: Write test**
- [ ] **Step 2: Commit**

### Task 2: User CRUD Workflow

```typescript
// e2e/tests/workflow/user-crud.spec.ts
test.describe('User CRUD', () => {
  let createdUserId: string;

  test('Create user', async () => {
    const data = await client.mutate(`
      mutation { createTenantUser(input: {
        email: "e2e-test@example.com"
        firstName: "E2E"
        lastName: "Test"
      }) { id email } }
    `);
    createdUserId = data.createTenantUser.id;
    expect(data.createTenantUser.email).toBe('e2e-test@example.com');
  });

  test('User appears in list', async () => {
    const data = await client.query('{ tenantUsers { id email } }');
    expect(data.tenantUsers.some((u: any) => u.id === createdUserId)).toBe(true);
  });

  test('Update user', async () => {
    const data = await client.mutate(`
      mutation { updateTenantUser(userId: "${createdUserId}", input: { firstName: "Updated" }) { firstName } }
    `);
    expect(data.updateTenantUser.firstName).toBe('Updated');
  });

  test('Deactivate user', async () => {
    await client.mutate(`mutation { deactivateTenantUser(userId: "${createdUserId}") { isActive } }`);
    // Verify in DB that user is inactive
    const dbResult = await db.query('SELECT "isActive" FROM auth.users WHERE id = $1', [createdUserId]);
    expect(dbResult.rows[0].isActive).toBe(false);
  });

  test('Deactivated user cannot login', async () => {
    const deactivatedToken = generateTestToken({ userId: createdUserId, tenantId });
    const deactivatedClient = new GraphQLTestClient(url, deactivatedToken, tenantId);
    // Token is valid but user is inactive — should be rejected
    await expect(deactivatedClient.query('{ myTenant { name } }')).rejects.toThrow();
  });
});
```

- [ ] **Step 1: Write test file**
- [ ] **Step 2: Commit**

### Task 3: Role Management Workflow

```typescript
// e2e/tests/workflow/role-management.spec.ts
test.describe('Role Management', () => {
  let roleId: string;

  test('Create custom role', async () => {
    const data = await client.mutate(`
      mutation { createTenantRole(input: {
        name: "E2E Test Role"
        level: 40
        permissions: { farm: { tanks: { view: true, create: true, edit: false, delete: false } } }
      }) { id name level } }
    `);
    roleId = data.createTenantRole.id;
    expect(data.createTenantRole.name).toBe('E2E Test Role');
  });

  test('Role appears in list', async () => {
    const data = await client.query('{ tenantRoles { id name } }');
    expect(data.tenantRoles.some((r: any) => r.id === roleId)).toBe(true);
  });

  test('Update role permissions', async () => {
    const data = await client.mutate(`
      mutation { updateTenantRole(roleId: "${roleId}", input: {
        permissions: { farm: { tanks: { view: true, create: true, edit: true, delete: false } } }
      }) { id } }
    `);
    expect(data.updateTenantRole.id).toBe(roleId);
  });

  test('Delete role (after removing assignments)', async () => {
    const data = await client.mutate(`mutation { deleteTenantRole(roleId: "${roleId}") { success } }`);
    expect(data.deleteTenantRole.success).toBe(true);
  });
});
```

- [ ] **Step 1: Write test file**
- [ ] **Step 2: Commit**

### Task 4-9: Remaining Workflow Tests

Write similar tests for:
- Module assignment (assign manager → verify → remove)
- Settings (update → re-query → verify persistence)
- Audit log (perform actions → query log → verify entries)
- Billing (query subscription → verify plan)
- Messaging (create thread → send message → verify)
- Database explorer (list tables → view schema → query data)

- [ ] **Step 1: Write all remaining test files**
- [ ] **Step 2: Commit each**
