/**
 * Mobile record-form happy paths (MOB-HIGH-013).
 *
 * The offline-sync roundtrip spec already proves the queue lane on the
 * mortality form; this spec drives the RecordEntityPage scaffold ONLINE for a
 * second domain (cull) end-to-end — form → queue → ~1s auto-drain → server
 * counters — so a scaffold regression cannot hide behind the offline variant.
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

test.describe('AquaMobil record forms (online lane)', () => {
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

  test('an online cull record drains through the queue to the batch counters', async ({
    page,
    request,
  }) => {
    const client = new GraphQLTestClient(request);
    client.setToken(seed.adminApiToken);
    const before = await getBatchCounters(client, seed.adminApiToken, farm.batchId);

    await loginAsFieldWorker(page, seed.user.email, FIXTURE_PASSWORD);
    await page.goto(`/cull/record/${farm.tankId}`);

    await expect(page.getByText('Record Cull').first()).toBeVisible();
    await expect(page.getByText('Mobile E2E Tank', { exact: false }).first()).toBeVisible();

    await page.getByRole('button', { name: /Review/ }).click();
    await page.getByRole('button', { name: 'Confirm & Record' }).click();

    // Two-phase truthful UX: the badge reflects the real queue state.
    await expect(page.getByText(/Queued|Synced|Confirmed/i).first()).toBeVisible();

    // Online, the auto-sync drains within ~1s — assert SERVER truth.
    await expect
      .poll(
        async () =>
          (await getBatchCounters(client, seed.adminApiToken, farm.batchId)).currentQuantity,
        { timeout: 30_000, intervals: [1_000] },
      )
      .toBe(before.currentQuantity - 1);
  });
});
