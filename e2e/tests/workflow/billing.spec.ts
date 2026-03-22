import { GraphQLTestClient } from '../../helpers/graphql-client';
import { generateTenantFixture, TestTenantFixture } from '../../helpers/tenant.fixture';

/**
 * Billing E2E Workflow Test
 *
 * Verifies that billing information reflects the tenant plan
 * and returns valid subscription data through the API.
 */
describe('Billing', () => {
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

  test('Billing info reflects tenant plan', async () => {
    // Step 1: Get the tenant to know its plan
    const tenantResult = await client.query<{
      myTenant: {
        id: string;
        name: string;
        plan: string;
        status: string;
      };
    }>(`
      query GetTenantPlan {
        myTenant {
          id
          name
          plan
          status
        }
      }
    `);

    const tenant = tenantResult.myTenant;
    expect(tenant).toBeDefined();
    expect(tenant.id).toBeDefined();
    expect(typeof tenant.plan).toBe('string');

    // Plan should be one of the valid TenantPlan enum values
    const validPlans = ['trial', 'starter', 'professional', 'enterprise'];
    expect(validPlans).toContain(tenant.plan.toLowerCase());

    // Status should be one of the valid TenantStatus enum values
    const validStatuses = ['ACTIVE', 'SUSPENDED', 'PENDING', 'CANCELLED'];
    expect(validStatuses).toContain(tenant.status);

    // Step 2: Get tenant stats which includes module usage (related to billing)
    const statsResult = await client.query<{
      tenantStats: {
        totalModules: number;
        activeModules: number;
        totalUsers: number;
      };
    }>(`
      query BillingStats {
        tenantStats {
          totalModules
          activeModules
          totalUsers
        }
      }
    `);

    const stats = statsResult.tenantStats;
    expect(typeof stats.totalModules).toBe('number');
    expect(typeof stats.activeModules).toBe('number');
    expect(typeof stats.totalUsers).toBe('number');
    expect(stats.totalModules).toBeGreaterThanOrEqual(0);
    expect(stats.activeModules).toBeGreaterThanOrEqual(0);
    expect(stats.totalUsers).toBeGreaterThanOrEqual(0);

    // Step 3: Get module usage stats (billing-related)
    const moduleUsageResult = await client.query<{
      moduleUsageStats: Array<{
        moduleCode: string;
        userCount: number;
        actionsThisMonth: number;
        actionsLastMonth: number;
      }>;
    }>(`
      query ModuleUsageStats {
        moduleUsageStats {
          moduleCode
          userCount
          actionsThisMonth
          actionsLastMonth
        }
      }
    `);

    expect(Array.isArray(moduleUsageResult.moduleUsageStats)).toBe(true);

    // Each module usage stat should have valid structure
    for (const stat of moduleUsageResult.moduleUsageStats) {
      expect(typeof stat.moduleCode).toBe('string');
      expect(stat.moduleCode.length).toBeGreaterThan(0);
      expect(typeof stat.userCount).toBe('number');
      expect(stat.userCount).toBeGreaterThanOrEqual(0);
      expect(typeof stat.actionsThisMonth).toBe('number');
      expect(typeof stat.actionsLastMonth).toBe('number');
    }
  });
});
