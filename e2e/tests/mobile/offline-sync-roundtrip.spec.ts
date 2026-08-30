/**
 * AquaMobil offline record → sync roundtrip (MOB-HIGH-013 / guard for
 * MOB-MEDIUM-002).
 *
 * The core offline-first promise: a mortality recorded while OFFLINE must be
 * queued locally (visible to the worker as pending) and drained to the server
 * once connectivity returns — verified against SERVER truth (the batch's
 * totalMortality counter through the gateway), not client state.
 *
 * This spec intentionally lands BEFORE the SW closed-app replay fix
 * (MOB-MEDIUM-002): it passes via the foreground auto-sync lane and pins that
 * behavior so the service-worker replay work cannot regress the reopened-app
 * path it builds on.
 *
 * CLOSED-APP VARIANT — documented limitation: Playwright cannot fire a
 * Background Sync `sync` event into a service worker with zero window clients
 * (no CDP surface for SyncManager), so the SW replay lane is not browser-
 * drivable. It is guarded instead by its unit contract
 * (web/apps/aquamobil/src/pwa/__tests__/sw-replay.spec.ts — zero-client gate,
 * cookie refresh, tenant scoping, blob skip) plus the sw-build-artifact
 * invariant proving the replay code ships in dist/messaging-sw.js.
 */

import { test, expect } from '@playwright/test';

import { TestDatabase } from '../../helpers/db.helper';
import { GraphQLTestClient } from '../../helpers/graphql-client';

import {
  FIXTURE_PASSWORD,
  getBatchCounters,
  loginAsFieldWorker,
  seedFarmTankWithBatch,
  seedMobileWorker,
  type MobileWorkerSeed,
  type SeededFarmData,
} from './helpers/mobile-helpers';

let db: TestDatabase;
let seed: MobileWorkerSeed;
let farm: SeededFarmData;

test.describe('AquaMobil offline mortality roundtrip', () => {
  test.beforeAll(async ({ request }) => {
    db = new TestDatabase();
    await db.connect();
    seed = await seedMobileWorker(db);

    const client = new GraphQLTestClient(request);
    client.setToken(seed.adminApiToken);
    farm = await seedFarmTankWithBatch(client, seed.adminApiToken);
  });

  test.afterAll(async () => {
    await db.disconnect();
  });

  test('mortality recorded offline queues locally and reaches the server after reconnect', async ({
    page,
    context,
    request,
  }) => {
    const client = new GraphQLTestClient(request);
    client.setToken(seed.adminApiToken);
    const before = await getBatchCounters(client, seed.adminApiToken, farm.batchId);

    await loginAsFieldWorker(page, seed.user.email, FIXTURE_PASSWORD);

    // Deep-link straight to the mortality form for the seeded tank so the
    // spec exercises the record flow, not tank-list navigation.
    await page.goto(`/mortality/record/${farm.tankId}`);
    await expect(page.getByText('Record Mortality').first()).toBeVisible();
    // Tank/batch card resolves from farmStockInventory — wait for it so the
    // payload's batchId is populated before going offline.
    await expect(page.getByText('Mobile E2E Tank', { exact: false }).first()).toBeVisible();

    // ── Go offline BEFORE submitting ──────────────────────────────────────
    await context.setOffline(true);

    await page.getByRole('button', { name: /Review 1 Dead Fish/ }).click();
    await page.getByRole('button', { name: 'Confirm & Record' }).click();

    // The offline banner and/or the queued confirmation must tell the worker
    // the record is LOCAL, not synced — truthful offline UX.
    await expect(page.getByText(/offline|queued|will sync/i).first()).toBeVisible();

    // Server must NOT have the record yet.
    const whileOffline = await getBatchCounters(client, seed.adminApiToken, farm.batchId);
    expect(whileOffline.totalMortality).toBe(before.totalMortality);

    // ── Reconnect: the foreground auto-sync drains the queue ─────────────
    await context.setOffline(false);

    await expect
      .poll(
        async () => {
          const counters = await getBatchCounters(client, seed.adminApiToken, farm.batchId);
          return counters.totalMortality;
        },
        { timeout: 45_000, intervals: [1_000] },
      )
      .toBe(before.totalMortality + 1);

    const after = await getBatchCounters(client, seed.adminApiToken, farm.batchId);
    expect(after.currentQuantity).toBe(before.currentQuantity - 1);
  });
});
