/**
 * Analytics contracts.
 *
 * The response shapes below are GENERATED from the backend types
 * (`tools/codegen/admin-contracts/manifest.ts`) and re-exported here so the
 * panel's import sites do not move. They were hand-declared until this file
 * stopped owning them: ten of them had drifted — `getKpiComparisons` was typed
 * as a list against a record, `getSystemAnalytics` invented cpu/memory/disk,
 * `getFinancialMetrics` invented cac/churnRate — and none of it was visible to
 * the compiler, because `apiFetch<T>`'s generic is an assertion, not a check.
 *
 * `AnalyticsSystemMetrics` is the backend's `SystemMetrics`, aliased because
 * `types/system.ts` already owns that name for a different (platform-health)
 * shape. The alias lives here rather than in the backend so the collision is
 * resolved where it exists.
 */
// Imported so the composite shapes further down can reference them, and
// re-exported so every existing import site keeps working unchanged.
import type {
  TenantMetrics,
  UserMetrics,
  FinancialMetrics,
  AnalyticsSystemMetrics,
  ModuleUsageStats,
  UsageMetrics,
  ChartData,
  ComparisonDto,
  TimeSeriesPoint,
  TimeSeriesResponse,
  TimeSeriesData,
  DashboardSummary,
} from './generated/admin-contracts';

export type {
  TenantMetrics,
  UserMetrics,
  FinancialMetrics,
  AnalyticsSystemMetrics,
  ModuleUsageStats,
  UsageMetrics,
  ChartData,
  ComparisonDto,
  TimeSeriesPoint,
  TimeSeriesResponse,
  TimeSeriesData,
  DashboardSummary,
};

/**
 * `GET /analytics/kpi-comparisons` — keyed BY METRIC NAME, not a list.
 *
 * It was typed `KpiComparison[]` (with a `metric` field that does not exist on
 * the wire), so the natural `.map(...)` a consumer would write throws
 * `is not a function` on the object it actually receives (APA-149). A metric
 * with no comparison is ABSENT from the record rather than present with zeroes
 * — that is how the endpoint says "no baseline" (APA-135).
 */
export type KpiComparisons = Record<string, ComparisonDto>;

export type AnalyticsRange = '7d' | '30d' | '90d' | '1y';
export type AnalyticsGranularity = 'day' | 'week' | 'month';

/**
 * `GET /analytics/snapshots` — the persisted snapshot rows, verbatim.
 *
 * It was typed `{ id, date, metrics }`; `date` has never existed (the column is
 * `snapshotDate`) and the row carries a category and a snapshot type that a
 * consumer needs in order to know what `metrics` even is (APA-149).
 */
export interface AnalyticsSnapshotDto {
  id: string;
  snapshotType: 'daily' | 'weekly' | 'monthly' | 'yearly';
  category: 'tenant' | 'user' | 'financial' | 'system' | 'usage';
  /** Calendar date, 'YYYY-MM-DD' — a `date` column, never a timestamp. */
  snapshotDate: string;
  metrics:
    | TenantMetrics
    | UserMetrics
    | FinancialMetrics
    | AnalyticsSystemMetrics
    | UsageMetrics;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface RevenueAnalytics {
  totalRevenue: number;
  mrr: number;
  arr: number;
  averageRevenuePerTenant: number;
  revenueByPlan: Array<{ plan: string; revenue: number; percentage: number }>;
  revenueByMonth: Array<{ month: string; revenue: number }>;
}

/** `GET /analytics/revenue/by-plan`. */
export interface RevenueByPlanAnalytics {
  plan: string;
  revenue: number;
  tenantCount: number;
  percentage: number;
  avgRevenuePerTenant: number;
}
