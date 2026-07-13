/**
 * Mobile messaging smoke (MOB-HIGH-013).
 *
 * The in-app chat replaces WhatsApp/Telegram for field crews (ADR-012) — this
 * smoke proves the mobile surface end-to-end: a channel created through the
 * gateway appears in the mobile channel list, a message sent from the mobile
 * composer renders in the room AND lands as a server row the rest of the crew
 * will receive.
 */

import { test, expect } from '@playwright/test';

import { TestDatabase } from '../../helpers/db.helper';
import { GraphQLTestClient } from '../../helpers/graphql-client';
import { generateTestToken } from '../../helpers/jwt.helper';

import {
  FIXTURE_PASSWORD,
  loginAsFieldWorker,
  seedMobileWorker,
  type MobileWorkerSeed,
} from './helpers/mobile-helpers';

let db: TestDatabase;
let seed: MobileWorkerSeed;
let channelId: string;

test.describe('AquaMobil messaging smoke', () => {
  test.beforeAll(async ({ request }) => {
    db = new TestDatabase();
    await db.connect();
    seed = await seedMobileWorker(db);

    // Create a GROUP channel AS the field worker (creator becomes a member).
    const workerToken = generateTestToken({
      userId: seed.user.id,
      email: seed.user.email,
      role: 'MODULE_MANAGER',
      tenantId: seed.tenant.id,
    });
    const client = new GraphQLTestClient(request);
    const created = await client.query<{ createChannel: { id: string } }>(
      `mutation CreateChannel($input: CreateChannelInput!) {
        createChannel(input: $input) { id }
      }`,
      { input: { type: 'GROUP', name: 'Mobile E2E Crew' } },
      { token: workerToken },
    );
    channelId = created.createChannel.id;
  });

  test.afterAll(async () => {
    await db.disconnect();
  });

  test('the crew channel lists on mobile and a sent message reaches the server', async ({ page }) => {
    await loginAsFieldWorker(page, seed.user.email, FIXTURE_PASSWORD);

    await page.goto('/messages');
    await expect(page.getByText('Mobile E2E Crew')).toBeVisible({ timeout: 15_000 });
    await page.getByText('Mobile E2E Crew').click();

    const composer = page.getByPlaceholder(/message/i).first();
    await composer.fill('Feeding done on tank 3 — heading to tank 4.');
    await composer.press('Enter');

    // Rendered in the room…
    await expect(page.getByText('Feeding done on tank 3 — heading to tank 4.')).toBeVisible({
      timeout: 15_000,
    });

    // …and durably on the server (tenant messaging schema clone).
    await expect
      .poll(
        async () => {
          const result = await db.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count
             FROM "${seed.tenant.schemaName}"."messages"
             WHERE "channelId" = $1 AND "content" LIKE 'Feeding done on tank 3%'`,
            [channelId],
          );
          return Number(result.rows[0]?.count ?? '0');
        },
        { timeout: 30_000, intervals: [1_000] },
      )
      .toBeGreaterThan(0);
  });
});
