import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration for the messaging FAZ measurement lane
 * (e2e/messaging/ — see e2e/messaging/README.md for the full procedure).
 *
 * Follows the per-lane config precedent of playwright.aquamobil.config.ts /
 * playwright.water-chemistry.config.ts: an isolated testDir + project so the
 * measurement lane never drags in the gateway-HTTP security project, the
 * mobile lane or the Jest-run suites — and none of those lanes pick up the
 * measurement specs either (they skip unless MESSAGING_E2E_BASE_URL is set).
 *
 * Measurement-specific settings (do NOT relax for CI convenience):
 *   - retries: 0   — a retried measurement is invalid data, not a pass.
 *   - workers: 1   — parallel tabs skew send→visible latencies.
 *   - ignoreHTTPSErrors — the panel is served behind the gateway's 8443
 *     self-signed certificate.
 *
 * Environment variables:
 *   - MESSAGING_E2E_BASE_URL:      panel origin+base (default https://localhost:8443);
 *                                  unset ⇒ every messaging spec self-skips.
 *   - MESSAGING_E2E_STORAGE_STATE: shared auth state (login is rate-limited
 *                                  5/15min — ONE login per run, see README).
 */
export default defineConfig({
  testDir: './messaging',
  timeout: 120_000,
  expect: {
    timeout: 10_000,
  },
  retries: 0,
  workers: 1,
  // Keep Playwright artifacts out of e2e/messaging/ (that tree is the
  // measurement library; the results/ subdir is the only artifact sink).
  outputDir: './test-results/messaging',
  reporter: process.env.CI
    ? [['html', { open: 'never', outputFolder: 'playwright-report/messaging' }], ['github']]
    : [['html', { open: 'on-failure', outputFolder: 'playwright-report/messaging' }]],
  use: {
    baseURL: process.env['MESSAGING_E2E_BASE_URL'] ?? 'https://localhost:8443',
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'messaging-measure',
    },
  ],
});
