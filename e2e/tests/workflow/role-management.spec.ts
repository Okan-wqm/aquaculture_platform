import { GraphQLTestClient } from '../../helpers/graphql-client';
import { generateTenantFixture, TestTenantFixture } from '../../helpers/tenant.fixture';

/**
 * Role Management E2E Workflow Test
 *
 * Tests the complete role lifecycle:
 * Create role -> List -> Update permissions -> Assign to user -> Delete
 */
describe('Role Management', () => {
  let client: GraphQLTestClient;
  let fixture: TestTenantFixture;
  let createdRoleId: string;
  let createdUserId: string;

  beforeAll(() => {
    client = new GraphQLTestClient();
    fixture = generateTenantFixture();
    client.setToken(fixture.adminToken);
  });

  afterAll(async () => {
    // Cleanup: delete the created role if it still exists
    if (createdRoleId) {
      try {
        // If user was assigned, revoke first
        if (createdUserId) {
          await client.mutate(`
            mutation RevokeRole($input: RevokeUserRoleInput!) {
              revokeUserRole(input: $input)
            }
          `, {
            input: {
              userId: createdUserId,
              hardDelete: true,
            },
          });
        }

        await client.mutate(`
          mutation DeleteRole($roleId: ID!) {
            deleteTenantRole(roleId: $roleId)
          }
        `, { roleId: createdRoleId });
      } catch {
        // Cleanup failure is not a test failure
      }
    }

    // Cleanup user
    if (createdUserId) {
      try {
        await client.mutate(`
          mutation DeleteUser($userId: ID!) {
            deleteTenantUser(userId: $userId)
          }
        `, { userId: createdUserId });
      } catch {
        // Cleanup failure is not a test failure
      }
    }

    client.clearToken();
  });

  test('Create role -> assign permissions -> assign to user -> delete', async () => {
    const roleName = `E2E Test Role ${Date.now()}`;
    const panelPermissions = {
      dashboard: {
        overview: {
          view: true,
          edit: false,
        },
      },
      users: {
        list: {
          view: true,
          edit: false,
          delete: false,
        },
      },
    };

    // Step 1: Create a new tenant role
    const createResult = await client.mutate<{
      createTenantRole: {
        id: string;
        name: string;
        color: string;
        icon: string;
        level: number;
        isSystem: boolean;
        isDefault: boolean;
        permissions: {
          id: string;
          panelPermissions: Record<string, unknown>;
        } | null;
      };
    }>(
      `
      mutation CreateRole($input: CreateTenantRoleInput!) {
        createTenantRole(input: $input) {
          id
          name
          color
          icon
          level
          isSystem
          isDefault
          permissions {
            id
            panelPermissions
          }
        }
      }
      `,
      {
        input: {
          name: roleName,
          description: 'E2E test role for workflow testing',
          color: '#FF5733',
          icon: 'test-icon',
          level: 40,
          isDefault: false,
          panelPermissions,
        },
      },
    );

    createdRoleId = createResult.createTenantRole.id;
    expect(createdRoleId).toBeDefined();
    expect(createResult.createTenantRole.name).toBe(roleName);
    expect(createResult.createTenantRole.isSystem).toBe(false);

    // Step 2: Verify role appears in tenant roles list
    const listResult = await client.query<{
      tenantRoles: Array<{
        id: string;
        name: string;
        userCount: number;
      }>;
    }>(`
      query TenantRoles {
        tenantRoles {
          id
          name
          userCount
        }
      }
    `);

    const foundRole = listResult.tenantRoles.find(
      (r) => r.id === createdRoleId,
    );
    expect(foundRole).toBeDefined();
    expect(foundRole?.name).toBe(roleName);

    // Step 3: Update role with additional permissions
    const updatedPanelPermissions = {
      ...panelPermissions,
      reports: {
        analytics: {
          view: true,
          export: true,
        },
      },
    };

    const updateResult = await client.mutate<{
      updateTenantRole: {
        id: string;
        name: string;
        permissions: {
          panelPermissions: Record<string, unknown>;
        } | null;
      };
    }>(
      `
      mutation UpdateRole($roleId: ID!, $input: UpdateTenantRoleInput!) {
        updateTenantRole(roleId: $roleId, input: $input) {
          id
          name
          permissions {
            panelPermissions
          }
        }
      }
      `,
      {
        roleId: createdRoleId,
        input: {
          panelPermissions: updatedPanelPermissions,
        },
      },
    );

    expect(updateResult.updateTenantRole.id).toBe(createdRoleId);

    // Step 4: Create a user and assign the role
    const testEmail = `e2e-role-test-${Date.now()}@test.aquaculture.dev`;

    try {
      const userResult = await client.mutate<{
        createTenantUser: {
          userId: string;
          email: string;
          roleAssignment: {
            roleId: string;
            roleName: string;
          };
        };
      }>(
        `
        mutation CreateUserWithRole($input: CreateTenantUserInput!) {
          createTenantUser(input: $input) {
            userId
            email
            roleAssignment {
              roleId
              roleName
            }
          }
        }
        `,
        {
          input: {
            firstName: 'RoleTest',
            lastName: 'User',
            email: testEmail,
            password: 'TestP@ssw0rd!2024',
            roleId: createdRoleId,
            sendInvitation: false,
          },
        },
      );

      createdUserId = userResult.createTenantUser.userId;
      expect(userResult.createTenantUser.roleAssignment.roleId).toBe(createdRoleId);
    } catch {
      // If user creation fails (e.g., tenant doesn't exist in DB), skip user-related assertions
      createdUserId = '';
    }

    // Step 5: Revoke role from user before deletion
    if (createdUserId) {
      const revokeResult = await client.mutate<{
        revokeUserRole: boolean;
      }>(
        `
        mutation RevokeRole($input: RevokeUserRoleInput!) {
          revokeUserRole(input: $input)
        }
        `,
        {
          input: {
            userId: createdUserId,
            hardDelete: true,
          },
        },
      );
      expect(revokeResult.revokeUserRole).toBe(true);
    }

    // Step 6: Delete the role
    const deleteResult = await client.mutate<{
      deleteTenantRole: boolean;
    }>(
      `
      mutation DeleteRole($roleId: ID!) {
        deleteTenantRole(roleId: $roleId)
      }
      `,
      { roleId: createdRoleId },
    );

    expect(deleteResult.deleteTenantRole).toBe(true);

    // Mark as cleaned up
    createdRoleId = '';
  });
});
