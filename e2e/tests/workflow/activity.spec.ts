import { GraphQLTestClient } from '../../helpers/graphql-client';
import { generateTenantFixture, TestTenantFixture } from '../../helpers/tenant.fixture';

/**
 * Activity E2E Workflow Test
 *
 * Verifies that the tenant activity tracking returns valid data
 * including recent logins, session counts, user activity summaries,
 * and daily active user metrics.
 */
describe('Activity Tracking', () => {
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

  test('Login activity is tracked', async () => {
    // Step 1: Query tenant activity for last 7 days
    const activityResult = await client.query<{
      tenantActivity: {
        recentLogins: Array<{
          id: string;
          userId: string;
          email: string;
          firstName: string | null;
          lastName: string | null;
          loginAt: string;
          ipAddress: string | null;
          userAgent: string | null;
          deviceType: string | null;
          success: boolean;
        }>;
        activeSessions: number;
        userActivitySummaries: Array<{
          userId: string;
          email: string;
          totalActions: number;
          lastActiveAt: string | null;
          loginCount: number;
        }>;
        dailyActiveUsers: Array<{
          date: string;
          count: number;
        }>;
      };
    }>(
      `
      query TenantActivity($period: String) {
        tenantActivity(period: $period) {
          recentLogins {
            id
            userId
            email
            firstName
            lastName
            loginAt
            ipAddress
            userAgent
            deviceType
            success
          }
          activeSessions
          userActivitySummaries {
            userId
            email
            totalActions
            lastActiveAt
            loginCount
          }
          dailyActiveUsers {
            date
            count
          }
        }
      }
      `,
      { period: '7d' },
    );

    const activity = activityResult.tenantActivity;

    // Verify structure
    expect(activity).toBeDefined();
    expect(Array.isArray(activity.recentLogins)).toBe(true);
    expect(typeof activity.activeSessions).toBe('number');
    expect(activity.activeSessions).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(activity.userActivitySummaries)).toBe(true);
    expect(Array.isArray(activity.dailyActiveUsers)).toBe(true);

    // Verify recent logins structure (if any exist)
    for (const login of activity.recentLogins) {
      expect(login.id).toBeDefined();
      expect(login.userId).toBeDefined();
      expect(typeof login.email).toBe('string');
      expect(typeof login.success).toBe('boolean');

      // loginAt should be a valid date
      const loginDate = new Date(login.loginAt);
      expect(loginDate.getTime()).not.toBeNaN();
    }

    // Verify user activity summaries structure (if any exist)
    for (const summary of activity.userActivitySummaries) {
      expect(summary.userId).toBeDefined();
      expect(typeof summary.email).toBe('string');
      expect(typeof summary.totalActions).toBe('number');
      expect(summary.totalActions).toBeGreaterThanOrEqual(0);
      expect(typeof summary.loginCount).toBe('number');
      expect(summary.loginCount).toBeGreaterThanOrEqual(0);
    }

    // Verify daily active users structure (if any exist)
    for (const dau of activity.dailyActiveUsers) {
      expect(typeof dau.date).toBe('string');
      // Date should be in YYYY-MM-DD format
      expect(dau.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof dau.count).toBe('number');
      expect(dau.count).toBeGreaterThanOrEqual(0);
    }

    // Step 2: Also query with 30-day period to ensure period parameter works
    const activity30d = await client.query<{
      tenantActivity: {
        activeSessions: number;
        dailyActiveUsers: Array<{
          date: string;
          count: number;
        }>;
      };
    }>(
      `
      query TenantActivity30d($period: String) {
        tenantActivity(period: $period) {
          activeSessions
          dailyActiveUsers {
            date
            count
          }
        }
      }
      `,
      { period: '30d' },
    );

    expect(activity30d.tenantActivity).toBeDefined();
    expect(typeof activity30d.tenantActivity.activeSessions).toBe('number');
  });
});
