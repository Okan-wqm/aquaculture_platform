/**
 * Dashboard Data Hooks
 *
 * Tum dashboard verilerini gercek GraphQL API'den ceken custom hook'lar.
 * @tanstack/react-query ile cache, stale, retry, loading/error state yonetimi.
 *
 * Backend resolver'lar:
 *   - tenantStats  (auth-service TenantResolver)
 *   - farms        (farm-service FarmResolver)
 *   - alertHistory (alert-engine AlertResolver)
 *   - tasks / todaysTasks / taskStats (farm-service TaskResolver)
 *   - storageOverview (farm-service StorageResolver)
 *   - criticalWaterQuality (farm-service WaterQualityResolver)
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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

/** Task summary for dashboard widget */
export interface DashboardTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string;
  dueTime: string | null;
  assignedToName: string;
  category: string;
}

/** Task stats from backend */
export interface TaskStats {
  totalToday: number;
  completedToday: number;
  overdueCount: number;
  upcomingCount: number;
  completionRate: number;
  avgCompletionMinutes: number;
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

/** Alert summary counts derived from alertHistory */
export interface AlertSummaryData {
  total: number;
  critical: number;
  high: number;
  medium: number;
  warning: number;
  low: number;
}

/** Storage overview low stock alert */
export interface LowStockAlert {
  itemId: string;
  itemName: string;
  itemType: string;
  currentQuantity: number;
  minStock: number;
  unit: string;
}

/** Storage overview response */
export interface StorageOverviewData {
  totalStockValue: number;
  totalItems: number;
  lowStockAlertCount: number;
  recentMovementsCount: number;
  lowStockAlerts: LowStockAlert[];
}

/** Water quality measurement */
export interface WaterQualityMeasurement {
  id: string;
  tankId: string;
  temperature: number | null;
  dissolvedOxygen: number | null;
  pH: number | null;
  ammonia: number | null;
  nitrite: number | null;
  overallStatus: string;
  measuredAt: string;
}

/** Recent activity for the feed (derived from alert history + tasks) */
export interface RecentActivity {
  id: string;
  type: 'alert' | 'task' | 'sensor' | 'system' | 'user';
  title: string;
  description: string;
  timestamp: Date;
  user?: string;
  severity?: 'info' | 'warning' | 'error' | 'success';
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
  tasks: (tenantId: string) => [...dashboardKeys.all(tenantId), 'tasks'] as const,
  taskStats: (tenantId: string) => [...dashboardKeys.all(tenantId), 'taskStats'] as const,
  alerts: (tenantId: string) => [...dashboardKeys.all(tenantId), 'alerts'] as const,
  storage: (tenantId: string) => [...dashboardKeys.all(tenantId), 'storage'] as const,
  waterQuality: (tenantId: string) => [...dashboardKeys.all(tenantId), 'waterQuality'] as const,
  recentActivity: (tenantId: string) => [...dashboardKeys.all(tenantId), 'recentActivity'] as const,
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

const TODAYS_TASKS_QUERY = `
  query TodaysTasks {
    todaysTasks {
      id
      title
      status
      priority
      dueDate
      dueTime
      assignedToName
      category
    }
  }
`;

const TASK_STATS_QUERY = `
  query TaskStats {
    taskStats {
      totalToday
      completedToday
      overdueCount
      upcomingCount
      completionRate
      avgCompletionMinutes
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

const STORAGE_OVERVIEW_QUERY = `
  query StorageOverview {
    storageOverview {
      totalStockValue
      totalItems
      lowStockAlertCount
      recentMovementsCount
      lowStockAlerts {
        itemId
        itemName
        itemType
        currentQuantity
        minStock
        unit
      }
    }
  }
`;

const CRITICAL_WATER_QUALITY_QUERY = `
  query CriticalWaterQuality {
    criticalWaterQuality {
      id
      temperature
      dissolvedOxygen
      pH
      ammonia
      nitrite
      overallStatus
      measuredAt
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

/**
 * Bugunun gorevleri -- dashboard widget icin
 * staleTime: 30 saniye
 */
export function useTodaysTasks() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: dashboardKeys.tasks(tenantId!),
    enabled: !!tenantId,
    staleTime: 30_000,
    queryFn: async (): Promise<DashboardTask[]> => {
      const result = await graphqlClient.request<{
        todaysTasks: DashboardTask[];
      }>(TODAYS_TASKS_QUERY);

      return result.todaysTasks;
    },
  });
}

/**
 * Gorev istatistikleri
 * staleTime: 60 saniye
 */
export function useTaskStats() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: dashboardKeys.taskStats(tenantId!),
    enabled: !!tenantId,
    staleTime: 60_000,
    queryFn: async (): Promise<TaskStats> => {
      const result = await graphqlClient.request<{
        taskStats: TaskStats;
      }>(TASK_STATS_QUERY);

      return result.taskStats;
    },
  });
}

