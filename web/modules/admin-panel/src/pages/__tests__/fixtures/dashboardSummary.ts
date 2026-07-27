/**
 * A COMPLETE `DashboardSummary`, for specs that render AnalyticsDashboardPage.
 *
 * The page used to merge every API response over an all-zero
 * `getDefaultData()` literal, so a spec could mock one field and let the
 * fallback supply the rest. That merge is exactly what made an outage render as
 * a confident dashboard of zeros (APA-136), so it is gone — and with it the
 * ability to mock a partial summary. A test that wants one group different
 * spreads over this fixture, which keeps the "what the backend actually sends"
 * shape in one place instead of duplicated per spec.
 *
 * Values here are deliberately DISTINCT and non-zero so an assertion cannot
 * pass by coincidence against a zeroed default.
 */
export interface DashboardSummaryFixture {
  tenants: {
    total: number;
    active: number;
    inactive: number;
    trial: number;
    suspended: number;
    newThisMonth: number;
    churnedThisMonth: number | null;
    churnRate: number | null;
    growthRate: number | null;
    byPlan: Record<string, number>;
  };
  users: {
    total: number;
    active: number;
    inactive: number;
    newThisMonth: number;
    activeLastDay: number;
    activeLastWeek: number;
    activeLastMonth: number;
    growthRate: number;
    avgUsersPerTenant: number;
    byRole: Record<string, number>;
  };
  financial: {
    mrr: number;
    arr: number;
    arpu: number;
    arppu: number;
    ltv: number;
    totalRevenue: number;
    revenueThisMonth: number;
    revenueGrowthRate: number | null;
    pendingPayments: number;
    overduePayments: number;
    refunds: number;
    byPlan: Record<string, number>;
    byCurrency: Record<string, number>;
  };
  system: {
    totalStorageBytes: number | null;
    usedStorageBytes: number | null;
    storageUtilization: number | null;
    apiCallsToday: number | null;
    apiCallsThisMonth: number | null;
    avgResponseTimeMs: number | null;
    errorRate: number | null;
    uptimePercent: number | null;
    activeConnections: number | null;
    queuedJobs: number | null;
  };
  usage: {
    moduleUsage: Record<string, { activeUsers: number; totalSessions: number; avgSessionDuration: number }>;
    featureAdoption: Record<string, number>;
    topFeatures: Array<{ feature: string; usage: number }>;
    peakHours: number[];
    avgDailyActiveUsers: number;
  };
  generatedAt: string;
  unavailable?: string[];
}

export const dashboardSummaryFixture = (): DashboardSummaryFixture => ({
  tenants: {
    total: 42,
    active: 30,
    inactive: 6,
    trial: 4,
    suspended: 6,
    newThisMonth: 5,
    // Churn has no source on this platform (APA-135).
    churnedThisMonth: null,
    churnRate: null,
    growthRate: null,
    byPlan: { starter: 20, professional: 15, enterprise: 5 },
  },
  users: {
    total: 310,
    active: 240,
    inactive: 70,
    newThisMonth: 18,
    activeLastDay: 96,
    activeLastWeek: 180,
    activeLastMonth: 240,
    growthRate: 6.1,
    avgUsersPerTenant: 7.4,
    byRole: { admin: 12, manager: 40, operator: 250, viewer: 8 },
  },
  financial: {
    mrr: 12750,
    arr: 153000,
    arpu: 425,
    arppu: 425,
    ltv: 10200,
    totalRevenue: 88400,
    revenueThisMonth: 12750,
    revenueGrowthRate: 4.2,
    pendingPayments: 900,
    overduePayments: 300,
    refunds: 150,
    byPlan: { starter: 1980, professional: 4485, enterprise: 6285 },
    byCurrency: { USD: 12750 },
  },
  system: {
    // admin-api measures none of these (APA-131).
    totalStorageBytes: null,
    usedStorageBytes: null,
    storageUtilization: null,
    apiCallsToday: null,
    apiCallsThisMonth: null,
    avgResponseTimeMs: null,
    errorRate: null,
    uptimePercent: null,
    activeConnections: null,
    queuedJobs: null,
  },
  usage: {
    // Presence means measured; the pipeline is not wired (APA-133).
    moduleUsage: {},
    featureAdoption: {},
    topFeatures: [],
    peakHours: [],
    avgDailyActiveUsers: 96,
  },
  generatedAt: '2026-07-27T00:00:00.000Z',
});
