/**
 * Analytics data hooks (/dashboard/analytics).
 *
 * The module dashboards read through their own hooks (useProductionRows,
 * useControlRows, useModuleAlarms, useInbox, useRecentAudit); what stays here
 * is what the analytics page reads: KPI totals, harvest statistics, batches,
 * sensors and their latest readings.
 *
 * Backend resolver'lar:
 *   - tenantStats  (auth-service TenantResolver)
 *   - farms        (farm-service FarmResolver)
 *   - alertHistory (alert-engine AlertResolver)
 *   - harvestStatistics / batches (farm-service)
 *   - sensors / latestReadingsBatch (sensor-service)
 */

import { useQuery } from '@tanstack/react-query';
import { graphqlClient, useAuth, createTenantQueryKey } from '@aquaculture/shared-ui';

// ============================================================================
// Types
// ============================================================================

/** tenantStats query response */
export interface TenantStatsData {
  totalUsers: number;
  activeUsers: number;
  pendingUsers: number;
  inactiveUsers: number;
  totalModules: number;
  activeModules: number;
  activeSessions: number;
  monthlyGrowthPercent: number | null;
  lastActivityAt: string;
}

/** farms query -- we only need count + basic info */
export interface FarmSummary {
  id: string;
  name: string;
  isActive: boolean;
}

/** Dashboard KPI aggregate returned by useDashboardStats */
export interface DashboardKPI {
  totalFarms: number;
  activeSensors: number;
  alertsToday: number;
  productionTons: number;
  farmsTrend: number;
  sensorsTrend: number;
  alertsTrend: number;
  productionTrend: number;
  totalUsers: number;
  activeUsers: number;
}

/** Alert history entry */
export interface AlertHistoryEntry {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: string;
  message: string;
  triggeredAt: string;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  farmId: string | null;
  pondId: string | null;
  sensorId: string | null;
}

/** Harvest monthly statistics from farm-service */
export interface HarvestMonthlyStats {
  year: number;
  month: number;
  count: number;
  totalBiomass: number;
  totalRevenue: number;
}

/** Harvest summary from farm-service */
export interface HarvestSummaryData {
  totalHarvests: number;
  totalQuantityHarvested: number;
  totalBiomassKg: number;
  totalRevenue: number;
  averageWeight: number;
  averagePricePerKg: number;
}

/** Harvest trends */
export interface HarvestTrendsData {
  avgBiomassPerHarvest: number;
  avgQuantityPerHarvest: number;
  harvestsPerMonth: number;
}

/** Harvest statistics response */
export interface HarvestStatisticsData {
  tenantId: string;
  startDate: string;
  endDate: string;
  summary: HarvestSummaryData;
  byMonth: HarvestMonthlyStats[];
  trends: HarvestTrendsData;
}

/** Batch summary for species distribution */
export interface BatchSummary {
  id: string;
  name: string;
  speciesId: string;
  status: string;
  initialQuantity: number;
  currentQuantity: number;
  currentAvgWeightG: number;
}

/** Sensor summary */
export interface SensorSummary {
  id: string;
  name: string;
  type: string;
  status: string;
  pondId: string | null;
  farmId: string | null;
}

/** Paginated sensor list (Query.sensors -> SensorListType). */
export interface SensorListResult {
  items: SensorSummary[];
  total: number;
}

/** Sensor reading for analytics */
export interface SensorReadingData {
  id: string;
  sensorId: string;
  timestamp: string;
  readings: {
    temperature?: number;
    ph?: number;
    dissolvedOxygen?: number;
    salinity?: number;
    ammonia?: number;
    nitrite?: number;
  };
}

// ============================================================================
// Query Keys (tenant-scoped)
// ============================================================================

/**
 * SECURITY: All dashboard query keys are tenant-scoped via createTenantQueryKey
 * to prevent cross-tenant cache leaks when switching tenants or during admin
 * impersonation. Every key starts with ['tenant', tenantId, 'dashboard', ...].
 *
 * @see FE-CRITICAL-014
 */
export const dashboardKeys = {
  all: (tenantId: string) => createTenantQueryKey(tenantId, 'dashboard'),
  stats: (tenantId: string) => [...dashboardKeys.all(tenantId), 'stats'] as const,
  harvestStats: (tenantId: string, range: string) => [...dashboardKeys.all(tenantId), 'harvestStats', range] as const,
  batches: (tenantId: string) => [...dashboardKeys.all(tenantId), 'batches'] as const,
  sensors: (tenantId: string) => [...dashboardKeys.all(tenantId), 'sensors'] as const,
  sensorReadings: (tenantId: string, ids: string[]) => [...dashboardKeys.all(tenantId), 'sensorReadings', ...ids] as const,
};

// ============================================================================
// GraphQL Queries
// ============================================================================

const TENANT_STATS_QUERY = `
  query TenantStats {
    tenantStats {
      totalUsers
      activeUsers
      pendingUsers
      inactiveUsers
      totalModules
      activeModules
      activeSessions
      monthlyGrowthPercent
      lastActivityAt
    }
  }
`;

