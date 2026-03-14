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
  getApiUsageByEndpoint: (params?: DateRangeParams & { limit?: number }) =>
    apiFetch<Array<{ endpoint: string; method: string; count: number; avgTime: number }>>(`/analytics/usage/api?${buildQueryString(params || {})}`),

  // Engagement
  getEngagementMetrics: (params?: DateRangeParams) =>
    apiFetch<EngagementMetrics>(`/analytics/engagement?${buildQueryString(params || {})}`),
  getFeatureUsage: (params?: DateRangeParams) =>
    apiFetch<Array<{ feature: string; usageCount: number; uniqueUsers: number; trend: number }>>(`/analytics/engagement/features?${buildQueryString(params || {})}`),

  // Geographic Distribution
  getGeographicDistribution: () =>
    apiFetch<Array<{ country: string; region: string; tenantCount: number; userCount: number }>>('/analytics/geographic'),

  // Churn Analytics
  getTenantChurn: (period: string = '30d') =>
    apiFetch<GrowthTrend[]>(`/analytics/tenants/churn?period=${period}`),

  // User Metrics
  getUserMetrics: (params?: DateRangeParams) =>
    apiFetch<{ totalUsers: number; activeUsers: number; newUsers: number; churnedUsers: number }>(`/analytics/users?${buildQueryString(params || {})}`),
  getUserActivity: (period: string = '30d') =>
    apiFetch<Array<{ date: string; activeUsers: number; sessions: number }>>(`/analytics/users/activity?period=${period}`),
  getUserHeatmap: (params?: DateRangeParams) =>
    apiFetch<Array<{ hour: number; day: number; count: number }>>(`/analytics/users/heatmap?${buildQueryString(params || {})}`),

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

  // Snapshots
  getAnalyticsSnapshots: (params?: { startDate?: string; endDate?: string }) =>
    apiFetch<Array<{ id: string; date: string; metrics: Record<string, number> }>>(`/analytics/snapshots?${buildQueryString(params || {})}`),
};
