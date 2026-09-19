/**
 * Performance Dashboard Page
 *
 * Enterprise-grade performance monitoring dashboard with real API integration.
 * Displays real-time system metrics, service health, and performance trends.
 */

import React, { useMemo, useState } from 'react';
import {
  Card,
  Button,
  Badge,
  DataTable,
  LineChart,
  type DataTableColumn,
  PageHeader,
} from '@aquaculture/shared-ui';

import { systemSettingsApi } from '../../services/adminApi';
import { adminKeys, useAdminQuery } from '../../hooks';
import { QueryFailureNotice } from '../../components';
import type {
  DatabasePerformance,
  InfrastructureMetrics,
  PerformanceApplicationMetrics,
} from '../../services/types';
import { CircleAlert, Cpu, RefreshCw, Server, TriangleAlert, Zap } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

/** One row of the service breakdown table (derived from the metrics payload). */
interface ServiceBreakdownRow {
  service: string;
  avgResponseTime: number;
  errorRate: number;
  requestCount: number;
}

interface ServiceHealth {
  name: string;
  status: 'healthy' | 'warning' | 'critical';
  avgResponseTime: number;
  errorRate: number;
  requestCount: number;
}

/**
 * The selectable windows, as DURATIONS.
 *
 * They used to be `{ start, end }` pairs stamped when the option list was
 * built, so the window an auto-refresh re-requested was the one selected
 * minutes earlier — "Son 5 Dakika" kept reporting the same five minutes while
 * the clock moved. The window is computed at fetch time now, from the duration.
 */
const TIME_RANGES = [
  { label: 'Son 5 Dakika', value: '5m', durationMs: 5 * 60 * 1000 },
  { label: 'Son 15 Dakika', value: '15m', durationMs: 15 * 60 * 1000 },
  { label: 'Son 1 Saat', value: '1h', durationMs: 60 * 60 * 1000 },
  { label: 'Son 6 Saat', value: '6h', durationMs: 6 * 60 * 60 * 1000 },
  { label: 'Son 24 Saat', value: '24h', durationMs: 24 * 60 * 60 * 1000 },
] as const;

type TimeRangeValue = (typeof TIME_RANGES)[number]['value'];

const DEFAULT_RANGE: TimeRangeValue = '1h';

const REFRESH_INTERVAL_MS = 30_000;

// ============================================================================
// Component
// ============================================================================

/** Compact HH:MM label for trend x-axes. */
const formatTrendLabel = (timestamp: string): string => {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? timestamp
    : date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
};

/** What a card shows for a value the platform did not measure. */
const UNKNOWN = '\u2014';

/**
 * Render a measurement, or an em dash when there is none.
 *
 * A dash reads as "we do not know". A zero reads as "we measured, and it is
 * zero" — which is what this page said about an unreachable database, an
 * unreadable disk and a health score assembled from no snapshot at all
 * (ADMIN-HIGH-014, ADMIN-HIGH-123).
 */
function formatMetric(value: number | null | undefined, suffix = '', digits?: number): string {
  if (value === null || value === undefined) return UNKNOWN;
  return `${digits === undefined ? Math.round(value) : value.toFixed(digits)}${suffix}`;
}

/**
 * Threshold colouring for a value that may not exist.
 *
 * An unmeasured value is neutral: it has not breached anything, and colouring
 * it green would be the same claim the numbers themselves used to make.
 */
const getHealthColor = (
  value: number | null | undefined,
  thresholds: { warning: number; critical: number },
  inverse = false,
): string => {
  if (value === null || value === undefined) return 'text-gray-400 dark:text-gray-500';
  if (inverse) {
    if (value <= thresholds.critical) return 'text-error-600 dark:text-error-400';
    if (value <= thresholds.warning) return 'text-warning-600 dark:text-warning-400';
    return 'text-success-600 dark:text-success-400';
  }
  if (value >= thresholds.critical) return 'text-error-600 dark:text-error-400';
  if (value >= thresholds.warning) return 'text-warning-600 dark:text-warning-400';
  return 'text-success-600 dark:text-success-400';
};

const getProgressColor = (
  value: number | null | undefined,
  thresholds: { warning: number; critical: number },
): string => {
  if (value === null || value === undefined) return 'bg-gray-300';
  if (value >= thresholds.critical) return 'bg-error-500';
  if (value >= thresholds.warning) return 'bg-warning-500';
  return 'bg-success-500';
};

