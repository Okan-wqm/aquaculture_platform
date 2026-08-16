/**
 * Analytics API
 */

import { apiFetch } from '../http-client';
import type {
  PaginationParams,
  DateRangeParams,
  AnalyticsGranularity,
  AnalyticsRange,
} from '../types';
import {
  ADMIN_API_ROUTES,
  type AdminApiRouteQuery,
} from '../types/generated/admin-route-contracts';

type AnalyticsSystemTrendQuery = AdminApiRouteQuery<'GET /analytics/system/api-calls'>;
type AnalyticsSnapshotQuery = AdminApiRouteQuery<'GET /analytics/snapshots'>;

export const analyticsApi = {
  // Dashboard
  getDashboardSummary: () => apiFetch(ADMIN_API_ROUTES['GET /analytics/dashboard']),
  getKpiComparisons: (period?: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /analytics/kpi-comparisons']),

  // Tenant Metrics
  getTenantMetrics: (params?: PaginationParams & { sortBy?: string; order?: 'asc' | 'desc' }) =>
    apiFetch(ADMIN_API_ROUTES['GET /analytics/tenants']),
  getTenantGrowthTrend: (range: AnalyticsRange = '30d', granularity?: AnalyticsGranularity) =>
    apiFetch(ADMIN_API_ROUTES['GET /analytics/tenants/growth'], {
      query: { range: range, granularity: granularity },
    }),

  // Revenue Analytics
  getRevenueAnalytics: (params?: DateRangeParams) =>
    apiFetch(ADMIN_API_ROUTES['GET /analytics/revenue']),
  getRevenueByPlan: (params?: DateRangeParams) =>
    apiFetch(ADMIN_API_ROUTES['GET /analytics/revenue/by-plan']),
  getRevenueTrend: (range: AnalyticsRange = '30d', granularity?: AnalyticsGranularity) =>
    apiFetch(ADMIN_API_ROUTES['GET /analytics/revenue/trend'], {
      query: { range: range, granularity: granularity },
    }),

  // Usage Analytics
  getUsageAnalytics: (params?: DateRangeParams) =>
    apiFetch(ADMIN_API_ROUTES['GET /analytics/usage']),

  // Churn Analytics
  getTenantChurn: (period = '30d') =>
    apiFetch(ADMIN_API_ROUTES['GET /analytics/tenants/churn'], {
      query: { period: period },
    }),

  // User Metrics
  getUserMetrics: (params?: DateRangeParams) => apiFetch(ADMIN_API_ROUTES['GET /analytics/users']),
  getUserActivity: (range: AnalyticsRange = '30d', granularity?: AnalyticsGranularity) =>
    apiFetch(ADMIN_API_ROUTES['GET /analytics/users/activity'], {
      query: { range: range, granularity: granularity },
    }),
  // Fix: backend GET /analytics/users/heatmap takes no query params
  getUserHeatmap: (_params?: DateRangeParams) =>
    apiFetch(ADMIN_API_ROUTES['GET /analytics/users/heatmap']),

  // Module & Feature Usage
  getModuleUsageAnalytics: () => apiFetch(ADMIN_API_ROUTES['GET /analytics/usage/modules']),
  getFeatureAdoption: () => apiFetch(ADMIN_API_ROUTES['GET /analytics/usage/features']),

  // Financial Metrics
  getFinancialMetrics: (params?: DateRangeParams) =>
    apiFetch(ADMIN_API_ROUTES['GET /analytics/financial']),
  getFinancialRevenue: (period = '12m') =>
    apiFetch(ADMIN_API_ROUTES['GET /analytics/financial/revenue'], {
      query: { period: period },
    }),
  getFinancialByPlan: () => apiFetch(ADMIN_API_ROUTES['GET /analytics/financial/by-plan']),

  // System Metrics (Analytics)
  getSystemAnalytics: () => apiFetch(ADMIN_API_ROUTES['GET /analytics/system']),
  getSystemApiCallsTrend: (period: AnalyticsSystemTrendQuery['period'] = 'day') =>
    apiFetch(ADMIN_API_ROUTES['GET /analytics/system/api-calls'], {
      query: { period: period },
    }),
  getSystemErrorsTrend: (period: AnalyticsSystemTrendQuery['period'] = 'day') =>
    apiFetch(ADMIN_API_ROUTES['GET /analytics/system/errors'], {
      query: { period: period },
    }),

  // Snapshots - backend requires mandatory 'category' param plus startDate/endDate
  getAnalyticsSnapshots: (params: AnalyticsSnapshotQuery) =>
    apiFetch(ADMIN_API_ROUTES['GET /analytics/snapshots'], {
      query: params,
    }),
};
