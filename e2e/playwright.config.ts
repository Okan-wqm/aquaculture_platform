import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration for Aquaculture E2E tests.
 *
 * Projects:
 *   - security:    Authorization, authentication, tenant isolation tests
 *   - workflow:    Cross-service business workflow tests
 *   - integration: Service integration and data consistency tests
 *
 * Environment variables:
 *   - GATEWAY_URL:   Gateway GraphQL endpoint (default: http://localhost:4000)
 *   - DATABASE_URL:  PostgreSQL connection string
 *   - JWT_SECRET:    Shared secret for HS256 test tokens
 */
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [['html', { open: 'never' }], ['github']]
    : [['html', { open: 'on-failure' }]],
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  use: {
    baseURL: process.env.GATEWAY_URL || 'http://localhost:4000',
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
    },
  },
  projects: [
    {
      name: 'security',
      testDir: './tests/security',
    },
    {
      name: 'workflow',
      testDir: './tests/workflow',
    },
    {
      name: 'integration',
      testDir: './tests/integration',
    },
  ],
});
