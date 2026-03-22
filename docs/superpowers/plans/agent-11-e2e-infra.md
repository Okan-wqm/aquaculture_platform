# Agent 11: E2E Infrastructure Architect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Set up Playwright + API test infrastructure with tenant fixtures, JWT helpers, DB seeding, and CI pipeline.

**Tech Stack:** Playwright, Node.js, PostgreSQL, jsonwebtoken, GitHub Actions

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Create | `e2e/playwright.config.ts` | Playwright configuration |
| Create | `e2e/package.json` | E2E test dependencies |
| Create | `e2e/tsconfig.json` | TypeScript config |
| Create | `e2e/helpers/jwt.helper.ts` | JWT token generation for tests |
| Create | `e2e/helpers/graphql-client.ts` | GraphQL test client with auth |
| Create | `e2e/helpers/rest-client.ts` | REST test client with auth |
| Create | `e2e/helpers/db.helper.ts` | Direct DB access for verification |
| Create | `e2e/fixtures/tenant.fixture.ts` | Tenant create/teardown factory |
| Create | `e2e/fixtures/user.fixture.ts` | User create/teardown factory |
| Create | `e2e/global-setup.ts` | Global test setup (DB seed) |
| Create | `e2e/global-teardown.ts` | Global test teardown (cleanup) |
| Create | `.github/workflows/e2e-tests.yml` | CI pipeline |

---

### Task 1: Project Setup

- [ ] **Step 1: Create e2e directory and package.json**
```json
{
  "name": "@aquaculture/e2e-tests",
  "private": true,
  "scripts": {
    "test:security": "playwright test --project=security",
    "test:workflow": "playwright test --project=workflow",
    "test:integration": "playwright test --project=integration",
    "test:all": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.42.0",
    "jsonwebtoken": "^9.0.0",
    "pg": "^8.11.0",
    "@types/jsonwebtoken": "^9.0.0",
    "@types/pg": "^8.10.0"
  }
}
```

- [ ] **Step 2: Create Playwright config**
```typescript
// e2e/playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  retries: 1,
  workers: 1, // Sequential for E2E — shared state
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:4200',
    extraHTTPHeaders: {
      'Accept': 'application/json',
    },
  },
  projects: [
    { name: 'security', testDir: './tests/security' },
    { name: 'workflow', testDir: './tests/workflow' },
    { name: 'integration', testDir: './tests/integration' },
  ],
});
```

- [ ] **Step 3: Commit**

### Task 2: JWT Helper

- [ ] **Step 1: Create JWT helper**
```typescript
// e2e/helpers/jwt.helper.ts
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-min-32-characters-long!!';

export interface TestTokenOptions {
  userId?: string;
  email?: string;
  role?: 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'MODULE_MANAGER' | 'MODULE_USER';
  tenantId?: string | null;
  modules?: string[];
  expiresIn?: string;
}

export function generateTestToken(options: TestTokenOptions = {}): string {
  const payload = {
    sub: options.userId || randomUUID(),
    email: options.email || 'test@example.com',
    role: options.role || 'TENANT_ADMIN',
    roles: [options.role || 'TENANT_ADMIN'],
    tenantId: options.tenantId ?? randomUUID(),
    modules: options.modules || ['farm', 'sensor'],
    jti: randomUUID(),
    aud: 'aquaculture-platform',
    iss: 'aquaculture-platform',
  };

  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: options.expiresIn || '1h',
  });
}

export function generateExpiredToken(options: TestTokenOptions = {}): string {
  return generateTestToken({ ...options, expiresIn: '-1s' });
}
```

- [ ] **Step 2: Commit**

### Task 3: GraphQL + REST Test Clients

- [ ] **Step 1: Create GraphQL client**
```typescript
// e2e/helpers/graphql-client.ts
import { request } from '@playwright/test';

export class GraphQLTestClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly tenantId?: string,
  ) {}

  async query<T = any>(query: string, variables?: Record<string, any>): Promise<T> {
    const context = await request.newContext();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.token}`,
    };
    if (this.tenantId) headers['X-Tenant-Id'] = this.tenantId;

    const response = await context.post(`${this.baseUrl}/graphql`, {
      data: { query, variables },
      headers,
    });
    const json = await response.json();
    await context.dispose();

    if (json.errors?.length) {
      const error = new Error(json.errors[0].message) as any;
      error.extensions = json.errors[0].extensions;
      error.statusCode = json.errors[0].extensions?.statusCode;
      throw error;
    }
    return json.data;
  }

  async mutate<T = any>(mutation: string, variables?: Record<string, any>): Promise<T> {
    return this.query<T>(mutation, variables);
  }
}
```

- [ ] **Step 2: Create REST client (similar pattern)**
- [ ] **Step 3: Commit**

### Task 4: Tenant + User Fixtures

- [ ] **Step 1: Create tenant fixture factory**
```typescript
// e2e/fixtures/tenant.fixture.ts
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function createTestTenant(overrides: Partial<any> = {}) {
  const id = randomUUID();
  const slug = `test-${id.substring(0, 8)}`;

  await pool.query(`
    INSERT INTO auth.tenants (id, name, slug, status, plan, "maxUsers", "userCount")
    VALUES ($1, $2, $3, 'ACTIVE', 'PROFESSIONAL', 100, 0)
  `, [id, overrides.name || `Test Tenant ${slug}`, slug]);

  return { id, slug, name: overrides.name || `Test Tenant ${slug}` };
}

export async function teardownTestTenant(tenantId: string) {
  const schemaName = `tenant_${tenantId.replace(/-/g, '').substring(0, 16)}`;
  await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await pool.query(`DELETE FROM auth.tenants WHERE id = $1`, [tenantId]);
}
```

- [ ] **Step 2: Create user fixture factory (similar)**
- [ ] **Step 3: Commit**

### Task 5: Global Setup/Teardown + CI Pipeline

- [ ] **Step 1: Create global setup**
- [ ] **Step 2: Create GitHub Actions workflow**
```yaml
# .github/workflows/e2e-tests.yml
name: E2E Tests
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  e2e:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_USER: aquaculture
          POSTGRES_PASSWORD: aquaculture
          POSTGRES_DB: aquaculture
        ports: ['5432:5432']
      redis:
        image: redis:7
        ports: ['6379:6379']
      nats:
        image: nats:2.10
        ports: ['4222:4222']

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run test:e2e
        env:
          DATABASE_URL: postgresql://aquaculture:aquaculture@localhost:5432/aquaculture
          REDIS_URL: redis://localhost:6379
          NATS_URL: nats://localhost:4222
          JWT_SECRET: test-secret-that-is-at-least-32-characters
```

- [ ] **Step 3: Commit**
