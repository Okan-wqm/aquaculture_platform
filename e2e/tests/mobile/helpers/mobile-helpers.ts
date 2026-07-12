/**
 * AquaMobil E2E helpers — seeding + real-UI login (MOB-HIGH-013).
 *
 * Browser flows CANNOT use the HS256 jwt.helper shortcut for the app session:
 * AquaMobil authenticates via the real `login` mutation (RS256 access token in
 * memory + httpOnly refresh cookie), so the only honest way in is the login
 * page itself. The HS256 test tokens are still used for SERVER-SIDE seeding
 * and assertions through the gateway (same convention as the module suites).
 */

import type { Page } from '@playwright/test';

import { createTestTenant, type TestTenant } from '../../../fixtures/tenant.fixture';
import { createTestUser, type TestUser } from '../../../fixtures/user.fixture';
import { TestDatabase } from '../../../helpers/db.helper';
import { GraphQLTestClient } from '../../../helpers/graphql-client';
import { generateTestToken } from '../../../helpers/jwt.helper';

/** Password matching user.fixture's DEFAULT_PASSWORD_HASH (bcrypt, 12 rounds). */
export const FIXTURE_PASSWORD = 'TestPassword123!';

export interface MobileWorkerSeed {
  tenant: TestTenant;
  user: TestUser;
  /** HS256 token for API-side seeding/assertions as this tenant's admin. */
  adminApiToken: string;
}

/**
 * Seed a tenant + a mobile field worker (MODULE_MANAGER so harvest-tier flows
 * stay reachable) with the fixture password, plus an HS256 admin token for
 * API-side seeding in the same tenant.
 */
export async function seedMobileWorker(db: TestDatabase): Promise<MobileWorkerSeed> {
  const tenant = await createTestTenant(db);
  const user = await createTestUser(db, {
    role: 'MODULE_MANAGER',
    tenantId: tenant.id,
  });
  const adminApiToken = generateTestToken({
    userId: user.id,
    email: user.email,
    role: 'TENANT_ADMIN',
    tenantId: tenant.id,
  });
  return { tenant, user, adminApiToken };
}

/**
 * Drive the real AquaMobil login page. Resolves once the authenticated shell
 * (bottom tab bar) is visible — i.e. token restore + mobile-access gate passed.
 */
export async function loginAsFieldWorker(
  page: Page,
  email: string,
  password: string = FIXTURE_PASSWORD,
): Promise<void> {
  await page.goto('/login');
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  // The bottom tab bar only renders inside the authenticated MobileLayout —
  // its Home tab appearing means login + mobile-access gate both passed.
  await page.getByText('Home', { exact: true }).first().waitFor({ timeout: 15_000 });
}

export interface SeededFarmData {
  siteId: string;
  departmentId: string;
  tankId: string;
  speciesId: string;
  batchId: string;
  initialQuantity: number;
}

/**
 * Seed the minimum farm graph a record form needs: site → department → tank →
 * species → batch → allocation. All through the gateway (never raw SQL into
 * the per-tenant schema) so farm-service provisions and owns its own tables.
 */
export async function seedFarmTankWithBatch(
  client: GraphQLTestClient,
  adminToken: string,
): Promise<SeededFarmData> {
  const stamp = Date.now();
  const initialQuantity = 5000;

  const site = await client.query<{ createSite: { id: string } }>(
    `mutation CreateSite($input: CreateSiteInput!) { createSite(input: $input) { id } }`,
    { input: { name: `Mobile E2E Site ${stamp}`, code: `MES-${stamp.toString(36).toUpperCase()}` } },
    { token: adminToken },
  );

  const department = await client.query<{ createDepartment: { id: string } }>(
    `mutation CreateDepartment($input: CreateDepartmentInput!) { createDepartment(input: $input) { id } }`,
    {
      input: {
        siteId: site.createSite.id,
        name: `Mobile E2E Dept ${stamp}`,
        code: `MED-${stamp.toString(36).toUpperCase()}`,
        type: 'production',
      },
    },
    { token: adminToken },
  );

  const tank = await client.query<{ createTank: { id: string; name: string } }>(
    `mutation CreateTank($input: CreateTankInput!) { createTank(input: $input) { id name } }`,
    {
      input: {
        name: `Mobile E2E Tank ${stamp}`,
        departmentId: department.createDepartment.id,
        tankType: 'circular',
        material: 'fiberglass',
        waterType: 'saltwater',
        diameter: 5.0,
        depth: 1.5,
        maxBiomass: 500.0,
        maxDensity: 30,
      },
    },
    { token: adminToken },
  );

  const species = await client.query<{ createSpecies: { id: string } }>(
    `mutation CreateSpecies($input: CreateSpeciesInput!) { createSpecies(input: $input) { id } }`,
    {
      input: {
        commonName: `Mobile E2E Seabass ${stamp}`,
        scientificName: `Testus mobilis${stamp.toString(36)}`,
        code: `MSB-${stamp.toString(36).toUpperCase()}`,
        category: 'FISH',
        waterType: 'SALTWATER',
      },
    },
    { token: adminToken },
  );

  const batch = await client.query<{ createBatch: { id: string } }>(
    `mutation CreateBatch($input: CreateBatchInput!) { createBatch(input: $input) { id } }`,
    {
      input: {
        name: `Mobile E2E Batch ${stamp}`,
        speciesId: species.createSpecies.id,
        inputType: 'FRY',
        initialQuantity,
        initialWeight: { avgWeight: 5.0, totalBiomass: (initialQuantity * 5.0) / 1000 },
        stockedAt: new Date().toISOString().split('T')[0],
      },
    },
    { token: adminToken },
  );

  await client.query(
    `mutation AllocateToTank($input: AllocateToTankInput!) {
      allocateBatchToTank(input: $input) { id currentQuantity }
    }`,
    {
      input: {
        batchId: batch.createBatch.id,
        tankId: tank.createTank.id,
        quantity: initialQuantity,
        avgWeightG: 5.0,
        allocationType: 'INITIAL_STOCKING',
      },
    },
    { token: adminToken },
  );

  return {
    siteId: site.createSite.id,
    departmentId: department.createDepartment.id,
    tankId: tank.createTank.id,
    speciesId: species.createSpecies.id,
    batchId: batch.createBatch.id,
    initialQuantity,
  };
}

export interface BatchCounters {
  currentQuantity: number;
  totalMortality: number;
}

/** Server-side truth for the roundtrip assertion. */
export async function getBatchCounters(
  client: GraphQLTestClient,
  adminToken: string,
  batchId: string,
): Promise<BatchCounters> {
  const data = await client.query<{ batch: BatchCounters }>(
    `query Batch($id: ID!) { batch(id: $id) { currentQuantity totalMortality } }`,
    { id: batchId },
    { token: adminToken },
  );
  return data.batch;
}

/** Shared DB handle for mobile specs. */
export function createDb(): TestDatabase {
  return new TestDatabase();
}