const FARMS_COUNT_QUERY = `
  query FarmsCount {
    farms(limit: 200) {
      id
      name
      isActive
    }
  }
`;

const ALERT_HISTORY_QUERY = `
  query AlertHistory($limit: Int) {
    alertHistory(limit: $limit, page: 1) {
      id
      ruleId
      ruleName
      severity
      message
      triggeredAt
      acknowledged
      acknowledgedAt
      acknowledgedBy
      farmId
      pondId
      sensorId
    }
  }
`;

const HARVEST_STATISTICS_QUERY = `
  query HarvestStatistics($dateRange: DateRangeInput!) {
    harvestStatistics(dateRange: $dateRange) {
      tenantId
      startDate
      endDate
      summary {
        totalHarvests
        totalQuantityHarvested
        totalBiomassKg
        totalRevenue
        averageWeight
        averagePricePerKg
      }
      byMonth {
        year
        month
        count
        totalBiomass
        totalRevenue
      }
      trends {
        avgBiomassPerHarvest
        avgQuantityPerHarvest
        harvestsPerMonth
      }
    }
  }
`;

const BATCHES_QUERY = `
  query BatchesList($limit: Int) {
    batches(limit: $limit) {
      items {
        id
        name
        speciesId
        status
        initialQuantity
        currentQuantity
        currentAvgWeightG
      }
      total
    }
  }
`;

const SENSORS_LIST_QUERY = `
  query SensorsList($limit: Int) {
    sensors(pagination: { limit: $limit }) {
      items {
        id
        name
        type
        status: registrationStatus
        pondId
        farmId
      }
      total
    }
  }
`;

const LATEST_READINGS_BATCH_QUERY = `
  query LatestReadingsBatch($sensorIds: [ID!]!) {
    latestReadingsBatch(sensorIds: $sensorIds) {
      id
      sensorId
      timestamp
      readings {
        temperature
        ph
        dissolvedOxygen
        salinity
        ammonia
        nitrite
      }
    }
  }
`;

// ============================================================================
// Hooks
// ============================================================================

/**
 * Dashboard KPI metrikleri:
 * tenantStats + farms count + alert count birlestirir.
 * staleTime: 60 saniye
 */
export function useDashboardStats() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: dashboardKeys.stats(tenantId!),
    enabled: !!tenantId,
    staleTime: 60_000,
    queryFn: async (): Promise<DashboardKPI> => {
      // Build date range for harvest statistics: current year
      const now = new Date();
      const yearStart = new Date(now.getFullYear(), 0, 1);
      const dateRange = {
        startDate: yearStart.toISOString(),
        endDate: now.toISOString(),
      };

      // Build date range for previous period (for trend calculation)
      const prevYearStart = new Date(now.getFullYear() - 1, 0, 1);
      const prevYearEnd = new Date(now.getFullYear() - 1, 11, 31);
      const prevDateRange = {
        startDate: prevYearStart.toISOString(),
        endDate: prevYearEnd.toISOString(),
      };

      // Paralel fetch -- all queries at once
      const [tenantResult, farmsResult, alertResult, harvestResult, prevHarvestResult, sensorsResult] = await Promise.all([
        graphqlClient.request<{ tenantStats: TenantStatsData }>(TENANT_STATS_QUERY),
        graphqlClient.request<{ farms: FarmSummary[] }>(FARMS_COUNT_QUERY),
        graphqlClient.request<{ alertHistory: AlertHistoryEntry[] }>(
          ALERT_HISTORY_QUERY,
          { limit: 100 },
        ),
        graphqlClient.request<{ harvestStatistics: HarvestStatisticsData }>(
          HARVEST_STATISTICS_QUERY,
          { dateRange },
        ).catch(() => null),
        graphqlClient.request<{ harvestStatistics: HarvestStatisticsData }>(
          HARVEST_STATISTICS_QUERY,
          { dateRange: prevDateRange },
        ).catch(() => null),
        // TODO: Consider server-side pagination if >200 sensors is a real use-case
        graphqlClient.request<{ sensors: SensorListResult }>(
          SENSORS_LIST_QUERY,
          { limit: 200 },
        ).catch(() => null),
      ]);

      const stats = tenantResult.tenantStats;
      const farms = farmsResult.farms;

      // Count today's alerts
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const alertsToday = alertResult.alertHistory.filter(
        (a) => new Date(a.triggeredAt) >= todayStart,
      ).length;

      // Count yesterday's alerts for trend
      const yesterdayStart = new Date(todayStart);
      yesterdayStart.setDate(yesterdayStart.getDate() - 1);
      const alertsYesterday = alertResult.alertHistory.filter(
        (a) => {
          const d = new Date(a.triggeredAt);
          return d >= yesterdayStart && d < todayStart;
        },
      ).length;
      const alertsTrend = alertsYesterday > 0
        ? ((alertsToday - alertsYesterday) / alertsYesterday) * 100
        : 0;

      // Production tons from harvest statistics
      const productionTons = harvestResult?.harvestStatistics?.summary?.totalBiomassKg
        ? harvestResult.harvestStatistics.summary.totalBiomassKg / 1000
        : 0;

      // Production trend: compare current vs previous year biomass
      const prevBiomass = prevHarvestResult?.harvestStatistics?.summary?.totalBiomassKg ?? 0;
      const currentBiomass = harvestResult?.harvestStatistics?.summary?.totalBiomassKg ?? 0;
      const productionTrend = prevBiomass > 0
        ? ((currentBiomass - prevBiomass) / prevBiomass) * 100
        : 0;

      // Active sensors count and trend
      const activeSensors = sensorsResult?.sensors
        ? sensorsResult.sensors.items.filter((s) => s.status === 'ACTIVE' || s.status === 'active').length
        : stats.activeModules;
      const totalSensors = sensorsResult?.sensors?.total ?? 0;
      const sensorsTrend = totalSensors > 0
        ? (activeSensors / totalSensors) * 100 - 100
        : 0;

      return {
        totalFarms: farms.length,
        activeSensors,
        alertsToday,
        productionTons: Math.round(productionTons * 10) / 10,
        farmsTrend: stats.monthlyGrowthPercent ?? 0,
        sensorsTrend: Math.round(sensorsTrend * 10) / 10,
        alertsTrend: Math.round(alertsTrend * 10) / 10,
        productionTrend: Math.round(productionTrend * 10) / 10,
        totalUsers: stats.totalUsers,
        activeUsers: stats.activeUsers,
      };
    },
  });
}

