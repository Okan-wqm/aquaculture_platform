import { randomUUID } from 'crypto';

import { TestDatabase } from '../helpers/db.helper';

/**
 * Tenant status enum — mirrors auth-service TenantStatus.
 */
export type TestTenantStatus = 'ACTIVE' | 'SUSPENDED' | 'PENDING' | 'CANCELLED';

/**
 * Tenant plan enum — mirrors auth-service TenantPlan.
 */
export type TestTenantPlan = 'trial' | 'starter' | 'professional' | 'enterprise';

/**
 * Represents a test tenant created by the fixture.
 */
export interface TestTenant {
  id: string;
  name: string;
  slug: string;
  status: TestTenantStatus;
  plan: TestTenantPlan;
  maxUsers: number;
  contactEmail: string;
  schemaName: string;
}

/**
 * Options for creating a test tenant.
 * All fields optional — sensible defaults applied.
 */
export interface CreateTestTenantOptions {
  id?: string;
  name?: string;
  slug?: string;
  status?: TestTenantStatus;
  plan?: TestTenantPlan;
  maxUsers?: number;
  contactEmail?: string;
  /** Whether to create the tenant schema. Defaults to false (schema creation is a service responsibility). */
  createSchema?: boolean;
}

/**
 * Create a test tenant in auth.tenants.
 *
 * This inserts directly into the database, bypassing the GraphQL API.
 * Used for setting up test preconditions.
 *
 * @param db - TestDatabase instance
 * @param options - Tenant configuration overrides
 * @returns The created TestTenant
 */
export async function createTestTenant(
  db: TestDatabase,
  options?: CreateTestTenantOptions,
): Promise<TestTenant> {
  const id = options?.id ?? randomUUID();
  const name = options?.name ?? `E2E Test Tenant ${id.slice(0, 8)}`;
  const slug = options?.slug ?? `e2e-test-${id.slice(0, 8)}`;
  const status = options?.status ?? 'ACTIVE';
  const plan = options?.plan ?? 'professional';
  const maxUsers = options?.maxUsers ?? 50;
  const contactEmail = options?.contactEmail ?? `admin@${slug}.test.aquaculture.io`;

  const schemaName = db.getTenantSchemaName(id);

  await db.query(
    `INSERT INTO auth.tenants (
       id, name, slug, status, plan, "maxUsers", "contactEmail",
       "userCount", "farmCount", "sensorCount",
       "isTrialActive", "maxStorage", version
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, 0, false, -1, 1)`,
    [id, name, slug, status, plan, maxUsers, contactEmail],
  );

  // Optionally create the tenant schema
  if (options?.createSchema) {
    await db.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
  }

  return {
    id,
    name,
    slug,
    status,
    plan,
    maxUsers,
    contactEmail,
    schemaName,
  };
}

/**
 * Clean up a test tenant — remove users, drop schema, delete tenant record.
 *
 * Safe to call even if the tenant doesn't exist.
 *
 * @param db - TestDatabase instance
 * @param tenantId - The tenant ID to tear down
 */
export async function teardownTestTenant(db: TestDatabase, tenantId: string): Promise<void> {
  // Remove users first (FK constraint)
  await db.deleteTenantUsers(tenantId);

  // Drop schema + delete tenant record
  await db.deleteTenant(tenantId);
}

/**
 * Create multiple test tenants at once.
 *
 * @param db - TestDatabase instance
 * @param count - Number of tenants to create
 * @param baseOptions - Shared options (each tenant gets unique id/name/slug)
 * @returns Array of created TestTenant objects
 */
export async function createTestTenants(
  db: TestDatabase,
  count: number,
  baseOptions?: Omit<CreateTestTenantOptions, 'id' | 'name' | 'slug'>,
): Promise<TestTenant[]> {
  const tenants: TestTenant[] = [];
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    const tenant = await createTestTenant(db, {
      ...baseOptions,
      id,
      name: `E2E Tenant ${i + 1} (${id.slice(0, 8)})`,
      slug: `e2e-tenant-${i + 1}-${id.slice(0, 8)}`,
    });
    tenants.push(tenant);
  }
  return tenants;
}

/**
 * Tear down multiple test tenants.
 */
export async function teardownTestTenants(db: TestDatabase, tenantIds: string[]): Promise<void> {
  for (const tenantId of tenantIds) {
    await teardownTestTenant(db, tenantId);
  }
}
