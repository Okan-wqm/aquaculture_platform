/**
 * Analytics API
 */

import { apiFetch, buildQueryString } from '../http-client';
import type {
  DateRangeParams,
  DashboardSummary,
  KpiComparison,
  TenantMetrics,
  GrowthTrend,
  AnalyticsGranularity,
  AnalyticsRange,
  TimeSeriesResponse,
  RevenueAnalytics,
  UsageAnalytics,
} from '../types';

export const analyticsApi = {
  // Dashboard
  getDashboardSummary: () => apiFetch<DashboardSummary>('/analytics/dashboard'),
  getKpiComparisons: (period?: string) =>
    apiFetch<KpiComparison[]>(`/analytics/kpi-comparisons${period ? `?period=${period}` : ''}`),

  // Tenant Metrics
  getTenantMetrics: () => apiFetch<TenantMetrics>('/analytics/tenants'),
  getTenantGrowthTrend: (range: AnalyticsRange = '30d', granularity?: AnalyticsGranularity) =>
    apiFetch<TimeSeriesResponse>(`/analytics/tenants/growth?${buildQueryString({ range, granularity })}`),

  // Revenue Analytics
  getRevenueAnalytics: (params?: DateRangeParams) =>
    apiFetch<RevenueAnalytics>(`/analytics/revenue?${buildQueryString(params || {})}`),
  getRevenueByPlan: (params?: DateRangeParams) =>
    apiFetch<Array<{ plan: string; revenue: number; tenantCount: number }>>(`/analytics/revenue/by-plan?${buildQueryString(params || {})}`),
  getRevenueTrend: (range: AnalyticsRange = '30d', granularity?: AnalyticsGranularity) =>
    apiFetch<TimeSeriesResponse>(`/analytics/revenue/trend?${buildQueryString({ range, granularity })}`),

  // Usage Analytics
  getUsageAnalytics: (params?: DateRangeParams) =>
    apiFetch<UsageAnalytics>(`/analytics/usage?${buildQueryString(params || {})}`),
  // Churn Analytics
  getTenantChurn: (period = '30d') =>
    apiFetch<GrowthTrend[]>(`/analytics/tenants/churn?period=${period}`),

  // User Metrics
  getUserMetrics: (params?: DateRangeParams) =>
    apiFetch<{ totalUsers: number; activeUsers: number; newUsers: number; churnedUsers: number }>(`/analytics/users?${buildQueryString(params || {})}`),
  getUserActivity: (range: AnalyticsRange = '30d', granularity?: AnalyticsGranularity) =>
    apiFetch<TimeSeriesResponse>(`/analytics/users/activity?${buildQueryString({ range, granularity })}`),
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
  getFinancialRevenue: (period = '12m') =>
    apiFetch<Array<{ period: string; revenue: number }>>(`/analytics/financial/revenue?period=${period}`),
  getFinancialByPlan: () =>
    apiFetch<Array<{ plan: string; revenue: number; percentage: number }>>('/analytics/financial/by-plan'),

  // System Metrics (Analytics)
  getSystemAnalytics: () =>
    apiFetch<{ cpuUsage: number; memoryUsage: number; diskUsage: number; uptime: number }>('/analytics/system'),
  getSystemApiCallsTrend: (period = '24h') =>
    apiFetch<Array<{ timestamp: string; count: number }>>(`/analytics/system/api-calls?period=${period}`),
  getSystemErrorsTrend: (period = '24h') =>
    apiFetch<Array<{ timestamp: string; count: number; rate: number }>>(`/analytics/system/errors?period=${period}`),

  // Snapshots - backend requires mandatory 'category' param plus startDate/endDate
  getAnalyticsSnapshots: (params: { category: 'tenant' | 'user' | 'financial' | 'system' | 'usage'; startDate: string; endDate: string; snapshotType?: 'daily' | 'weekly' | 'monthly' | 'yearly' }) =>
    apiFetch<Array<{ id: string; date: string; metrics: Record<string, number> }>>(`/analytics/snapshots?${buildQueryString(params)}`),
};
