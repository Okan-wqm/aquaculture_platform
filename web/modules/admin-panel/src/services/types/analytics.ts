/**
 * Analytics domain types
 */

export interface DashboardSummary {
  totalTenants: number;
  activeTenants: number;
  totalUsers: number;
  activeUsers: number;
  totalRevenue: number;
  mrr: number;
  growthRate: number;
  churnRate: number;
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
