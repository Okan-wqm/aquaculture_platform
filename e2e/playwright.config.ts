import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration for E2E security tests.
 * Uses API testing (no browser needed).
 */
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 0,
  workers: 1, // Serial execution for security tests to avoid rate-limit interference
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '../test-results/e2e-security' }],
  ],
  use: {
    baseURL: process.env['GATEWAY_URL'] || 'http://localhost:4000',
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
