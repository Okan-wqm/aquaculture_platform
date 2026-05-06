import * as crypto from 'crypto';

import { GraphQLTestClient } from './graphql-client';
import { generateSuperAdminToken, generateTenantAdminToken } from './jwt.helper';

/**
 * Test tenant fixture data
 */
export interface TestTenantFixture {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  adminUserId: string;
  adminToken: string;
  superAdminToken: string;
}

/**
 * Create a test tenant via the GraphQL API.
 *
 * Uses a SUPER_ADMIN token to create the tenant, then
 * returns fixture data including the tenant admin token.
 */
export async function createTestTenant(
  client: GraphQLTestClient,
  overrides?: {
    name?: string;
    slug?: string;
    contactEmail?: string;
  },
): Promise<TestTenantFixture> {
  const superAdminUserId = crypto.randomUUID();
  const superAdminToken = generateSuperAdminToken(superAdminUserId);
  client.setToken(superAdminToken);

  const tenantName = overrides?.name ?? `E2E Test Tenant ${Date.now()}`;
  const tenantSlug = overrides?.slug ?? `e2e-test-${Date.now()}`;
  const contactEmail = overrides?.contactEmail ?? `e2e-${Date.now()}@test.aquaculture.dev`;

  const createResult = await client.mutate<{
    createTenant: { id: string; name: string; slug: string };
  }>(
    `
    mutation CreateTenant($input: CreateTenantInput!) {
      createTenant(input: $input) {
        id
        name
        slug
      }
    }
    `,
    {
      input: {
        name: tenantName,
        slug: tenantSlug,
        contactEmail,
      },
    },
  );

  const tenantId = createResult.createTenant.id;
  const adminUserId = crypto.randomUUID();
  const adminToken = generateTenantAdminToken(tenantId, adminUserId);

  return {
    tenantId,
    tenantName: createResult.createTenant.name,
    tenantSlug: createResult.createTenant.slug,
    adminUserId,
    adminToken,
    superAdminToken,
  };
}

/**
 * Generate fixture data for a tenant without actually creating it.
 * Useful when the test itself will create the tenant or when
 * you just need tokens and IDs for stub-based testing.
 */
export function generateTenantFixture(tenantId?: string): TestTenantFixture {
  const id = tenantId ?? crypto.randomUUID();
  const adminUserId = crypto.randomUUID();

  return {
    tenantId: id,
    tenantName: `E2E Fixture Tenant ${Date.now()}`,
    tenantSlug: `e2e-fixture-${Date.now()}`,
    adminUserId,
    adminToken: generateTenantAdminToken(id, adminUserId),
    superAdminToken: generateSuperAdminToken(),
  };
}
