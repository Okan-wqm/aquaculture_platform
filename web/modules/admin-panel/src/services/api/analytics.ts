/**
 * Analytics API
 */

import { apiFetch, buildQueryString } from '../http-client';
import type {
  PaginatedResult,
  PaginationParams,
  DateRangeParams,
  DashboardSummary,
  KpiComparison,
  TenantMetrics,
  GrowthTrend,
  RevenueAnalytics,
  UsageAnalytics,
  EngagementMetrics,
} from '../types';

export const analyticsApi = {
  // Dashboard
  getDashboardSummary: () => apiFetch<DashboardSummary>('/analytics/dashboard'),
  getKpiComparisons: (period?: string) =>
    apiFetch<KpiComparison[]>(`/analytics/kpi-comparisons${period ? `?period=${period}` : ''}`),

  // Tenant Metrics
  getTenantMetrics: (params?: PaginationParams & { sortBy?: string; order?: 'asc' | 'desc' }) =>
    apiFetch<PaginatedResult<TenantMetrics>>(`/analytics/tenants?${buildQueryString(params || {})}`),
  getTenantGrowthTrend: (period: string = '30d', dataPoints: number = 30) =>
    apiFetch<GrowthTrend[]>(`/analytics/tenants/growth?period=${period}&dataPoints=${dataPoints}`),

  // Revenue Analytics
  getRevenueAnalytics: (params?: DateRangeParams) =>
    apiFetch<RevenueAnalytics>(`/analytics/revenue?${buildQueryString(params || {})}`),
  getRevenueByPlan: (params?: DateRangeParams) =>
    apiFetch<Array<{ plan: string; revenue: number; tenantCount: number }>>(`/analytics/revenue/by-plan?${buildQueryString(params || {})}`),
  getRevenueTrend: (period: string = '12m') =>
    apiFetch<Array<{ period: string; revenue: number; growth: number }>>(`/analytics/revenue/trend?period=${period}`),

  // Usage Analytics
  getUsageAnalytics: (params?: DateRangeParams) =>
    apiFetch<UsageAnalytics>(`/analytics/usage?${buildQueryString(params || {})}`),
  // TODO: No backend endpoint for /analytics/usage/api - removed
  getApiUsageByEndpoint: (_params?: DateRangeParams & { limit?: number }) => {
    throw new Error('Not implemented: no backend endpoint for /analytics/usage/api');
  },

  // TODO: No backend endpoint for /analytics/engagement - removed
  getEngagementMetrics: (_params?: DateRangeParams) => {
    throw new Error('Not implemented: no backend endpoint for /analytics/engagement');
  },
  // TODO: No backend endpoint for /analytics/engagement/features - removed
  getFeatureUsage: (_params?: DateRangeParams) => {
    throw new Error('Not implemented: no backend endpoint for /analytics/engagement/features');
  },

  // TODO: No backend endpoint for /analytics/geographic - removed
  getGeographicDistribution: () => {
    throw new Error('Not implemented: no backend endpoint for /analytics/geographic');
  },

  // Churn Analytics
  getTenantChurn: (period: string = '30d') =>
    apiFetch<GrowthTrend[]>(`/analytics/tenants/churn?period=${period}`),

  // User Metrics
  getUserMetrics: (params?: DateRangeParams) =>
    apiFetch<{ totalUsers: number; activeUsers: number; newUsers: number; churnedUsers: number }>(`/analytics/users?${buildQueryString(params || {})}`),
  getUserActivity: (period: string = '30d') =>
    apiFetch<Array<{ date: string; activeUsers: number; sessions: number }>>(`/analytics/users/activity?period=${period}`),
  // Fix: backend GET /analytics/users/heatmap takes no query params
  getUserHeatmap: (_params?: DateRangeParams) =>
    apiFetch<Array<{ hour: number; day: number; count: number }>>('/analytics/users/heatmap'),

  // Module & Feature Usage
  getModuleUsageAnalytics: () =>
    apiFetch<Array<{ moduleCode: string; moduleName: string; activeCount: number; totalAssigned: number }>>('/analytics/usage/modules'),
  getFeatureAdoption: () =>
    apiFetch<Array<{ feature: string; adoptionRate: number; trend: number }>>('/analytics/usage/features'),

  // Financial Metrics
  getFinancialMetrics: (params?: DateRangeParams) =>
    apiFetch<{ mrr: number; arr: number; ltv: number; cac: number; churnRate: number }>(`/analytics/financial?${buildQueryString(params || {})}`),
  getFinancialRevenue: (period: string = '12m') =>
    apiFetch<Array<{ period: string; revenue: number }>>(`/analytics/financial/revenue?period=${period}`),
  getFinancialByPlan: () =>
    apiFetch<Array<{ plan: string; revenue: number; percentage: number }>>('/analytics/financial/by-plan'),

  // System Metrics (Analytics)
  getSystemAnalytics: () =>
    apiFetch<{ cpuUsage: number; memoryUsage: number; diskUsage: number; uptime: number }>('/analytics/system'),
  getSystemApiCallsTrend: (period: string = '24h') =>
    apiFetch<Array<{ timestamp: string; count: number }>>(`/analytics/system/api-calls?period=${period}`),
  getSystemErrorsTrend: (period: string = '24h') =>
    apiFetch<Array<{ timestamp: string; count: number; rate: number }>>(`/analytics/system/errors?period=${period}`),

  // Snapshots - backend requires mandatory 'category' param plus startDate/endDate
  getAnalyticsSnapshots: (params: { category: 'tenant' | 'user' | 'financial' | 'system' | 'usage'; startDate: string; endDate: string; snapshotType?: 'daily' | 'weekly' | 'monthly' | 'yearly' }) =>
    apiFetch<Array<{ id: string; date: string; metrics: Record<string, number> }>>(`/analytics/snapshots?${buildQueryString(params)}`),
};
