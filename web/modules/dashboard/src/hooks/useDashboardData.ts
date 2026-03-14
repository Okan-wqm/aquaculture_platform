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

import { useQuery } from '@tanstack/react-query';
import { graphqlClient } from '@aquaculture/shared-ui';

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
  ph: number | null;
  ammonia: number | null;
  nitrite: number | null;
  salinity: number | null;
  status: string;
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

// ============================================================================
// Query Keys
// ============================================================================

export const dashboardKeys = {
  all: ['dashboard'] as const,
  stats: () => [...dashboardKeys.all, 'stats'] as const,
  tasks: () => [...dashboardKeys.all, 'tasks'] as const,
  taskStats: () => [...dashboardKeys.all, 'taskStats'] as const,
  alerts: () => [...dashboardKeys.all, 'alerts'] as const,
  storage: () => [...dashboardKeys.all, 'storage'] as const,
  waterQuality: () => [...dashboardKeys.all, 'waterQuality'] as const,
  recentActivity: () => [...dashboardKeys.all, 'recentActivity'] as const,
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
    farms(limit: 1000) {
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
      ph
      ammonia
      nitrite
      salinity
      status
      measuredAt
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
  return useQuery({
    queryKey: dashboardKeys.stats(),
    staleTime: 60_000,
    queryFn: async (): Promise<DashboardKPI> => {
      // Paralel fetch -- all three queries at once
      const [tenantResult, farmsResult, alertResult] = await Promise.all([
        graphqlClient.request<{ tenantStats: TenantStatsData }>(TENANT_STATS_QUERY),
        graphqlClient.request<{ farms: FarmSummary[] }>(FARMS_COUNT_QUERY),
        graphqlClient.request<{ alertHistory: AlertHistoryEntry[] }>(
          ALERT_HISTORY_QUERY,
          { limit: 100 },
        ),
      ]);

      const stats = tenantResult.tenantStats;
      const farms = farmsResult.farms;

      // Count today's alerts
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const alertsToday = alertResult.alertHistory.filter(
        (a) => new Date(a.triggeredAt) >= todayStart,
      ).length;

      return {
        totalFarms: farms.length,
        activeSensors: stats.activeModules, // Best available metric
        alertsToday,
        productionTons: 0, // Will be enriched when harvest data is fetched
        farmsTrend: stats.monthlyGrowthPercent ?? 0,
        sensorsTrend: 0,
        alertsTrend: 0,
        productionTrend: 0,
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
  return useQuery({
    queryKey: dashboardKeys.tasks(),
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
  return useQuery({
    queryKey: dashboardKeys.taskStats(),
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
  return useQuery({
    queryKey: dashboardKeys.alerts(),
    staleTime: 30_000,
    queryFn: async () => {
      const result = await graphqlClient.request<{
        alertHistory: AlertHistoryEntry[];
      }>(ALERT_HISTORY_QUERY, { limit: 100 });

      const alerts = result.alertHistory;

      // Build summary counts from unacknowledged alerts
      const activeAlerts = alerts.filter((a) => !a.acknowledged);
      const summary: AlertSummaryData = {
        total: activeAlerts.length,
        critical: activeAlerts.filter((a) => a.severity === 'CRITICAL').length,
        high: activeAlerts.filter((a) => a.severity === 'HIGH').length,
        medium: activeAlerts.filter((a) => a.severity === 'MEDIUM').length,
        low: activeAlerts.filter((a) => a.severity === 'LOW').length,
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
  return useQuery({
    queryKey: dashboardKeys.storage(),
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
  return useQuery({
    queryKey: dashboardKeys.waterQuality(),
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
  return useQuery({
    queryKey: [...dashboardKeys.recentActivity(), limit],
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

      // Map alert history to activities
      for (const alert of alertResult.alertHistory) {
        const severityMap: Record<string, RecentActivity['severity']> = {
          CRITICAL: 'error',
          HIGH: 'warning',
          MEDIUM: 'warning',
          LOW: 'info',
          INFO: 'info',
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