export const PerformanceDashboardPage: React.FC = () => {
  const [rangeValue, setRangeValue] = useState<TimeRangeValue>(DEFAULT_RANGE);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const range = TIME_RANGES.find((entry) => entry.value === rangeValue) ?? TIME_RANGES[2];

  // ============================================================================
  // Data Loading — three independent reads (ADMIN-HIGH-121)
  //
  // They used to be one `Promise.all`, so an unreachable infrastructure probe
  // blanked the whole page including the dashboard that had answered, and a
  // failure of any one of them reported the same single sentence. Three keyed
  // queries fail independently, each says which one failed, and `refetchInterval`
  // replaces a `setInterval` that ran a fetch the page could not cancel.
  // ============================================================================

  const refetchInterval = autoRefresh ? REFRESH_INTERVAL_MS : false;

  const dashboardQuery = useAdminQuery(
    [...adminKeys.system.performance(), 'dashboard', rangeValue],
    ({ signal }) => {
      const end = new Date();
      const start = new Date(end.getTime() - range.durationMs);
      return systemSettingsApi.getPerformanceDashboard(
        { startDate: start.toISOString(), endDate: end.toISOString() },
        signal,
      );
    },
    { refetchInterval, staleTime: 15_000 },
  );

  const infrastructureQuery = useAdminQuery(
    [...adminKeys.system.performance(), 'infrastructure'],
    ({ signal }) => systemSettingsApi.getInfrastructureMetrics(undefined, signal),
    { refetchInterval, staleTime: 15_000 },
  );

  const databaseQuery = useAdminQuery(
    [...adminKeys.system.performance(), 'database'],
    ({ signal }) => systemSettingsApi.getDatabasePerformance(undefined, signal),
    { refetchInterval, staleTime: 15_000 },
  );

  const dashboard = dashboardQuery.data ?? null;
  const infrastructure: InfrastructureMetrics | null = infrastructureQuery.data ?? null;
  const database: DatabasePerformance | null = databaseQuery.data ?? null;
  const application: PerformanceApplicationMetrics | null =
    dashboard?.currentSnapshot?.applicationMetrics ?? null;
  const trends = dashboard?.trends ?? null;
  const alerts = dashboard?.alerts ?? [];
  const serviceBreakdown = dashboard?.serviceBreakdown ?? [];

  const queryErrors = [dashboardQuery.error, infrastructureQuery.error, databaseQuery.error];
  const hasContent = dashboard !== null || infrastructure !== null || database !== null;
  const isLoading = dashboardQuery.isPending && infrastructureQuery.isPending;

  const lastUpdated = useMemo(
    () =>
      Math.max(
        dashboardQuery.dataUpdatedAt,
        infrastructureQuery.dataUpdatedAt,
        databaseQuery.dataUpdatedAt,
      ),
    [dashboardQuery.dataUpdatedAt, infrastructureQuery.dataUpdatedAt, databaseQuery.dataUpdatedAt],
  );

  const isFetching =
    dashboardQuery.isFetching || infrastructureQuery.isFetching || databaseQuery.isFetching;

  const loadData = (): void => {
    void dashboardQuery.refetch();
    void infrastructureQuery.refetch();
    void databaseQuery.refetch();
  };

  // ============================================================================
  // Helpers
  // ============================================================================

  const getServiceStatus = (service: {
    avgResponseTime?: number;
    errorRate?: number;
  }): ServiceHealth['status'] => {
    if ((service.errorRate ?? 0) > 1 || (service.avgResponseTime ?? 0) > 500) return 'critical';
    if ((service.errorRate ?? 0) > 0.5 || (service.avgResponseTime ?? 0) > 300) return 'warning';
    return 'healthy';
  };

  const getStatusBadgeVariant = (status: ServiceHealth['status']) => {
    const variants: Record<ServiceHealth['status'], 'success' | 'warning' | 'error'> = {
      healthy: 'success',
      warning: 'warning',
      critical: 'error',
    };
    return variants[status];
  };

  const formatTimestamp = (epochMs: number): string =>
    epochMs === 0
      ? UNKNOWN
      : new Date(epochMs).toLocaleTimeString('tr-TR', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });

  // ============================================================================
  // Render - Loading State
  // ============================================================================

  if (isLoading && !hasContent) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/4" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-white dark:bg-gray-900 rounded-xl p-6 h-32" />
          ))}
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-xl p-6 h-64" />
        <div className="bg-white dark:bg-gray-900 rounded-xl p-6 h-96" />
      </div>
    );
  }

  // Nothing answered: the notice names WHICH read failed, where the page used
  // to print one sentence for all three.
  if (!hasContent) {
    return <QueryFailureNotice errors={queryErrors} hasContent={false} onRetry={loadData} />;
  }

  // ============================================================================
  // Render - Main UI
  // ============================================================================

  const serviceHealthColumns: DataTableColumn<ServiceBreakdownRow>[] = [
    {
      key: 'serviceName',
      header: 'Service Name',
      render: (_value, service) => {
        const status = getServiceStatus(service);
        return (
          <div className="flex items-center gap-3">
            <div
              className={`w-2 h-2 rounded-full ${
                status === 'healthy'
                  ? 'bg-success-500'
                  : status === 'warning'
                    ? 'bg-warning-500'
                    : 'bg-error-500'
              }`}
            />
            <span className="font-medium text-gray-900 dark:text-gray-100">{service.service}</span>
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      render: (_value, service) => {
        const status = getServiceStatus(service);
        return (
          <Badge variant={getStatusBadgeVariant(status)} size="sm">
            {status}
          </Badge>
        );
      },
    },
    {
      key: 'avgResponse',
      header: 'Avg Response',
      align: 'right',
      render: (_value, service) => (
        <>
          <span
            className={`font-medium ${getHealthColor(service.avgResponseTime ?? 0, {
              warning: 300,
              critical: 500,
            })}`}
          >
            {Math.round(service.avgResponseTime ?? 0)} ms
          </span>
        </>
      ),
    },
    {
      key: 'errorRate',
      header: 'Error Rate',
      align: 'right',
      render: (_value, service) => (
        <>
          <span
            className={`font-medium ${getHealthColor(service.errorRate ?? 0, {
              warning: 0.5,
              critical: 1,
            })}`}
          >
            {(service.errorRate ?? 0).toFixed(2)}%
          </span>
        </>
      ),
    },
    {
      key: 'requests',
      header: 'Requests',
      align: 'right',
      render: (_value, service) => (
        <span className="text-gray-900 dark:text-gray-100">
          {service.requestCount.toLocaleString()}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Performance Dashboard"
        description="Real-time sistem performans metrikleri ve servis saglik durumu"
        actions={
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-info-600 focus:ring-info-500"
              />
              Auto-refresh
            </label>
            <select
              aria-label="Time range"
              value={rangeValue}
              onChange={(e) => setRangeValue(e.target.value as TimeRangeValue)}
              className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500 focus:border-info-500"
            >
              {TIME_RANGES.map((tr) => (
                <option key={tr.value} value={tr.value}>
                  {tr.label}
                </option>
              ))}
            </select>
            <Button onClick={loadData} variant="secondary" disabled={isFetching}>
              <RefreshCw
                className={`w-5 h-5 ${isFetching ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
            </Button>
          </div>
        }
      />

      {/* Last Updated */}
      <div className="text-xs text-gray-500 dark:text-gray-400">
        Last updated: {formatTimestamp(lastUpdated)}
      </div>

      {/* Partial failure: one read failed and the others answered. The page
          used to discard the whole render in that case, so an unreachable
          infrastructure probe hid a dashboard that had loaded (ADMIN-HIGH-121). */}
      <QueryFailureNotice errors={queryErrors} hasContent={hasContent} onRetry={loadData} />

      {/* Alerts Banner */}
      {alerts.length > 0 && (
        <Card className="border-l-4 border-warning-400 bg-warning-50 dark:bg-warning-900/20">
          <div className="p-4">
            <h3 className="font-semibold text-warning-800 dark:text-warning-200 mb-2 flex items-center gap-2">
              <TriangleAlert className="w-5 h-5" aria-hidden="true" />
              Active Performance Alerts
            </h3>
            <div className="space-y-2">
              {alerts.map((alert, idx) => (
                <div key={idx} className="flex items-center gap-3 text-sm">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      alert.severity === 'critical' ? 'bg-error-500' : 'bg-warning-500'
                    }`}
                  />
                  <span className="text-warning-800 dark:text-warning-200">
                    {alert.metric}: {alert.currentValue}% (threshold: {alert.threshold}%)
                  </span>
                  <Badge variant={alert.severity === 'critical' ? 'error' : 'warning'} size="sm">
                    {alert.severity}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-6">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium text-gray-500 dark:text-gray-400">
              Response Time
            </div>
            <Zap className="w-5 h-5 text-info-500" aria-hidden="true" />
          </div>
          <div
            className={`text-3xl font-bold ${getHealthColor(application?.avgResponseTime, {
              warning: 300,
              critical: 500,
            })}`}
          >
            {formatMetric(application?.avgResponseTime, ' ms')}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">Ortalama yanit suresi</div>
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium text-gray-500 dark:text-gray-400">CPU Usage</div>
            <Cpu className="w-5 h-5 text-accent-500" aria-hidden="true" />
          </div>
          <div
            className={`text-3xl font-bold ${getHealthColor(infrastructure?.cpuUsage, {
              warning: 70,
              critical: 90,
            })}`}
          >
            {formatMetric(infrastructure?.cpuUsage, '%')}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">CPU kullanimi</div>
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium text-gray-500 dark:text-gray-400">Memory Usage</div>
            <Server className="w-5 h-5 text-success-500" aria-hidden="true" />
          </div>
          <div
            className={`text-3xl font-bold ${getHealthColor(infrastructure?.memoryUsage, {
              warning: 70,
              critical: 90,
            })}`}
          >
            {formatMetric(infrastructure?.memoryUsage, '%')}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">Bellek kullanimi</div>
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium text-gray-500 dark:text-gray-400">Error Rate</div>
            <CircleAlert className="w-5 h-5 text-error-500" aria-hidden="true" />
          </div>
          <div
            className={`text-3xl font-bold ${getHealthColor(application?.errorRate, {
              warning: 1,
              critical: 5,
            })}`}
          >
            {formatMetric(application?.errorRate, '%', 2)}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">Error rate</div>
        </Card>
      </div>

      {/* Overall Health Score */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Overall System Health
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Tum metriklere dayali genel saglik skoru
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* The `?? 100` that used to sit here made a platform with no
                snapshot at all report perfect health (ADMIN-HIGH-123). */}
            <div
              className={`text-5xl font-bold ${getHealthColor(
                dashboard?.healthScore,
                { warning: 85, critical: 70 },
                true,
              )}`}
            >
              {formatMetric(dashboard?.healthScore)}
            </div>
            <div className="text-gray-500 dark:text-gray-400">/100</div>
          </div>
        </div>
        <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              dashboard?.healthScore === null || dashboard?.healthScore === undefined
                ? 'bg-gray-300'
                : 'bg-success-500'
            }`}
            style={{ width: `${dashboard?.healthScore ?? 0}%` }}
          />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 pt-6 border-t">
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Throughput</div>
            <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
              {application?.throughput === null || application?.throughput === undefined
                ? UNKNOWN
                : `${application.throughput.toLocaleString()} req/s`}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Apdex Score</div>
            <div
              className={`text-xl font-bold ${getHealthColor(
                application?.apdexScore,
                { warning: 0.85, critical: 0.7 },
                true,
              )}`}
            >
              {formatMetric(application?.apdexScore, '', 2)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">DB Connections</div>
            <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
              {formatMetric(database?.activeConnections)}/{formatMetric(database?.poolSize)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Cache Hit Ratio</div>
            <div
              className={`text-xl font-bold ${getHealthColor(
                database?.cacheHitRatio,
                { warning: 95, critical: 90 },
                true,
              )}`}
            >
              {formatMetric(database?.cacheHitRatio, '%')}
            </div>
          </div>
        </div>
      </Card>

      {/* Infrastructure Metrics */}
      <Card className="p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-6">
          Infrastructure Metrics
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div>
            <div className="flex justify-between mb-2">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                CPU Usage
              </span>
              <span
                className={`text-sm font-bold ${getHealthColor(infrastructure?.cpuUsage, {
                  warning: 70,
                  critical: 90,
                })}`}
              >
                {formatMetric(infrastructure?.cpuUsage, '%')}
              </span>
            </div>
            <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${getProgressColor(
                  infrastructure?.cpuUsage,
                  { warning: 70, critical: 90 },
                )}`}
                style={{ width: `${infrastructure?.cpuUsage ?? 0}%` }}
              />
            </div>
          </div>

          <div>
            <div className="flex justify-between mb-2">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Memory Usage
              </span>
              <span
                className={`text-sm font-bold ${getHealthColor(infrastructure?.memoryUsage, {
                  warning: 70,
                  critical: 90,
                })}`}
              >
                {formatMetric(infrastructure?.memoryUsage, '%')}
              </span>
            </div>
            <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${getProgressColor(
                  infrastructure?.memoryUsage,
                  { warning: 70, critical: 90 },
                )}`}
                style={{ width: `${infrastructure?.memoryUsage ?? 0}%` }}
              />
            </div>
          </div>

          <div>
            <div className="flex justify-between mb-2">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Disk Usage
              </span>
              <span
                className={`text-sm font-bold ${getHealthColor(infrastructure?.diskUsage, {
                  warning: 70,
                  critical: 90,
                })}`}
              >
                {formatMetric(infrastructure?.diskUsage, '%')}
              </span>
            </div>
            <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${getProgressColor(
                  infrastructure?.diskUsage,
                  { warning: 70, critical: 90 },
                )}`}
                style={{ width: `${infrastructure?.diskUsage ?? 0}%` }}
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-6 pt-6 border-t">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">Network Latency</span>
            <span className="text-lg font-bold text-gray-900 dark:text-gray-100">
              {formatMetric(infrastructure?.networkLatency, ' ms')}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">Healthy Containers</span>
            <span className="text-lg font-bold text-success-600 dark:text-success-400">
              {formatMetric(infrastructure?.healthyContainers)}/
              {formatMetric(infrastructure?.containerCount)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">Avg Query Time</span>
            <span className="text-lg font-bold text-gray-900 dark:text-gray-100">
              {formatMetric(database?.avgQueryTime, ' ms')}
            </span>
          </div>
        </div>
      </Card>

      {/* Performance Trends — real charts from the fetched dashboard.trends series */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Performance Trends
          </h2>
          <span className="text-sm text-gray-500 dark:text-gray-400">{range.label}</span>
        </div>
        {!trends || trends.responseTime.length === 0 ? (
          <div className="h-48 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400">
            No trend data for this range
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div>
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Response Time (ms)
              </h3>
              <LineChart
                labels={trends.responseTime.map((point) => formatTrendLabel(point.timestamp))}
                datasets={[
                  { label: 'Response time', data: trends.responseTime.map((point) => point.value) },
                ]}
                height={180}
                className="w-full"
                showLegend={false}
              />
            </div>
            <div>
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Throughput (req/min)
              </h3>
              <LineChart
                labels={trends.throughput.map((point) => formatTrendLabel(point.timestamp))}
                datasets={[
                  { label: 'Throughput', data: trends.throughput.map((point) => point.value) },
                ]}
                height={180}
                className="w-full"
                showLegend={false}
              />
            </div>
            <div>
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Error Rate (%)
              </h3>
              <LineChart
                labels={trends.errorRate.map((point) => formatTrendLabel(point.timestamp))}
                datasets={[
                  { label: 'Error rate', data: trends.errorRate.map((point) => point.value) },
                ]}
                height={180}
                className="w-full"
                showLegend={false}
              />
            </div>
          </div>
        )}
      </Card>

      {/* Service Health Status Table */}
      <Card className="overflow-hidden">
        <div className="p-6 border-b">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Service Health Status
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Real-time servis saglik durumlari ve performans metrikleri
          </p>
        </div>
        <DataTable<ServiceBreakdownRow>
          data={serviceBreakdown}
          columns={serviceHealthColumns}
          keyExtractor={(service) => service.service}
          emptyMessage="No service data available"
          searchable={false}
          sortable={false}
          stickyHeader={false}
          className="shadow-none rounded-none"
        />
      </Card>
    </div>
  );
};

export default PerformanceDashboardPage;
