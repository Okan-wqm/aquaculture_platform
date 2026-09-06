/** AquaMobil fixtures use persisted actors and real RS256 login. */

import { randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';

import { createTestTenant, type TestTenant } from '../../../fixtures/tenant.fixture';
import { createTestUser, createTenantAdmin, type TestUser } from '../../../fixtures/user.fixture';
import { TestDatabase } from '../../../helpers/db.helper';
import { GraphQLTestClient } from '../../../helpers/graphql-client';
import { FIXTURE_PASSWORD, loginFixtureUser } from '../../../helpers/real-auth.fixture';

export { FIXTURE_PASSWORD } from '../../../helpers/real-auth.fixture';


export interface MobileWorkerSeed {
  tenant: TestTenant;
  user: TestUser;
  /** Access token issued by login for this tenant's persisted admin. */
  adminApiToken: string;
}

/**
 * Seed a tenant + a mobile field worker (MODULE_MANAGER so harvest-tier flows
 * stay reachable) with the fixture password, plus a real admin login for
 * API-side seeding in the same tenant.
 */
export async function seedMobileWorker(db: TestDatabase): Promise<MobileWorkerSeed> {
  const tenant = await createTestTenant(db);
  const user = await createTestUser(db, {
    role: 'MODULE_MANAGER',
    tenantId: tenant.id,
  });
  const admin = await createTenantAdmin(db, tenant.id);
  const operationId = randomUUID();
  const job = await db.query<{ id: string }>(
    'SELECT platform.request_tenant_schema_provisioning($1, $2, $3) AS id',
    [operationId, tenant.id, tenant.schemaName],
  );
  const deadline = Date.now() + 120_000;
  for (;;) {
    const result = await db.query<{ status: string }>(
      'SELECT status FROM platform.tenant_schema_jobs WHERE id = $1', [job.rows[0].id],
    );
    const status = result.rows[0].status;
    if (status === 'COMMITTED') break;
    if (status === 'FAILED' || status === 'ABORTED' || Date.now() > deadline) {
      throw new Error(`Authoritative tenant provisioning failed: ${status}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  // Persist module assignments before obtaining the session that carries them.
  await db.query(`INSERT INTO auth.tenant_modules ("tenantId", "moduleId", "assignedBy")
    SELECT $1, id, $2 FROM auth.modules WHERE "isActive" = true`, [tenant.id, admin.id]);
  await db.query(`INSERT INTO auth.user_module_assignments
    ("userId", "moduleId", "tenantId", "assignedBy")
    SELECT $1, id, $2, $3 FROM auth.modules WHERE "isActive" = true`,
    [user.id, tenant.id, admin.id]);
  user.token = await loginFixtureUser(user.email, FIXTURE_PASSWORD);
  const adminApiToken = await loginFixtureUser(admin.email, FIXTURE_PASSWORD);
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
  await page.goto('/mobile/login');
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

  const site = await client.executeSuccess<{ createSite: { id: string } }>({ query: `mutation CreateSite($input: CreateSiteInput!) { createSite(input: $input) { id } }`, variables: { input: { name: `Mobile E2E Site ${stamp}`, code: `MES-${stamp.toString(36).toUpperCase()}` } }, token: adminToken });

  const department = await client.executeSuccess<{ createDepartment: { id: string } }>({ query: `mutation CreateDepartment($input: CreateDepartmentInput!) { createDepartment(input: $input) { id } }`, variables: {
      input: {
        siteId: site.createSite.id,
        name: `Mobile E2E Dept ${stamp}`,
        code: `MED-${stamp.toString(36).toUpperCase()}`,
        type: 'production',
      },
    }, token: adminToken });

  const tank = await client.executeSuccess<{ createTank: { id: string; name: string } }>({ query: `mutation CreateTank($input: CreateTankInput!) { createTank(input: $input) { id name } }`, variables: {
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
    }, token: adminToken });

  const species = await client.executeSuccess<{ createSpecies: { id: string } }>({ query: `mutation CreateSpecies($input: CreateSpeciesInput!) { createSpecies(input: $input) { id } }`, variables: {
      input: {
        commonName: `Mobile E2E Seabass ${stamp}`,
        scientificName: `Testus mobilis${stamp.toString(36)}`,
        code: `MSB-${stamp.toString(36).toUpperCase()}`,
        category: 'FISH',
        waterType: 'SALTWATER',
      },
    }, token: adminToken });

  const batch = await client.executeSuccess<{ createBatch: { id: string } }>({ query: `mutation CreateBatch($input: CreateBatchInput!) { createBatch(input: $input) { id } }`, variables: {
      input: {
        name: `Mobile E2E Batch ${stamp}`,
        speciesId: species.createSpecies.id,
        inputType: 'FRY',
        initialQuantity,
        initialWeight: { avgWeight: 5.0, totalBiomass: (initialQuantity * 5.0) / 1000 },
        stockedAt: new Date().toISOString().split('T')[0],
      },
    }, token: adminToken });

  await client.executeSuccess({ query: `mutation AllocateToTank($input: AllocateToTankInput!) {
      allocateBatchToTank(input: $input) { id currentQuantity }
    }`, variables: {
      input: {
        batchId: batch.createBatch.id,
        tankId: tank.createTank.id,
        quantity: initialQuantity,
        avgWeightG: 5.0,
        allocationType: 'INITIAL_STOCKING',
      },
    }, token: adminToken });

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
  const data = await client.executeSuccess<{ batch: BatchCounters }>({ query: `query Batch($id: ID!) { batch(id: $id) { currentQuantity totalMortality } }`, variables: { id: batchId }, token: adminToken });
  return data.batch;
}

/** Wait for a clone committed by the sole db-migrate provisioner. */
export async function ensureTenantTable(
  db: TestDatabase,
  schemaName: string,
  table: string,
  _provoke: () => Promise<unknown>,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await db.query<{ reg: string | null }>(
      `SELECT to_regclass($1)::text AS reg`,
      [`"${schemaName}"."${table}"`],
    );
    if (result.rows[0]?.reg) return;
    if (Date.now() > deadline) {
      throw new Error(`Tenant table ${schemaName}.${table} was never provisioned`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
}

/** Shared DB handle for mobile specs. */
export function createDb(): TestDatabase {
  return new TestDatabase();
}
