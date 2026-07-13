import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for the AquaMobil PWA browser E2E lane
 * (MOB-HIGH-013 — mobile previously had ZERO browser-driven coverage).
 *
 * Follows the per-lane config precedent set by
 * playwright.water-chemistry.config.ts: an isolated testDir + project so the
 * mobile suite runs against a served AquaMobil instance without dragging in
 * the gateway-HTTP security project or the Jest-run module suites.
 *
 * Environment variables:
 *   - AQUAMOBIL_URL: served mobile app origin+base (default: Vite dev server
 *     at http://127.0.0.1:8090/mobile — its /graphql proxy must point at the
 *     same gateway the seed helpers talk to)
 *   - GATEWAY_URL:   gateway origin for server-side seeding/assertions
 *                    (default: http://localhost:4000)
 *   - DATABASE_URL:  Postgres for the tenant/user fixtures
 *   - JWT_SECRET:    HS256 secret for API-side seed tokens (jwt.helper)
 */
export default defineConfig({
  testDir: './tests/mobile',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [['html', { open: 'never' }], ['github']]
    : [['html', { open: 'on-failure' }]],
  use: {
    ...devices['Pixel 7'],
    baseURL: process.env.AQUAMOBIL_URL ?? 'http://127.0.0.1:8090/mobile',
    // Offline-first flows exercise the service worker; keep it enabled.
    serviceWorkers: 'allow',
  },
  projects: [
    {
      name: 'aquamobil-mobile',
    },
  ],
});
