/**
 * Analytics browser types are projections of the generated admin route DAG.
 * The executable backend response contracts remain the only shape authority.
 */

import type { AdminApiRouteQuery, AdminApiRouteResponse } from './generated/admin-route-contracts';

export type DashboardSummary = AdminApiRouteResponse<'GET /analytics/dashboard'>;
export type RevenueAnalytics = AdminApiRouteResponse<'GET /analytics/revenue'>;

type AnalyticsTrendQuery = AdminApiRouteQuery<'GET /analytics/tenants/growth'>;

export type AnalyticsRange = NonNullable<AnalyticsTrendQuery['range']>;
export type AnalyticsGranularity = NonNullable<AnalyticsTrendQuery['granularity']>;

export interface TimeSeriesPoint {
  readonly date: string;
  readonly value: number;
}

export type TimeSeriesResponse = Extract<
  AdminApiRouteResponse<'GET /analytics/tenants/growth'>,
  { readonly range: AnalyticsRange }
>;
