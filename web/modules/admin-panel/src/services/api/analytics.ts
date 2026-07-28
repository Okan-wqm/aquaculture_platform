/**
 * Analytics API
 *
 * Four functions used to live here for endpoints the backend does not have —
 * `getApiUsageByEndpoint`, `getEngagementMetrics`, `getFeatureUsage` and
 * `getGeographicDistribution` — each a NON-async arrow that
 * `throw new Error('Not implemented…')`. That is worse than absent: the throw
 * happens before a promise exists, so it escapes the `.then().catch()` chain
 * any caller would write around a function whose siblings all return promises.
 * A caller's error handling would silently fail to run. They are deleted rather
 * than converted to rejections, because an absent method is a COMPILE error at
 * the first would-be caller while a throwing one is a runtime trap (APA-151).
 * Re-introduce such a capability only alongside its real route, as a normal
 * `apiFetch`.
 */

import { apiFetch, buildQueryString } from '../http-client';
import type {
  AnalyticsGranularity,
  AnalyticsRange,
  AnalyticsSnapshotDto,
  AnalyticsSystemMetrics,
  ChartData,
  DashboardSummary,
  DateRangeParams,
  FinancialMetrics,
  KpiComparisons,
  RevenueAnalytics,
  RevenueByPlanAnalytics,
  TenantMetrics,
  TimeSeriesData,
  TimeSeriesResponse,
  UsageMetrics,
  UserMetrics,
} from '../types';

export const analyticsApi = {
  // Dashboard
  getDashboardSummary: () => apiFetch<DashboardSummary>('/analytics/dashboard'),
  getKpiComparisons: (period?: string) =>
    apiFetch<KpiComparisons>(`/analytics/kpi-comparisons${period ? `?period=${period}` : ''}`),

  // Tenant Metrics
  // An AGGREGATE, not a page of per-tenant rows: the route declares no @Query
  // parameters, so the pagination and sort arguments this used to accept were
  // built into a query string the controller discarded (APA-149).
  getTenantMetrics: () => apiFetch<TenantMetrics>('/analytics/tenants'),
  getTenantGrowthTrend: (range: AnalyticsRange = '30d', granularity?: AnalyticsGranularity) =>
    apiFetch<TimeSeriesResponse>(`/analytics/tenants/growth?${buildQueryString({ range, granularity })}`),

  // Revenue Analytics
  getRevenueAnalytics: (params?: DateRangeParams) =>
    apiFetch<RevenueAnalytics>(`/analytics/revenue?${buildQueryString(params || {})}`),
  getRevenueByPlan: (params?: DateRangeParams) =>
    apiFetch<RevenueByPlanAnalytics[]>(`/analytics/revenue/by-plan?${buildQueryString(params || {})}`),
  getRevenueTrend: (range: AnalyticsRange = '30d', granularity?: AnalyticsGranularity) =>
    apiFetch<TimeSeriesResponse>(`/analytics/revenue/trend?${buildQueryString({ range, granularity })}`),

  // Usage Analytics
  getUsageAnalytics: (params?: DateRangeParams) =>
    apiFetch<UsageMetrics>(`/analytics/usage?${buildQueryString(params || {})}`),
  // Churn Analytics
  getTenantChurn: (period = '30d') =>
    apiFetch<TimeSeriesData>(`/analytics/tenants/churn?period=${period}`),

  // User Metrics
  getUserMetrics: (params?: DateRangeParams) =>
    apiFetch<UserMetrics>(`/analytics/users?${buildQueryString(params || {})}`),
  getUserActivity: (range: AnalyticsRange = '30d', granularity?: AnalyticsGranularity) =>
    apiFetch<TimeSeriesResponse>(`/analytics/users/activity?${buildQueryString({ range, granularity })}`),
  // Backend GET /analytics/users/heatmap takes no query params and returns a
  // chart payload, not a flat hour/day grid.
  getUserHeatmap: () => apiFetch<ChartData>('/analytics/users/heatmap'),

  // Module & Feature Usage
  getModuleUsageAnalytics: () => apiFetch<ChartData>('/analytics/usage/modules'),
  getFeatureAdoption: () => apiFetch<ChartData>('/analytics/usage/features'),

  // Financial Metrics
  // No `cac` and no `churnRate`: neither has ever existed on FinancialMetrics.
  getFinancialMetrics: (params?: DateRangeParams) =>
    apiFetch<FinancialMetrics>(`/analytics/financial?${buildQueryString(params || {})}`),
  getFinancialRevenue: (period = '12m') =>
    apiFetch<TimeSeriesData>(`/analytics/financial/revenue?period=${period}`),
  getFinancialByPlan: () => apiFetch<ChartData>('/analytics/financial/by-plan'),

  // System Metrics (Analytics)
  // No cpuUsage/memoryUsage/diskUsage: admin-api has no host-metrics source and
  // has never returned those fields. Every SystemMetrics field is `number|null`
  // because none of them is measured today (APA-131).
  getSystemAnalytics: () => apiFetch<AnalyticsSystemMetrics>('/analytics/system'),
  getSystemApiCallsTrend: (period = '24h') =>
    apiFetch<TimeSeriesData>(`/analytics/system/api-calls?period=${period}`),
  getSystemErrorsTrend: (period = '24h') =>
    apiFetch<TimeSeriesData>(`/analytics/system/errors?period=${period}`),

  // Snapshots - backend requires mandatory 'category' param plus startDate/endDate
  getAnalyticsSnapshots: (params: { category: 'tenant' | 'user' | 'financial' | 'system' | 'usage'; startDate: string; endDate: string; snapshotType?: 'daily' | 'weekly' | 'monthly' | 'yearly' }) =>
    apiFetch<AnalyticsSnapshotDto[]>(`/analytics/snapshots?${buildQueryString(params)}`),
};
