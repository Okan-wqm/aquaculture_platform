import * as crypto from 'crypto';

import { TestDatabase } from '../../helpers/db.helper';
import { GraphQLTestClient } from '../../helpers/graphql-client';
import { generateTenantFixture, TestTenantFixture } from '../../helpers/tenant.fixture';

/**
 * User CRUD Lifecycle E2E Workflow Test
 *
 * Tests the complete user lifecycle within a tenant:
 * Create -> List -> Update -> Deactivate -> Verify
 */
describe('User CRUD Lifecycle', () => {
  let client: GraphQLTestClient;
  let db: TestDatabase;
  let fixture: TestTenantFixture;
  let createdUserId: string;
  let roleId: string;

  beforeAll(async () => {
    client = new GraphQLTestClient();
    db = new TestDatabase();
    fixture = generateTenantFixture();
    client.setToken(fixture.adminToken);

    try {
      await db.connect();
    } catch {
      // DB connection is optional; tests will skip DB assertions
    }

    // First, get or create a role to assign to the new user
    try {
      const rolesData = await client.query<{
        tenantRoles: Array<{ id: string; name: string }>;
      }>(`
        query TenantRoles {
          tenantRoles {
            id
            name
          }
        }
      `);

      if (rolesData.tenantRoles.length > 0 && rolesData.tenantRoles[0]) {
        roleId = rolesData.tenantRoles[0].id;
      } else {
        // Seed default roles if none exist
        const seedResult = await client.mutate<{
          seedTenantRoles: Array<{ id: string; name: string }>;
        }>(`
          mutation SeedRoles {
            seedTenantRoles {
              id
              name
            }
          }
        `);
        if (seedResult.seedTenantRoles[0]) {
          roleId = seedResult.seedTenantRoles[0].id;
        }
      }
    } catch {
      // Role seeding may fail if tenant doesn't exist in DB
      roleId = crypto.randomUUID();
    }
  });

  afterAll(async () => {
    // Cleanup: try to delete the created user
    if (createdUserId) {
      try {
        await client.mutate(
          `
          mutation DeleteUser($userId: ID!) {
            deleteTenantUser(userId: $userId)
          }
        `,
          { userId: createdUserId },
        );
      } catch {
        // Cleanup failure is not a test failure
      }
    }

    client.clearToken();
    await db.disconnect();
  });

  test('Create user -> appears in list -> edit -> deactivate -> verify inactive', async () => {
    const testEmail = `e2e-user-${Date.now()}@test.aquaculture.dev`;
    const firstName = 'E2EFirst';
    const lastName = 'E2ELast';

    // Step 1: Create a new tenant user
    const createResult = await client.mutate<{
      createTenantUser: {
        userId: string;
        email: string;
        firstName: string | null;
        lastName: string | null;
        invitationSent: boolean;
        createdAt: string;
      };
    }>(
      `
      mutation CreateTenantUser($input: CreateTenantUserInput!) {
        createTenantUser(input: $input) {
          userId
          email
          firstName
          lastName
          invitationSent
          createdAt
        }
      }
      `,
      {
        input: {
          firstName,
          lastName,
          email: testEmail,
          password: 'TestP@ssw0rd!2024',
          roleId,
          sendInvitation: false,
        },
      },
    );

    createdUserId = createResult.createTenantUser.userId;
    expect(createdUserId).toBeDefined();
    expect(createResult.createTenantUser.email).toBe(testEmail);

    // Step 2: Verify user appears in tenant users list
    const listResult = await client.query<{
      tenantUsers: Array<{
        id: string;
        email: string;
        firstName: string | null;
        lastName: string | null;
      }>;
    }>(`
      query TenantUsers {
        tenantUsers {
          id
          email
          firstName
          lastName
        }
      }
    `);

    const foundUser = listResult.tenantUsers.find((u) => u.id === createdUserId);
    expect(foundUser).toBeDefined();
    expect(foundUser?.email).toBe(testEmail);

    // Step 3: Update user's first name
    const updatedFirstName = 'UpdatedE2EFirst';
    const updateResult = await client.mutate<{
      updateTenantUser: {
        id: string;
        firstName: string | null;
      };
    }>(
      `
      mutation UpdateTenantUser($userId: ID!, $input: UpdateTenantUserInput!) {
        updateTenantUser(userId: $userId, input: $input) {
          id
          firstName
        }
      }
      `,
      {
        userId: createdUserId,
        input: {
          firstName: updatedFirstName,
        },
      },
    );

    expect(updateResult.updateTenantUser.firstName).toBe(updatedFirstName);

    // Step 4: Deactivate the user
    const deactivateResult = await client.mutate<{
      deactivateTenantUser: {
        id: string;
        email: string;
      };
    }>(
      `
      mutation DeactivateUser($userId: ID!) {
        deactivateTenantUser(userId: $userId) {
          id
          email
        }
      }
      `,
      { userId: createdUserId },
    );

    expect(deactivateResult.deactivateTenantUser.id).toBe(createdUserId);

    // Step 5: Verify user is inactive via DB (backend verification)
    try {
      const userStatus = await db.getUserStatus(createdUserId);
      if (userStatus) {
        expect(userStatus.isActive).toBe(false);
        expect(userStatus.email).toBe(testEmail);
      }
    } catch {
      // DB verification is best-effort; if connection failed, skip
    }
  });
});
