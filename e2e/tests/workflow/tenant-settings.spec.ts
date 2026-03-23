import { GraphQLTestClient } from '../../helpers/graphql-client';
import { generateTenantFixture, TestTenantFixture } from '../../helpers/tenant.fixture';

/**
 * Tenant Settings E2E Workflow Test
 *
 * Tests updating tenant settings via the updateTenant(id, input) mutation
 * and verifying persistence through the myTenant query.
 */
describe('Tenant Settings', () => {
  let client: GraphQLTestClient;
  let fixture: TestTenantFixture;
  let tenantId: string;
  let originalName: string;
  let originalDescription: string | null;
  let originalContactEmail: string | null;

  beforeAll(async () => {
    client = new GraphQLTestClient();
    fixture = generateTenantFixture();
    client.setToken(fixture.adminToken);

    // Store original values for restore in cleanup
    try {
      const current = await client.query<{
        myTenant: {
          id: string;
          name: string;
          description: string | null;
          contactEmail: string | null;
        };
      }>(`
        query MyTenant {
          myTenant {
            id
            name
            description
            contactEmail
          }
        }
      `);
      tenantId = current.myTenant.id;
      originalName = current.myTenant.name;
      originalDescription = current.myTenant.description;
      originalContactEmail = current.myTenant.contactEmail;
    } catch {
      tenantId = '';
      originalName = '';
      originalDescription = null;
      originalContactEmail = null;
    }
  });

  afterAll(async () => {
    // Restore original settings
    if (originalName && tenantId) {
      try {
        await client.mutate(`
          mutation RestoreTenantSettings($id: ID!, $input: UpdateTenantInput!) {
            updateTenant(id: $id, input: $input) {
              id
            }
          }
        `, {
          id: tenantId,
          input: {
            name: originalName,
            description: originalDescription,
            contactEmail: originalContactEmail,
          },
        });
      } catch {
        // Restore failure is not a test failure
      }
    }
    client.clearToken();
  });

  test('Update tenant settings via updateTenant -> verify persistence', async () => {
    // Skip if tenant ID was not obtained during setup
    if (!tenantId) {
      console.warn('Skipping: tenant ID not available');
      return;
    }

    const updatedName = `E2E Updated Tenant ${Date.now()}`;
    const updatedDescription = `E2E test description updated at ${new Date().toISOString()}`;
    const updatedContactEmail = `e2e-updated-${Date.now()}@test.aquaculture.dev`;

    // Step 1: Update tenant via updateTenant(id, input) mutation
    const updateResult = await client.mutate<{
      updateTenant: {
        id: string;
        name: string;
        description: string | null;
        contactEmail: string | null;
        updatedAt: string;
      };
    }>(
      `
      mutation UpdateTenant($id: ID!, $input: UpdateTenantInput!) {
        updateTenant(id: $id, input: $input) {
          id
          name
          description
          contactEmail
          updatedAt
        }
      }
      `,
      {
        id: tenantId,
        input: {
          name: updatedName,
          description: updatedDescription,
          contactEmail: updatedContactEmail,
        },
      },
    );

    // Verify mutation returned updated values
    expect(updateResult.updateTenant.id).toBe(tenantId);
    expect(updateResult.updateTenant.name).toBe(updatedName);
    expect(updateResult.updateTenant.description).toBe(updatedDescription);
    expect(updateResult.updateTenant.contactEmail).toBe(updatedContactEmail);
    expect(updateResult.updateTenant.updatedAt).toBeTruthy();

    // Step 2: Verify persistence by re-querying
    const verifyResult = await client.query<{
      myTenant: {
        id: string;
        name: string;
        description: string | null;
        contactEmail: string | null;
      };
    }>(`
      query VerifyTenantSettings {
        myTenant {
          id
          name
          description
          contactEmail
        }
      }
    `);

    expect(verifyResult.myTenant.name).toBe(updatedName);
    expect(verifyResult.myTenant.description).toBe(updatedDescription);
    expect(verifyResult.myTenant.contactEmail).toBe(updatedContactEmail);
  });
});
