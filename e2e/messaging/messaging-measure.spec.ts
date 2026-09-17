/**
 * Messaging FAZ measurement lane — SKELETON (FAZ 0; filled in by the phases).
 *
 * This spec NEVER runs in the default test filters:
 *   - it lives outside e2e/tests/, so no existing playwright config's
 *     testDir picks it up;
 *   - every test skips unless MESSAGING_E2E_BASE_URL is set (live stack
 *     required — see ./README.md for the full run procedure);
 *   - with the env set but no MESSAGING_E2E_STORAGE_STATE it STILL skips:
 *     login is rate-limited (5 attempts / 15 min per account), so the lane
 *     mandates a pre-provisioned storageState (auth.setup pattern — README).
 *
 * Tag: @messaging-measure (filter with `--grep @messaging-measure`).
 * Run manually (documented in README.md):
 *   cd e2e
 *   MESSAGING_E2E_BASE_URL=https://localhost:8443 \
 *   MESSAGING_E2E_STORAGE_STATE=../tmp/messaging-e2e-state.json \
 *   npx playwright test --config playwright.messaging.config.ts --grep @messaging-measure
 *
 * Current panel selectors referenced below (verify per phase):
 *   - channel item: button containing .sd-chan-title (ChannelListPage)
 *   - room route: /messaging/:channelId
 *   - composer: textarea[aria-label="Message"] (Enter sends)
 *   - send button: button[aria-label="Send"]
 */

import { test } from '@playwright/test';

import {
  assertNoBleed,
  assertP95WithinBudget,
  countGraphqlRequests,
  expectGraphqlErrorCode,
  measureSendToVisibleSeries,
  saveMeasurementEvidence,
  type LatencySummary,
} from './measurements';

const baseUrl = process.env['MESSAGING_E2E_BASE_URL'] ?? '';
const storageStatePath = process.env['MESSAGING_E2E_STORAGE_STATE'] ?? '';

test.skip(
  baseUrl === '',
  'MESSAGING_E2E_BASE_URL not set — the measurement lane needs the live stack (see e2e/messaging/README.md)',
);
test.skip(
  baseUrl !== '' && storageStatePath === '',
  'MESSAGING_E2E_STORAGE_STATE not set — login is rate-limited (5/15min); the lane requires a pre-provisioned storageState (auth.setup pattern in README.md)',
);

// The panel is served over the gateway's 8443 self-signed certificate.
test.use({ ignoreHTTPSErrors: true });
if (storageStatePath !== '') {
  test.use({ storageState: storageStatePath });
}

test.describe('Messaging FAZ measurements @messaging-measure', () => {
  // One authenticated browser context for the whole file: the storageState
  // is paid for once (login budget!), every test reuses it.
  test.describe.configure({ mode: 'serial' });

  test('p95 send→visible ≤ 1500ms (20 repetitions) @messaging-measure', async ({ page }) => {
    test.setTimeout(5 * 60_000);
    await page.goto(baseUrl);

    // TODO(FAZ-1): navigate to the measurement channel and wait for the room
    // to be fully loaded (messages hydrated) BEFORE starting the series —
    // otherwise the first repetitions absorb cold-start cost.
    //   await page.getByText('<measurement channel title>').click();
    //   await expect(page.getByLabel('Message')).toBeVisible();

    const summary: LatencySummary = await measureSendToVisibleSeries(page, (repetition) => {
      // Unique text per repetition is mandatory: waiting for a previous
      // message would silently measure 0ms.
      const text = `measure-send ${repetition} ${Date.now()}`;
      const composer = page.getByLabel('Message');
      const send = async () => {
        await composer.fill(text);
        await composer.press('Enter');
        // TODO(FAZ-1): confirm this locator targets ONLY the new message
        // bubble (e.g. a data-testid on the message container — add one if
        // getByText matches several nodes).
        return page.getByText(text, { exact: true });
      };
      return send();
    });

    saveMeasurementEvidence(`send-to-visible-${Date.now()}.json`, JSON.stringify(summary, null, 2));
    assertP95WithinBudget(summary, 1500);
  });

  test('channel switch fires no amplified GraphQL fan-out @messaging-measure', async ({ page }) => {
    await page.goto(baseUrl);

    const collector = countGraphqlRequests(page);

    // TODO(FAZ-2): perform exactly ONE channel switch and wait for the new
    // room to settle:
    //   await page.getByText('<target channel title>').click();
    //   await expect(page.getByText('<known message of target channel>')).toBeVisible();

    const snapshot = collector.snapshot();
    saveMeasurementEvidence(
      `channel-switch-requests-${Date.now()}.json`,
      JSON.stringify(snapshot, null, 2),
    );

    // TODO(FAZ-2): replace the placeholder gates with the phase thresholds:
    //   expect(snapshot.total).toBeLessThanOrEqual(<total /graphql budget>);
    //   expect(snapshot.messaging).toBeLessThanOrEqual(<messaging-op budget>);
    //   expect(snapshot.unparsed).toBe(0); // every op must be name-mappable
    collector.stop();
  });

  test('channel switch leaves zero pixels of the previous channel @messaging-measure', async ({
    page,
  }) => {
    await page.goto(baseUrl);

    // TODO(FAZ-2): open channel A, note a sample message text, then switch
    // to channel B and wait for its content:
    //   await page.getByText('<channel A title>').click();
    //   const bleedProbeText = await page.locator('.sd-msg-body').first().textContent();
    //   await page.getByText('<channel B title>').click();
    //   await expect(page.getByText('<channel B known message>')).toBeVisible();

    await assertNoBleed(page, '<previous channel title>', {
      // previousMessageText: bleedProbeText ?? undefined,
      // headerLocator: page.locator('<room header>'),
      evidenceName: `bleed-check-${Date.now()}`,
    });
  });

  test('negative paths keep the gateway error-code contract @messaging-measure', async () => {
    // Helper self-check (no live call): pins the contractual code set this
    // lane asserts with. TODO(FAZ-1): drive real negative paths through the
    // panel/gateway (deleted channel id → NOT_FOUND, expired session →
    // UNAUTHENTICATED, foreign-tenant channel → FORBIDDEN) and assert with:
    //   expectGraphqlErrorCode(response, 'NOT_FOUND');
    expectGraphqlErrorCode(
      { errors: [{ message: 'Channel not found', extensions: { code: 'NOT_FOUND' } }] },
      'NOT_FOUND',
    );
  });
});
