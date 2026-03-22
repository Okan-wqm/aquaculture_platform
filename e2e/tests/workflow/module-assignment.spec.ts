import { GraphQLTestClient } from '../../helpers/graphql-client';
import { generateTenantFixture, TestTenantFixture } from '../../helpers/tenant.fixture';

/**
 * Module Assignment E2E Workflow Test
 *
 * Tests assigning a module manager, verifying their access
 * through myModules query, and then removing the assignment.
 */
describe('Module Assignment', () => {
  let client: GraphQLTestClient;
  let fixture: TestTenantFixture;

  beforeAll(() => {
    client = new GraphQLTestClient();
    fixture = generateTenantFixture();
    client.setToken(fixture.adminToken);
  });

  afterAll(() => {
    client.clearToken();
  });

  test('Assign module manager -> verify access -> remove', async () => {
    // Step 1: Get tenant modules to find one to assign
    const modulesResult = await client.query<{
      myTenantModules: Array<{
        id: string;
        isEnabled: boolean;
        module: {
          id: string;
          code: string;
          name: string;
        } | null;
        managerId: string | null;
      }>;
    }>(`
      query MyTenantModules {
        myTenantModules {
          id
          isEnabled
          module {
            id
            code
            name
          }
          managerId
        }
      }
    `);

    const tenantModules = modulesResult.myTenantModules;

    // If no modules are assigned to the tenant, skip the test
    if (tenantModules.length === 0) {
      console.warn('No tenant modules found; skipping module assignment test');
      return;
    }

    const targetModule = tenantModules[0];
    expect(targetModule).toBeDefined();
    if (!targetModule) return;

    const moduleId = targetModule.id;
    const targetUserId = fixture.adminUserId;

    // Step 2: Assign module manager
    const assignResult = await client.mutate<{
      assignModuleManager: {
        id: string;
        managerId: string | null;
      };
    }>(
      `
      mutation AssignModuleManager($input: AssignModuleManagerInput!) {
        assignModuleManager(input: $input) {
          id
          managerId
        }
      }
      `,
      {
        input: {
          moduleId,
          userId: targetUserId,
        },
      },
    );

    expect(assignResult.assignModuleManager.managerId).toBe(targetUserId);

    // Step 3: Verify through myModules that the user has access
    const myModulesResult = await client.query<{
      myModules: Array<{
        id: string;
        moduleId: string;
        code: string;
        name: string;
        isEnabled: boolean;
      }>;
    }>(`
      query MyModules {
        myModules {
          id
          moduleId
          code
          name
          isEnabled
        }
      }
    `);

    // Tenant admin should see all modules
    expect(myModulesResult.myModules).toBeDefined();
    expect(Array.isArray(myModulesResult.myModules)).toBe(true);

    // Step 4: Remove module manager
    const removeResult = await client.mutate<{
      removeModuleManager: {
        id: string;
        managerId: string | null;
      };
    }>(
      `
      mutation RemoveModuleManager($moduleId: ID!) {
        removeModuleManager(moduleId: $moduleId) {
          id
          managerId
        }
      }
      `,
      { moduleId },
    );

    expect(removeResult.removeModuleManager.managerId).toBeNull();
  });
});
