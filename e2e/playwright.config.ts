import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration for Aquaculture E2E tests.
 *
 * Projects:
 *   - security: Playwright-native HTTP/security tests.
 *
 * Node-style GraphQL/DB E2E suites use Jest via jest.config.ts. Keeping the
 * runner boundary explicit prevents Playwright from loading Jest globals.
 *
 * Environment variables:
 *   - GATEWAY_URL:   Gateway GraphQL endpoint (default: http://localhost:4000)
 *   - DATABASE_URL:  PostgreSQL connection string
 *   - HOSTED_E2E_ISOLATED: required for fixture writes
 */
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  retries: 0,
  workers: 1,
  reporter: process.env.CI
    ? [['html', { open: 'never' }], ['github']]
    : [['html', { open: 'on-failure' }]],
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  use: {
    baseURL: process.env.GATEWAY_URL || 'http://localhost:4000',
    ignoreHTTPSErrors: process.env.HOSTED_E2E_ISOLATED === 'true',
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
    },
  },
  projects: [
    {
      name: 'security',
      testDir: './tests/security',
    },
  ],
});
