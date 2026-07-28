/**
 * Analytics domain types — the wire shapes of `/analytics/*`.
 *
 * # Why these are declared here and not imported
 *
 * The admin panel is a federated web remote and cannot import a backend
 * `@platform/*` / `@aquaculture/*` library (the same constraint documented on
 * `types/users.ts`, `types/billing.ts`, `types/tenant.ts` and
 * `api/messaging.ts`, and enforced by this module's tsconfig, which resolves
 * only `@/*` and `@aquaculture/shared-ui`). So the contract is DECLARED here
 * and PINNED to the backend by `tests/invariants/admin-panel-analytics-contract.spec.ts`,
 * the same tier-3 pattern used for the audit-severity and data-request-status
 * vocabularies.
 *
 * # What went wrong before (APA-149)
 *
 * Ten of these shapes were authored aspirationally and had never matched what
 * the backend returns: `getKpiComparisons` was typed `KpiComparison[]` against a
 * `Record<string, ComparisonDto>` (so `.map` on it throws), `getSystemAnalytics`
 * invented `cpuUsage`/`memoryUsage`/`diskUsage`, `getFinancialMetrics` invented
 * `cac`/`churnRate`, six endpoints returning `ChartData` or `TimeSeriesData`
 * were typed as flat arrays, and `TenantMetrics` named a per-tenant row shape
 * that no endpoint has ever produced — colliding with the aggregate the backend
 * actually sends and hiding the drift behind a familiar name. None was reachable
 * from a shipped page, which is the only reason nothing had crashed; but they
 * were exported, type-checked FALSE contracts, and a compiler that lies is worse
 * than no types at all.
 *
 * The metric shapes below are the ones `DashboardSummary` already carried
 * correctly, extracted so the per-metric endpoints share one declaration with it
 * instead of each restating it.
 */

/** Tenant counts and rates — `GET /analytics/tenants` and `DashboardSummary.tenants`. */
export interface TenantMetrics {
  total: number;
  active: number;
  inactive: number;
  trial: number;
  suspended: number;
  newThisMonth: number;
  // Churn has no source on this platform; "not measured" must be
  // representable rather than fabricated as 0 (APA-135).
  churnedThisMonth: number | null;
  churnRate: number | null;
  growthRate: number | null;
  byPlan: Record<string, number>;
}

/** `GET /analytics/users` and `DashboardSummary.users`. */
export interface UserMetrics {
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
}

/** `GET /analytics/financial` and `DashboardSummary.financial`. */
export interface FinancialMetrics {
  mrr: number;
  arr: number;
  arpu: number;
  arppu: number;
  ltv: number;
  totalRevenue: number;
  revenueThisMonth: number;
  // null when no baseline snapshot exists to compare against (APA-134).
  revenueGrowthRate: number | null;
  pendingPayments: number;
  overduePayments: number;
  refunds: number;
  byPlan: Record<string, number>;
  byCurrency: Record<string, number>;
}

/**
 * `GET /analytics/system` and `DashboardSummary.system`.
 *
 * Named `Analytics…` because `types/system.ts` already exports a DIFFERENT
 * `SystemMetrics` — the `/system/metrics` response with its database/platform
 * sub-objects. Two unrelated shapes under one name in one barrel is the same
 * collision that hid the `TenantMetrics` drift this finding is about (APA-149),
 * so the analytics one says which system it describes.
 *
 * Every field is `number | null` because admin-api measures none of them today;
 * `null` means "not measured" and must render as a placeholder, never as a
 * number (APA-131).
 */
export interface AnalyticsSystemMetrics {
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
}

export interface ModuleUsageStats {
  activeUsers: number;
  totalSessions: number;
  avgSessionDuration: number;
}

/**
 * `GET /analytics/usage` and `DashboardSummary.usage`.
 *
 * PRESENCE MEANS MEASURED: a `moduleUsage` or `featureAdoption` key appears only
 * when it was read from a real source, so an empty map means "not instrumented"
 * rather than "all zero" (APA-133). Consumers must skip absent keys, never
 * render them as 0.
 */
export interface UsageMetrics {
  moduleUsage: Record<string, ModuleUsageStats>;
  featureAdoption: Record<string, number>;
  topFeatures: Array<{ feature: string; usage: number }>;
  peakHours: number[];
  avgDailyActiveUsers: number;
}

/** A Chart.js-shaped payload — what every `/analytics/*` chart endpoint returns. */
export interface ChartData {
  labels: string[];
  datasets: Array<{
    label: string;
    data: number[];
    backgroundColor?: string | string[];
    borderColor?: string;
  }>;
}

export interface DashboardSummary {
  tenants: TenantMetrics;
  users: UserMetrics;
  financial: FinancialMetrics;
  system: AnalyticsSystemMetrics;
  usage: UsageMetrics;
  generatedAt: string;
  unavailable?: string[];
}

/** One metric's period-over-period comparison. */
export interface ComparisonDto {
  current: number;
  previous: number;
  change: number;
  changePercent: number;
  trend: 'up' | 'down' | 'stable';
}

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

/**
 * A single named series — what the period/dataPoints trend endpoints return.
 *
 * Distinct from `TimeSeriesResponse`, which the RANGE-based endpoints return
 * with its own range/granularity/source envelope. Six endpoints were typed as
 * flat arrays of ad-hoc row objects instead (APA-149).
 */
export interface TimeSeriesData {
  label: string;
  data: TimeSeriesPoint[];
  color?: string;
}

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
