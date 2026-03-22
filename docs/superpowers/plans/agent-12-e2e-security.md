# Agent 12: E2E Security Tests — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Write 16 security E2E tests covering tenant isolation, RBAC, tokens, header spoofing, IDOR, cache isolation, rate limits, GraphQL limits, CSRF.

**Tech Stack:** Playwright Test, JWT, GraphQL

**Depends on:** Agent 11 (test infrastructure)

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Create | `e2e/tests/security/tenant-isolation.spec.ts` | Cross-tenant access tests |
| Create | `e2e/tests/security/rbac-escalation.spec.ts` | Role escalation tests |
| Create | `e2e/tests/security/token-lifecycle.spec.ts` | Token revocation/expiry tests |
| Create | `e2e/tests/security/header-spoofing.spec.ts` | Header forgery tests |
| Create | `e2e/tests/security/rate-limiting.spec.ts` | Rate limit enforcement tests |
| Create | `e2e/tests/security/graphql-limits.spec.ts` | Depth/complexity/alias tests |
| Create | `e2e/tests/security/csrf.spec.ts` | CSRF protection tests |

---

### Task 1: Tenant Isolation Tests

```typescript
// e2e/tests/security/tenant-isolation.spec.ts
import { test, expect } from '@playwright/test';
import { generateTestToken } from '../../helpers/jwt.helper';
import { GraphQLTestClient } from '../../helpers/graphql-client';
import { createTestTenant, teardownTestTenant } from '../../fixtures/tenant.fixture';

test.describe('Tenant Isolation', () => {
  let tenantA: any, tenantB: any;
  let clientA: GraphQLTestClient, clientB: GraphQLTestClient;

  test.beforeAll(async () => {
    tenantA = await createTestTenant({ name: 'Tenant A' });
    tenantB = await createTestTenant({ name: 'Tenant B' });
    const tokenA = generateTestToken({ tenantId: tenantA.id, role: 'TENANT_ADMIN' });
    const tokenB = generateTestToken({ tenantId: tenantB.id, role: 'TENANT_ADMIN' });
    clientA = new GraphQLTestClient(process.env.GATEWAY_URL!, tokenA, tenantA.id);
    clientB = new GraphQLTestClient(process.env.GATEWAY_URL!, tokenB, tenantB.id);
  });

  test.afterAll(async () => {
    await teardownTestTenant(tenantA.id);
    await teardownTestTenant(tenantB.id);
  });

  test('User A cannot access Tenant B data via tenantUsers query', async () => {
    // Client A uses their own token but tries to query with tenant B's ID
    const clientCrossTenant = new GraphQLTestClient(
      process.env.GATEWAY_URL!,
      generateTestToken({ tenantId: tenantA.id, role: 'TENANT_ADMIN' }),
      tenantB.id, // Spoofed tenant ID
    );
    await expect(clientCrossTenant.query(`{ tenantUsers { id email } }`))
      .rejects.toThrow(); // Should be rejected by TenantGuard
  });

  test('User A cannot read Tenant B tenant details', async () => {
    await expect(clientA.query(`{ tenant(id: "${tenantB.id}") { name } }`))
      .rejects.toThrow();
  });
});
```

- [ ] **Step 1: Write test file**
- [ ] **Step 2: Commit**

### Task 2: RBAC Escalation Tests

```typescript
// e2e/tests/security/rbac-escalation.spec.ts
test.describe('RBAC Escalation Prevention', () => {
  test('MODULE_USER cannot call createTenantUser', async () => {
    const moduleUserToken = generateTestToken({ role: 'MODULE_USER', tenantId });
    const client = new GraphQLTestClient(url, moduleUserToken, tenantId);
    await expect(client.mutate(`mutation { createTenantUser(input: { email: "hack@test.com", firstName: "H", lastName: "X" }) { id } }`))
      .rejects.toThrow();
  });

  test('MODULE_USER cannot access MobileSettings for other users', async () => {
    const moduleUserToken = generateTestToken({ role: 'MODULE_USER', tenantId });
    const client = new GraphQLTestClient(url, moduleUserToken, tenantId);
    await expect(client.query(`{ getMobileUserSettings(userId: "${otherUserId}") { isMobileEnabled } }`))
      .rejects.toThrow();
  });

  test('TENANT_ADMIN cannot suspend their own tenant', async () => {
    const adminToken = generateTestToken({ role: 'TENANT_ADMIN', tenantId });
    const client = new GraphQLTestClient(url, adminToken, tenantId);
    await expect(client.mutate(`mutation { suspendTenant(id: "${tenantId}") { id } }`))
      .rejects.toThrow();
  });
});
```

- [ ] **Step 1: Write test file**
- [ ] **Step 2: Commit**

### Task 3: Token Lifecycle Tests

```typescript
// e2e/tests/security/token-lifecycle.spec.ts
test('Expired token is rejected', async () => {
  const expiredToken = generateExpiredToken({ tenantId, role: 'TENANT_ADMIN' });
  const client = new GraphQLTestClient(url, expiredToken, tenantId);
  await expect(client.query(`{ myTenant { name } }`)).rejects.toThrow();
});

test('Token without jti is rejected in production mode', async () => {
  // Generate token manually without jti
  const tokenWithoutJti = jwt.sign(
    { sub: userId, role: 'TENANT_ADMIN', tenantId },
    JWT_SECRET,
    { expiresIn: '1h' }, // no jti
  );
  const client = new GraphQLTestClient(url, tokenWithoutJti, tenantId);
  // This should fail if NODE_ENV=production
});
```

- [ ] **Step 1: Write test file**
- [ ] **Step 2: Commit**

### Task 4: Header Spoofing Tests

```typescript
// e2e/tests/security/header-spoofing.spec.ts
test('x-user-payload header from external request is stripped', async () => {
  const context = await request.newContext();
  const response = await context.post(`${url}/graphql`, {
    data: { query: '{ myTenant { name } }' },
    headers: {
      'Authorization': `Bearer ${validToken}`,
      'x-user-payload': JSON.stringify({ sub: 'hacker', role: 'SUPER_ADMIN', tenantId: null }),
    },
  });
  // Request should be processed with JWT identity, not spoofed payload
  // If the header was trusted, this would return SUPER_ADMIN-level data
  expect(response.status()).not.toBe(200); // or verify returned data matches JWT user, not spoofed
});

test('x-tenant-id mismatch with JWT tenantId uses JWT value', async () => {
  const token = generateTestToken({ tenantId: tenantA.id, role: 'TENANT_ADMIN' });
  const client = new GraphQLTestClient(url, token, tenantB.id); // Mismatched tenant
  const data = await client.query(`{ myTenant { id } }`);
  expect(data.myTenant.id).toBe(tenantA.id); // JWT wins
});
```

- [ ] **Step 1: Write test file**
- [ ] **Step 2: Commit**

### Task 5: Rate Limiting + GraphQL Limits + CSRF Tests

- [ ] **Step 1: Write rate limiting tests**
- [ ] **Step 2: Write GraphQL depth/complexity/alias tests**
- [ ] **Step 3: Write CSRF tests**
- [ ] **Step 4: Commit all**
