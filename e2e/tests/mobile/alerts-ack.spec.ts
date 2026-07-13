/**
 * Mobile alarm surface E2E (MOB-HIGH-006 / MOB-HIGH-013).
 *
 * Seeds an unacknowledged CRITICAL alert directly into the tenant's
 * alert_history (server truth), then drives the REAL mobile flow: the alerts
 * page lists it, the critical banner demands attention, and a one-tap
 * Acknowledge lands back in the database — the full field-worker loop.
 */

import { test, expect } from '@playwright/test';

import { TestDatabase } from '../../helpers/db.helper';

import {
  FIXTURE_PASSWORD,
  loginAsFieldWorker,
  seedMobileWorker,
  type MobileWorkerSeed,
} from './helpers/mobile-helpers';

let db: TestDatabase;
let seed: MobileWorkerSeed;
let alertId: string;

test.describe('AquaMobil alerts acknowledge roundtrip', () => {
  test.beforeAll(async () => {
    db = new TestDatabase();
    await db.connect();
    seed = await seedMobileWorker(db);

    // Seed an unacked CRITICAL alert into the tenant's alert_history clone.
    const schema = seed.tenant.schemaName;
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO "${schema}"."alert_history"
        ("rule_id", "rule_name", "tenant_id", "severity", "message", "triggering_data", "triggered_at")
       VALUES ($1, $2, $3, 'critical', $4, $5, NOW())
       RETURNING id`,
      [
        'e2e-rule-low-do',
        'Low dissolved oxygen',
        seed.tenant.id,
        'Dissolved oxygen critically low in Tank 3',
        JSON.stringify({ dissolvedOxygen: 2.1 }),
      ],
    );
    alertId = inserted.rows[0]?.id ?? '';
    expect(alertId).toBeTruthy();
  });

  test.afterAll(async () => {
    await db.disconnect();
  });

  test('a seeded critical alert surfaces on mobile and acknowledges back to the database', async ({ page }) => {
    await loginAsFieldWorker(page, seed.user.email, FIXTURE_PASSWORD);

    // The persistent critical banner tops the screen until a human acks.
    await expect(page.getByRole('alert').first()).toBeVisible();

    await page.goto('/alerts');
    await expect(page.getByText('Dissolved oxygen critically low in Tank 3')).toBeVisible();
    await expect(page.getByText('Critical').first()).toBeVisible();

    await page.getByRole('button', { name: 'Acknowledge' }).first().click();

    // Optimistic UI clears the needs-action list immediately…
    await expect(page.getByText('All alerts acknowledged')).toBeVisible({ timeout: 15_000 });

    // …and SERVER truth converges (the queue drains within ~1s online).
    await expect
      .poll(
        async () => {
          const result = await db.query<{ acknowledged: boolean; acknowledged_by: string | null }>(
            `SELECT "acknowledged", "acknowledged_by" FROM "${seed.tenant.schemaName}"."alert_history" WHERE id = $1`,
            [alertId],
          );
          return result.rows[0]?.acknowledged === true;
        },
        { timeout: 30_000, intervals: [1_000] },
      )
      .toBe(true);
  });
});
