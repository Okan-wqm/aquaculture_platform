# Agent 14: E2E Integration Tests — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Write 7 cross-service integration tests verifying full request chains from frontend through gateway to services and database.

**Tech Stack:** Playwright Test, PostgreSQL, NATS, JWT

**Depends on:** Agent 11 (test infrastructure)

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Create | `e2e/tests/integration/mutation-chain.spec.ts` | Frontend → Gateway → Service → DB |
| Create | `e2e/tests/integration/token-lifecycle.spec.ts` | Login → access → refresh → logout |
| Create | `e2e/tests/integration/tenant-suspension.spec.ts` | Suspension cascade |
| Create | `e2e/tests/integration/schema-provisioning.spec.ts` | Full provisioning E2E |
| Create | `e2e/tests/integration/permission-propagation.spec.ts` | Role change → token refresh |
| Create | `e2e/tests/integration/provisioning-rollback.spec.ts` | Saga compensation verification |

---

### Task 1: Full Mutation Chain Test

```typescript
// e2e/tests/integration/mutation-chain.spec.ts
test('createTenantUser mutation flows through full stack', async () => {
  // 1. Send GraphQL mutation via gateway
  const data = await client.mutate(`
    mutation { createTenantUser(input: {
      email: "chain-test@example.com"
      firstName: "Chain"
      lastName: "Test"
    }) { id email } }
  `);
  const userId = data.createTenantUser.id;

  // 2. Verify user exists in auth.users table
  const dbResult = await db.query(
    'SELECT id, email, "tenantId", role FROM auth.users WHERE id = $1',
    [userId],
  );
  expect(dbResult.rows).toHaveLength(1);
  expect(dbResult.rows[0].email).toBe('chain-test@example.com');
  expect(dbResult.rows[0].tenantId).toBe(tenantId);

  // 3. Verify role assignment in tenant schema
  const schemaName = `tenant_${tenantId.replace(/-/g, '').substring(0, 16)}`;
  const roleResult = await db.query(
    `SELECT "userId", "roleId" FROM "${schemaName}"."user_role_assignments" WHERE "userId" = $1`,
    [userId],
  );
  expect(roleResult.rows).toHaveLength(1);

  // Cleanup
  await db.query('DELETE FROM auth.users WHERE id = $1', [userId]);
});
```

- [ ] **Step 1: Write test**
- [ ] **Step 2: Commit**

### Task 2: Token Lifecycle Test

```typescript
// e2e/tests/integration/token-lifecycle.spec.ts
test('Full token lifecycle: login → access → refresh → logout → blacklisted', async () => {
  // 1. Login to get access + refresh tokens
  const loginData = await restClient.post('/api/v1/auth/login', {
    email: testUser.email,
    password: testUser.password,
  });
  const { accessToken, refreshToken } = loginData;

  // 2. Use access token for a query
  const client = new GraphQLTestClient(url, accessToken, tenantId);
  const data = await client.query('{ myTenant { name } }');
  expect(data.myTenant.name).toBeTruthy();

  // 3. Refresh the token
  const refreshData = await restClient.post('/api/v1/auth/refresh', {}, {
    headers: { Cookie: `refresh_token=${refreshToken}` },
  });
  const newAccessToken = refreshData.accessToken;

  // 4. New token works
  const client2 = new GraphQLTestClient(url, newAccessToken, tenantId);
  await expect(client2.query('{ myTenant { name } }')).resolves.toBeTruthy();

  // 5. Logout
  await restClient.post('/api/v1/auth/logout', {}, {
    headers: { Authorization: `Bearer ${newAccessToken}` },
  });

  // 6. Old refresh token is blacklisted
  await expect(restClient.post('/api/v1/auth/refresh', {}, {
    headers: { Cookie: `refresh_token=${refreshToken}` },
  })).rejects.toThrow();
});
```

- [ ] **Step 1: Write test**
- [ ] **Step 2: Commit**

### Task 3: Tenant Suspension Cascade

```typescript
test('Suspended tenant APIs reject all requests', async () => {
  // 1. Create and provision test tenant
  const tenant = await createTestTenant();
  const adminToken = generateTestToken({ tenantId: tenant.id, role: 'TENANT_ADMIN' });

  // 2. Suspend tenant (as SUPER_ADMIN)
  const superToken = generateTestToken({ role: 'SUPER_ADMIN', tenantId: null });
  const superClient = new GraphQLTestClient(url, superToken);
  await superClient.mutate(`mutation { suspendTenant(id: "${tenant.id}") { status } }`);

  // 3. Tenant admin's requests should now be rejected
  const tenantClient = new GraphQLTestClient(url, adminToken, tenant.id);
  await expect(tenantClient.query('{ myTenant { name } }')).rejects.toThrow(/suspended/i);

  // Cleanup
  await teardownTestTenant(tenant.id);
});
```

- [ ] **Step 1: Write test**
- [ ] **Step 2: Commit**

### Task 4-6: Schema Provisioning + Permission Propagation + Rollback Tests

- [ ] Write schema provisioning E2E test
- [ ] Write permission propagation test (role change → token refresh → new permissions)
- [ ] Write provisioning rollback test (trigger failure → verify cleanup)
- [ ] Commit each
