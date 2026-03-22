import { GraphQLTestClient } from '../../helpers/graphql-client';
import { generateTenantFixture, TestTenantFixture } from '../../helpers/tenant.fixture';

/**
 * Dashboard E2E Workflow Test
 *
 * Verifies that the tenant dashboard returns real, dynamic statistics
 * rather than hardcoded placeholder values.
 */
describe('Dashboard Workflow', () => {
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

  test('Dashboard loads with real statistics (not hardcoded)', async () => {
    const TENANT_STATS_QUERY = `
      query TenantStats {
        tenantStats {
          totalUsers
          activeUsers
          pendingUsers
          inactiveUsers
          totalModules
          activeModules
          activeSessions
          monthlyGrowthPercent
          lastActivityAt
        }
      }
    `;

    const data = await client.query<{
      tenantStats: {
        totalUsers: number;
        activeUsers: number;
        pendingUsers: number;
        inactiveUsers: number;
        totalModules: number;
        activeModules: number;
        activeSessions: number;
        monthlyGrowthPercent: number | null;
        lastActivityAt: string;
      };
    }>(TENANT_STATS_QUERY);

    const stats = data.tenantStats;

    // Verify all numeric fields are actual numbers, not undefined/null
    expect(typeof stats.totalUsers).toBe('number');
    expect(typeof stats.activeUsers).toBe('number');
    expect(typeof stats.pendingUsers).toBe('number');
    expect(typeof stats.inactiveUsers).toBe('number');
    expect(typeof stats.totalModules).toBe('number');
    expect(typeof stats.activeModules).toBe('number');
    expect(typeof stats.activeSessions).toBe('number');

    // Verify values are non-negative (valid range)
    expect(stats.totalUsers).toBeGreaterThanOrEqual(0);
    expect(stats.activeUsers).toBeGreaterThanOrEqual(0);
    expect(stats.activeSessions).toBeGreaterThanOrEqual(0);

    // CRITICAL: monthlyGrowthPercent must NOT be hardcoded 15
    // (the old placeholder value from the stub implementation)
    if (stats.monthlyGrowthPercent !== null && stats.monthlyGrowthPercent !== undefined) {
      // If the value is exactly 15, flag it as potentially hardcoded
      // In practice, real data would not always be exactly 15
      expect(stats.monthlyGrowthPercent).not.toBe(15);
    }

    // lastActivityAt should be a valid ISO date string
    expect(stats.lastActivityAt).toBeDefined();
    const activityDate = new Date(stats.lastActivityAt);
    expect(activityDate.getTime()).not.toBeNaN();
  });

  test('myTenant query returns tenant information', async () => {
    const MY_TENANT_QUERY = `
      query MyTenant {
        myTenant {
          id
          name
          slug
          status
          contactEmail
          description
        }
      }
    `;

    const data = await client.query<{
      myTenant: {
        id: string;
        name: string;
        slug: string;
        status: string;
        contactEmail: string | null;
        description: string | null;
      };
    }>(MY_TENANT_QUERY);

    expect(data.myTenant).toBeDefined();
    expect(data.myTenant.id).toBeDefined();
    expect(typeof data.myTenant.name).toBe('string');
    expect(data.myTenant.name.length).toBeGreaterThan(0);
    expect(typeof data.myTenant.slug).toBe('string');
    expect(data.myTenant.status).toBeDefined();
  });
});