// ============================================================================
// Analytics Hooks
// ============================================================================

/** Date range helper: returns {startDate, endDate} ISO strings based on range key */
function getDateRangeForAnalytics(range: string): { startDate: string; endDate: string } {
  const now = new Date();
  const end = now.toISOString();
  let start: Date;

  switch (range) {
    case '7days':
      start = new Date(now);
      start.setDate(start.getDate() - 7);
      break;
    case '30days':
      start = new Date(now);
      start.setDate(start.getDate() - 30);
      break;
    case '90days':
      start = new Date(now);
      start.setDate(start.getDate() - 90);
      break;
    case 'year':
      start = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      start = new Date(now);
      start.setDate(start.getDate() - 30);
  }

  return { startDate: start.toISOString(), endDate: end };
}

/**
 * Harvest statistics for production trend chart.
 * Returns monthly harvest data with biomass and revenue.
 * staleTime: 120 seconds (analytics data changes infrequently)
 */
export function useHarvestStatistics(dateRangeKey: string) {
  const { tenantId } = useAuth();
  const { startDate, endDate } = getDateRangeForAnalytics(dateRangeKey);

  return useQuery({
    queryKey: dashboardKeys.harvestStats(tenantId!, dateRangeKey),
    enabled: !!tenantId,
    staleTime: 120_000,
    queryFn: async (): Promise<HarvestStatisticsData> => {
      const result = await graphqlClient.request<{
        harvestStatistics: HarvestStatisticsData;
      }>(HARVEST_STATISTICS_QUERY, {
        dateRange: { startDate, endDate },
      });

      return result.harvestStatistics;
    },
  });
}

/**
 * Batches for species distribution chart.
 * Returns active batches with species grouping.
 * staleTime: 120 seconds
 */
export function useBatchesSummary() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: dashboardKeys.batches(tenantId!),
    enabled: !!tenantId,
    staleTime: 120_000,
    queryFn: async (): Promise<BatchSummary[]> => {
      // TODO: Consider server-side pagination if >200 batches is a real use-case
      const result = await graphqlClient.request<{
        batches: { items: BatchSummary[]; total: number };
      }>(BATCHES_QUERY, { limit: 200 });

      return result.batches.items;
    },
  });
}

/**
 * Sensors list for analytics.
 * staleTime: 120 seconds
 */
export function useSensorsList() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: dashboardKeys.sensors(tenantId!),
    enabled: !!tenantId,
    staleTime: 120_000,
    queryFn: async (): Promise<SensorSummary[]> => {
      const result = await graphqlClient.request<{
        sensors: SensorListResult;
      }>(SENSORS_LIST_QUERY, { limit: 100 });

      return result.sensors.items;
    },
  });
}

/**
 * Latest sensor readings for multiple sensors (batch query).
 * Used by analytics page for sensor trend chart.
 * staleTime: 30 seconds
 */
export function useLatestSensorReadings(sensorIds: string[]) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: dashboardKeys.sensorReadings(tenantId!, sensorIds),
    staleTime: 30_000,
    enabled: !!tenantId && sensorIds.length > 0,
    queryFn: async (): Promise<SensorReadingData[]> => {
      const result = await graphqlClient.request<{
        latestReadingsBatch: SensorReadingData[];
      }>(LATEST_READINGS_BATCH_QUERY, { sensorIds });

      return result.latestReadingsBatch;
    },
  });
}