/**
 * Alert ozeti -- son alert history'den severity count'lari cikarir.
 * staleTime: 30 saniye
 */
export function useAlertSummary() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: dashboardKeys.alerts(tenantId!),
    enabled: !!tenantId,
    staleTime: 30_000,
    queryFn: async () => {
      const result = await graphqlClient.request<{
        alertHistory: AlertHistoryEntry[];
      }>(ALERT_HISTORY_QUERY, { limit: 100 });

      const alerts = result.alertHistory;

      // Build summary counts from unacknowledged alerts.
      // Backend AlertSeverity enum uses lowercase values ('critical', 'high', etc.).
      const activeAlerts = alerts.filter((a) => !a.acknowledged);
      const summary: AlertSummaryData = {
        total: activeAlerts.length,
        critical: activeAlerts.filter((a) => a.severity === 'critical').length,
        high: activeAlerts.filter((a) => a.severity === 'high').length,
        medium: activeAlerts.filter((a) => a.severity === 'medium').length,
        warning: activeAlerts.filter((a) => a.severity === 'warning').length,
        low: activeAlerts.filter((a) => a.severity === 'low').length,
      };

      return { alerts, summary };
    },
  });
}

/**
 * Stok durumu ozeti
 * staleTime: 60 saniye
 */
export function useStorageOverview() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: dashboardKeys.storage(tenantId!),
    enabled: !!tenantId,
    staleTime: 60_000,
    queryFn: async (): Promise<StorageOverviewData> => {
      const result = await graphqlClient.request<{
        storageOverview: StorageOverviewData;
      }>(STORAGE_OVERVIEW_QUERY);

      return result.storageOverview;
    },
  });
}

/**
 * Su kalitesi -- kritik durumdaki tanklar
 * staleTime: 30 saniye
 */
export function useCriticalWaterQuality() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: dashboardKeys.waterQuality(tenantId!),
    enabled: !!tenantId,
    staleTime: 30_000,
    queryFn: async (): Promise<WaterQualityMeasurement[]> => {
      const result = await graphqlClient.request<{
        criticalWaterQuality: WaterQualityMeasurement[];
      }>(CRITICAL_WATER_QUALITY_QUERY);

      return result.criticalWaterQuality;
    },
  });
}

/**
 * Son aktiviteler -- alert history + today's tasks'i birlestirerek
 * bir unified activity feed olusturur.
 * staleTime: 60 saniye
 */
