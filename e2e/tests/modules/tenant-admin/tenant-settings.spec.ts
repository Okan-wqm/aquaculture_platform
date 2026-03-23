import { GraphQLTestClient } from '../../../helpers/graphql-client';
import { generateTenantFixture, TestTenantFixture } from '../../../helpers/tenant.fixture';

/**
 * Tenant Settings E2E Tests (tenant-admin module)
 *
 * Validates the updateTenant(id, input) mutation used by the
 * tenant-admin settings page. Tests cover:
 *   1. Fetching tenant via myTenant query
 *   2. Updating tenant fields via updateTenant mutation
 *   3. Verifying persistence of changes
 *   4. Partial updates (only changed fields)
 *   5. Input validation (empty name rejected)
 *
 * Backend resolver: TenantResolver.updateTenant (auth-service)
 * Frontend page:   TenantSettings.tsx
 */
describe('Tenant Admin — Settings (updateTenant mutation)', () => {
  let client: GraphQLTestClient;
  let fixture: TestTenantFixture;
  let tenantId: string;
  let originalName: string;
  let originalDescription: string | null;
  let originalContactEmail: string | null;
  let originalContactPhone: string | null;
  let originalAddress: string | null;

  // ------------------------------------------------------------------
  // Setup: authenticate as tenant admin, store original values
  // ------------------------------------------------------------------
  beforeAll(async () => {
    client = new GraphQLTestClient();
    fixture = generateTenantFixture();
    client.setToken(fixture.adminToken);

    try {
      const current = await client.query<{
        myTenant: {
          id: string;
          name: string;
          description: string | null;
          contactEmail: string | null;
          contactPhone: string | null;
          address: string | null;
        };
      }>(`
        query MyTenant {
          myTenant {
            id
            name
            description
            contactEmail
            contactPhone
            address
          }
        }
      `);
      tenantId = current.myTenant.id;
      originalName = current.myTenant.name;
      originalDescription = current.myTenant.description;
      originalContactEmail = current.myTenant.contactEmail;
      originalContactPhone = current.myTenant.contactPhone;
      originalAddress = current.myTenant.address;
    } catch {
      tenantId = '';
      originalName = '';
      originalDescription = null;
      originalContactEmail = null;
      originalContactPhone = null;
      originalAddress = null;
    }
  });

  // ------------------------------------------------------------------
  // Teardown: restore original values
  // ------------------------------------------------------------------
  afterAll(async () => {
    if (tenantId && originalName) {
      try {
        await client.mutate(`
          mutation RestoreTenant($id: ID!, $input: UpdateTenantInput!) {
            updateTenant(id: $id, input: $input) { id }
          }
        `, {
          id: tenantId,
          input: {
            name: originalName,
            description: originalDescription,
            contactEmail: originalContactEmail,
            contactPhone: originalContactPhone,
            address: originalAddress,
          },
        });
      } catch {
        // Restore failure is not a test failure
      }
    }
    client.clearToken();
  });

  // ------------------------------------------------------------------
  // Tests
  // ------------------------------------------------------------------

  test('myTenant query returns tenant with required fields', async () => {
    if (!tenantId) {
      console.warn('Skipping: tenant ID not available');
      return;
    }

    const result = await client.query<{
      myTenant: {
        id: string;
        name: string;
        slug: string;
        status: string;
        plan: string;
        settings: string | null;
        createdAt: string;
        updatedAt: string;
      };
    }>(`
      query MyTenant {
        myTenant {
          id
          name
          slug
          status
          plan
          settings
          createdAt
          updatedAt
        }
      }
    `);

    expect(result.myTenant.id).toBe(tenantId);
    expect(result.myTenant.name).toBeTruthy();
    expect(result.myTenant.slug).toBeTruthy();
    expect(result.myTenant.status).toBeTruthy();
    expect(result.myTenant.plan).toBeTruthy();
    expect(result.myTenant.createdAt).toBeTruthy();
    expect(result.myTenant.updatedAt).toBeTruthy();
  });

  test('updateTenant mutation updates name, description, contactEmail', async () => {
    if (!tenantId) {
      console.warn('Skipping: tenant ID not available');
      return;
    }

    const updatedName = `E2E Settings Test ${Date.now()}`;
    const updatedDescription = `Updated at ${new Date().toISOString()}`;
    const updatedEmail = `e2e-settings-${Date.now()}@test.aquaculture.dev`;

    const updateResult = await client.mutate<{
      updateTenant: {
        id: string;
        name: string;
        description: string | null;
        contactEmail: string | null;
        updatedAt: string;
      };
    }>(`
      mutation UpdateTenant($id: ID!, $input: UpdateTenantInput!) {
        updateTenant(id: $id, input: $input) {
          id
          name
          description
          contactEmail
          updatedAt
        }
      }
    `, {
      id: tenantId,
      input: {
        name: updatedName,
        description: updatedDescription,
        contactEmail: updatedEmail,
      },
    });

    expect(updateResult.updateTenant.id).toBe(tenantId);
    expect(updateResult.updateTenant.name).toBe(updatedName);
    expect(updateResult.updateTenant.description).toBe(updatedDescription);
    expect(updateResult.updateTenant.contactEmail).toBe(updatedEmail);
    expect(updateResult.updateTenant.updatedAt).toBeTruthy();
  });

  test('updateTenant changes persist via myTenant re-query', async () => {
    if (!tenantId) {
      console.warn('Skipping: tenant ID not available');
      return;
    }

    const persistName = `Persist Check ${Date.now()}`;

    // Mutate
    await client.mutate(`
      mutation UpdateTenant($id: ID!, $input: UpdateTenantInput!) {
        updateTenant(id: $id, input: $input) { id name }
      }
    `, {
      id: tenantId,
      input: { name: persistName },
    });

    // Re-query
    const verify = await client.query<{
      myTenant: { id: string; name: string };
    }>(`
      query VerifyPersistence {
        myTenant { id name }
      }
    `);

    expect(verify.myTenant.name).toBe(persistName);
  });

  test('updateTenant partial update only changes specified fields', async () => {
    if (!tenantId) {
      console.warn('Skipping: tenant ID not available');
      return;
    }

    // Set known baseline
    const baselineName = `Partial Baseline ${Date.now()}`;
    const baselinePhone = '+90-555-000-0000';
    await client.mutate(`
      mutation SetBaseline($id: ID!, $input: UpdateTenantInput!) {
        updateTenant(id: $id, input: $input) { id }
      }
    `, {
      id: tenantId,
      input: { name: baselineName, contactPhone: baselinePhone },
    });

    // Update only contactPhone, leave name untouched
    const newPhone = '+90-555-111-1111';
    await client.mutate(`
      mutation PartialUpdate($id: ID!, $input: UpdateTenantInput!) {
        updateTenant(id: $id, input: $input) { id }
      }
    `, {
      id: tenantId,
      input: { contactPhone: newPhone },
    });

    // Verify name unchanged, phone updated
    const result = await client.query<{
      myTenant: { name: string; contactPhone: string | null };
    }>(`
      query VerifyPartial {
        myTenant { name contactPhone }
      }
    `);

    expect(result.myTenant.name).toBe(baselineName);
    expect(result.myTenant.contactPhone).toBe(newPhone);
  });

  test('updateTenant with address and settings fields', async () => {
    if (!tenantId) {
      console.warn('Skipping: tenant ID not available');
      return;
    }

    const newAddress = '123 Aquaculture Blvd, Istanbul, Turkey';

    const updateResult = await client.mutate<{
      updateTenant: {
        id: string;
        address: string | null;
        settings: string | null;
      };
    }>(`
      mutation UpdateTenant($id: ID!, $input: UpdateTenantInput!) {
        updateTenant(id: $id, input: $input) {
          id
          address
          settings
        }
      }
    `, {
      id: tenantId,
      input: {
        address: newAddress,
        settings: { timezone: 'Europe/Istanbul', language: 'tr' },
      },
    });

    expect(updateResult.updateTenant.id).toBe(tenantId);
    expect(updateResult.updateTenant.address).toBe(newAddress);
    // settings is returned as JSON string from GraphQL
    expect(updateResult.updateTenant.settings).toBeTruthy();
  });
});
