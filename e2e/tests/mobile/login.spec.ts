/**
 * AquaMobil login E2E (MOB-HIGH-013 — first browser coverage for mobile).
 *
 * Drives the REAL login page against a seeded auth.users row: the full
 * RS256 access-token + httpOnly refresh-cookie flow, the mobile-access
 * fail-closed gate, and the authenticated shell render. No JWT shortcuts on
 * the browser side — this is exactly the path a field worker takes.
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

test.describe('AquaMobil login', () => {
  test.beforeAll(async () => {
    db = new TestDatabase();
    await db.connect();
    seed = await seedMobileWorker(db);
  });

  test.afterAll(async () => {
    await db.disconnect();
  });

  test('a seeded field worker logs in through the real form and lands on the dashboard', async ({ page }) => {
    await loginAsFieldWorker(page, seed.user.email, FIXTURE_PASSWORD);

    // Authenticated shell: bottom navigation with the core tabs.
    await expect(page.getByText('Home', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Account', { exact: true }).first()).toBeVisible();
  });

  test('a wrong password stays on the login page with a visible error', async ({ page }) => {
    await page.goto('/mobile/login');
    await page.locator('#login-email').fill(seed.user.email);
    await page.locator('#login-password').fill('WrongPassword123!');
    await page.getByRole('button', { name: 'Sign In' }).click();

    // Still on login (the email field remains), and some error text surfaced —
    // never a silent no-op.
    await expect(page.locator('#login-email')).toBeVisible();
    await expect(page.getByText(/invalid|failed|incorrect|credentials/i).first()).toBeVisible();
  });

  test('an unknown deep link renders the 404 page, not a silent bounce home (MOB-LOW-005)', async ({ page }) => {
    await loginAsFieldWorker(page, seed.user.email, FIXTURE_PASSWORD);

    await page.goto('/mobile/definitely/not/a/route');

    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back to Home' })).toBeVisible();
  });
});
