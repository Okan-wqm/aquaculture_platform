/**
 * Analytics domain types
 */

export interface DashboardSummary {
  tenants: {
    total: number;
    active: number;
    inactive: number;
    trial: number;
    suspended: number;
    newThisMonth: number;
    churnedThisMonth: number;
    churnRate: number;
    growthRate: number;
    byPlan: Record<string, number>;
    byRegion: Record<string, number>;
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
    revenueGrowthRate: number;
    pendingPayments: number;
    overduePayments: number;
    refunds: number;
    byPlan: Record<string, number>;
    byCurrency: Record<string, number>;
  };
  /**
   * Mirrors the backend SystemMetrics contract. Every field is `number | null`
   * because admin-api measures none of them today; `null` means "not measured"
   * and must render as a placeholder, never as a number (APA-131).
   */
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
    moduleUsage: Record<string, {
      activeUsers: number;
      totalSessions: number;
      avgSessionDuration: number;
    }>;
    featureAdoption: Record<string, number>;
    topFeatures: Array<{ feature: string; usage: number }>;
    peakHours: number[];
    avgDailyActiveUsers: number;
  };
  generatedAt: string;
  unavailable?: string[];
}

export interface KpiComparison {
  metric: string;
  current: number;
  previous: number;
  change: number;
  changePercent: number;
  trend: 'up' | 'down' | 'stable';
}

export interface TenantMetrics {
  tenantId: string;
  tenantName: string;
  userCount: number;
  activeUsers: number;
  farmCount: number;
  sensorCount: number;
  apiCalls: number;
  dataUsageGb: number;
  lastActivity: string;
}

export interface GrowthTrend {
  period: string;
  tenants: number;
  users: number;
  revenue: number;
  churn: number;
}

export type AnalyticsRange = '7d' | '30d' | '90d' | '1y';
export type AnalyticsGranularity = 'day' | 'week' | 'month';

export interface TimeSeriesPoint {
  date: string;
  value: number;
}

export interface TimeSeriesResponse {
  range: AnalyticsRange;
  granularity: AnalyticsGranularity;
  data: TimeSeriesPoint[];
  source: string;
  asOf: string;
}

export interface RevenueAnalytics {
  totalRevenue: number;
  mrr: number;
  arr: number;
  averageRevenuePerTenant: number;
  revenueByPlan: Array<{ plan: string; revenue: number; percentage: number }>;
  revenueByMonth: Array<{ month: string; revenue: number }>;
}

export interface UsageAnalytics {
  totalApiCalls: number;
  apiCallsByEndpoint: Array<{ endpoint: string; count: number }>;
  avgResponseTime: number;
  errorRate: number;
  activeSessionsNow: number;
  peakConcurrentUsers: number;
  dataStorageUsedGb: number;
}

export interface EngagementMetrics {
  dailyActiveUsers: number;
  weeklyActiveUsers: number;
  monthlyActiveUsers: number;
  avgSessionDuration: number;
  avgActionsPerSession: number;
  featureUsage: Array<{ feature: string; usageCount: number; uniqueUsers: number }>;
}