export function useRecentActivity(limit = 10) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, ...dashboardKeys.recentActivity(tenantId!), limit),
    enabled: !!tenantId,
    staleTime: 60_000,
    queryFn: async (): Promise<RecentActivity[]> => {
      const [alertResult, taskResult] = await Promise.all([
        graphqlClient.request<{ alertHistory: AlertHistoryEntry[] }>(
          ALERT_HISTORY_QUERY,
          { limit: 20 },
        ),
        graphqlClient.request<{ todaysTasks: DashboardTask[] }>(
          TODAYS_TASKS_QUERY,
        ),
      ]);

      const activities: RecentActivity[] = [];

      // Map alert history to activities.
      // Backend AlertSeverity enum uses lowercase values ('critical', 'high', etc.).
      for (const alert of alertResult.alertHistory) {
        const severityMap: Record<string, RecentActivity['severity']> = {
          critical: 'error',
          high: 'warning',
          medium: 'warning',
          warning: 'warning',
          low: 'info',
          info: 'info',
        };

        activities.push({
          id: `alert-${alert.id}`,
          type: 'alert',
          title: alert.ruleName,
          description: alert.message,
          timestamp: new Date(alert.triggeredAt),
          severity: severityMap[alert.severity] ?? 'info',
        });
      }

      // Map completed tasks to activities
      for (const task of taskResult.todaysTasks) {
        const severityMap: Record<string, RecentActivity['severity']> = {
          COMPLETED: 'success',
          IN_PROGRESS: 'info',
          PENDING: 'info',
          OVERDUE: 'warning',
        };

        activities.push({
          id: `task-${task.id}`,
          type: 'task',
          title: task.title,
          description: `Gorev: ${task.category} - ${task.status}`,
          timestamp: new Date(task.dueDate),
          user: task.assignedToName,
          severity: severityMap[task.status] ?? 'info',
        });
      }

      // Sort by timestamp descending
      activities.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      return activities.slice(0, limit);
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

// ============================================================================
// Alert Mutations
// ============================================================================

const ACKNOWLEDGE_ALERT_MUTATION = `
  mutation AcknowledgeAlert($input: AcknowledgeAlertInput!) {
    acknowledgeAlert(input: $input) {
      id
      acknowledged
      acknowledgedAt
      acknowledgedBy
    }
  }
`;

const RESOLVE_ALERT_MUTATION = `
  mutation ResolveAlert($alertId: ID!) {
    resolveAlert(alertId: $alertId) {
      id
      resolved
      resolvedAt
    }
  }
`;

/**
 * Acknowledge an alert -- invalidates dashboard alert queries on success.
 */
export function useAcknowledgeAlert() {
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useMutation({
    mutationFn: async (alertId: string) => {
      return graphqlClient.request<{
        acknowledgeAlert: { id: string; acknowledged: boolean };
      }>(ACKNOWLEDGE_ALERT_MUTATION, { input: { alertId } });
    },
    onSuccess: () => {
      if (!tenantId) return;
      // Invalidate alert-related queries so the widget refreshes.
      // void: fire-and-forget background refresh (no need to block the mutation settle).
      void queryClient.invalidateQueries({ queryKey: dashboardKeys.alerts(tenantId) });
      void queryClient.invalidateQueries({ queryKey: dashboardKeys.stats(tenantId) });
      void queryClient.invalidateQueries({ queryKey: dashboardKeys.recentActivity(tenantId) });
    },
  });
}

/**
 * Resolve an alert -- invalidates dashboard alert queries on success.
 */
export function useResolveAlert() {
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useMutation({
    mutationFn: async (alertId: string) => {
      return graphqlClient.request<{
        resolveAlert: { id: string; resolved: boolean };
      }>(RESOLVE_ALERT_MUTATION, { alertId });
    },
    onSuccess: () => {
      if (!tenantId) return;
      // Invalidate alert-related queries so the widget refreshes.
      // void: fire-and-forget background refresh (no need to block the mutation settle).
      void queryClient.invalidateQueries({ queryKey: dashboardKeys.alerts(tenantId) });
      void queryClient.invalidateQueries({ queryKey: dashboardKeys.stats(tenantId) });
      void queryClient.invalidateQueries({ queryKey: dashboardKeys.recentActivity(tenantId) });
    },
  });
}
