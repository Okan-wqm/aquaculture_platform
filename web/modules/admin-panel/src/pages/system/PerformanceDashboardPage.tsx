/**
 * Performance Dashboard Page
 *
 * Enterprise-grade performance monitoring dashboard with real API integration.
 * Displays real-time system metrics, service health, and performance trends.
 */

import React, { useMemo, useState } from 'react';
import { Card, Button, Badge, LineChart } from '@aquaculture/shared-ui';

import { systemSettingsApi } from '../../services/adminApi';
import { adminKeys, useAdminQuery } from '../../hooks';
import { QueryFailureNotice } from '../../components';
import type {
  DatabasePerformance,
  InfrastructureMetrics,
  PerformanceApplicationMetrics,
} from '../../services/types';

// ============================================================================
// Types
// ============================================================================

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
  if (value === null || value === undefined) return 'text-gray-400';
  if (inverse) {
    if (value <= thresholds.critical) return 'text-red-600';
    if (value <= thresholds.warning) return 'text-yellow-600';
    return 'text-green-600';
  }
  if (value >= thresholds.critical) return 'text-red-600';
  if (value >= thresholds.warning) return 'text-yellow-600';
  return 'text-green-600';
};

const getProgressColor = (
  value: number | null | undefined,
  thresholds: { warning: number; critical: number },
): string => {
  if (value === null || value === undefined) return 'bg-gray-300';
  if (value >= thresholds.critical) return 'bg-red-500';
  if (value >= thresholds.warning) return 'bg-yellow-500';
  return 'bg-green-500';
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
    [
      dashboardQuery.dataUpdatedAt,
      infrastructureQuery.dataUpdatedAt,
      databaseQuery.dataUpdatedAt,
    ],
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

  const getServiceStatus = (service: { avgResponseTime?: number; errorRate?: number }): ServiceHealth['status'] => {
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
        <div className="h-8 bg-gray-200 rounded w-1/4" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-white rounded-xl p-6 h-32" />
          ))}
        </div>
        <div className="bg-white rounded-xl p-6 h-64" />
        <div className="bg-white rounded-xl p-6 h-96" />
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Performance Dashboard</h1>
          <p className="mt-1 text-sm text-gray-500">
            Real-time sistem performans metrikleri ve servis saglik durumu
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Auto-refresh
          </label>
          <select
            aria-label="Time range"
            value={rangeValue}
            onChange={(e) => setRangeValue(e.target.value as TimeRangeValue)}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            {TIME_RANGES.map((tr) => (
              <option key={tr.value} value={tr.value}>
                {tr.label}
              </option>
            ))}
          </select>
          <Button onClick={loadData} variant="secondary" disabled={isFetching}>
            <svg
              className={`w-5 h-5 ${isFetching ? 'animate-spin' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </Button>
        </div>
      </div>

      {/* Last Updated */}
      <div className="text-xs text-gray-500">
        Last updated: {formatTimestamp(lastUpdated)}
      </div>

      {/* Partial failure: one read failed and the others answered. The page
          used to discard the whole render in that case, so an unreachable
          infrastructure probe hid a dashboard that had loaded (ADMIN-HIGH-121). */}
      <QueryFailureNotice errors={queryErrors} hasContent={hasContent} onRetry={loadData} />

      {/* Alerts Banner */}
      {alerts.length > 0 && (
        <Card className="border-l-4 border-yellow-400 bg-yellow-50">
          <div className="p-4">
            <h3 className="font-semibold text-yellow-800 mb-2 flex items-center gap-2">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>
              Active Performance Alerts
            </h3>
            <div className="space-y-2">
              {alerts.map((alert, idx) => (
                <div key={idx} className="flex items-center gap-3 text-sm">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      alert.severity === 'critical' ? 'bg-red-500' : 'bg-yellow-500'
                    }`}
                  />
                  <span className="text-yellow-800">
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
            <div className="text-sm font-medium text-gray-500">Response Time</div>
            <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 10V3L4 14h7v7l9-11h-7z"
              />
            </svg>
          </div>
          <div
            className={`text-3xl font-bold ${getHealthColor(application?.avgResponseTime, {
              warning: 300,
              critical: 500,
            })}`}
          >
            {formatMetric(application?.avgResponseTime, ' ms')}
          </div>
          <div className="text-xs text-gray-500 mt-1">Ortalama yanit suresi</div>
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium text-gray-500">CPU Usage</div>
            <svg className="w-5 h-5 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
              />
            </svg>
          </div>
          <div
            className={`text-3xl font-bold ${getHealthColor(infrastructure?.cpuUsage, {
              warning: 70,
              critical: 90,
            })}`}
          >
            {formatMetric(infrastructure?.cpuUsage, '%')}
          </div>
          <div className="text-xs text-gray-500 mt-1">CPU kullanimi</div>
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium text-gray-500">Memory Usage</div>
            <svg className="w-5 h-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"
              />
            </svg>
          </div>
          <div
            className={`text-3xl font-bold ${getHealthColor(infrastructure?.memoryUsage, {
              warning: 70,
              critical: 90,
            })}`}
          >
            {formatMetric(infrastructure?.memoryUsage, '%')}
          </div>
          <div className="text-xs text-gray-500 mt-1">Bellek kullanimi</div>
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium text-gray-500">Error Rate</div>
            <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <div
            className={`text-3xl font-bold ${getHealthColor(application?.errorRate, {
              warning: 1,
              critical: 5,
            })}`}
          >
            {formatMetric(application?.errorRate, '%', 2)}
          </div>
          <div className="text-xs text-gray-500 mt-1">Error rate</div>
        </Card>
      </div>

      {/* Overall Health Score */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Overall System Health</h2>
            <p className="text-sm text-gray-500">Tum metriklere dayali genel saglik skoru</p>
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
            <div className="text-gray-500">/100</div>
          </div>
        </div>
        <div className="h-4 bg-gray-200 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              dashboard?.healthScore === null || dashboard?.healthScore === undefined
                ? 'bg-gray-300'
                : 'bg-green-500'
            }`}
            style={{ width: `${dashboard?.healthScore ?? 0}%` }}
          />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 pt-6 border-t">
          <div>
            <div className="text-sm text-gray-500 mb-1">Throughput</div>
            <div className="text-xl font-bold text-gray-900">
              {application?.throughput === null || application?.throughput === undefined
                ? UNKNOWN
                : `${application.throughput.toLocaleString()} req/s`}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 mb-1">Apdex Score</div>
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
            <div className="text-sm text-gray-500 mb-1">DB Connections</div>
            <div className="text-xl font-bold text-gray-900">
              {formatMetric(database?.activeConnections)}/{formatMetric(database?.poolSize)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 mb-1">Cache Hit Ratio</div>
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
        <h2 className="text-lg font-semibold text-gray-900 mb-6">Infrastructure Metrics</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div>
            <div className="flex justify-between mb-2">
              <span className="text-sm font-medium text-gray-700">CPU Usage</span>
              <span
                className={`text-sm font-bold ${getHealthColor(infrastructure?.cpuUsage, {
                  warning: 70,
                  critical: 90,
                })}`}
              >
                {formatMetric(infrastructure?.cpuUsage, '%')}
              </span>
            </div>
            <div className="h-3 bg-gray-200 rounded-full overflow-hidden">
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
              <span className="text-sm font-medium text-gray-700">Memory Usage</span>
              <span
                className={`text-sm font-bold ${getHealthColor(infrastructure?.memoryUsage, {
                  warning: 70,
                  critical: 90,
                })}`}
              >
                {formatMetric(infrastructure?.memoryUsage, '%')}
              </span>
            </div>
            <div className="h-3 bg-gray-200 rounded-full overflow-hidden">
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
              <span className="text-sm font-medium text-gray-700">Disk Usage</span>
              <span
                className={`text-sm font-bold ${getHealthColor(infrastructure?.diskUsage, {
                  warning: 70,
                  critical: 90,
                })}`}
              >
                {formatMetric(infrastructure?.diskUsage, '%')}
              </span>
            </div>
            <div className="h-3 bg-gray-200 rounded-full overflow-hidden">
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
            <span className="text-sm text-gray-500">Network Latency</span>
            <span className="text-lg font-bold text-gray-900">
              {formatMetric(infrastructure?.networkLatency, ' ms')}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500">Healthy Containers</span>
            <span className="text-lg font-bold text-green-600">
              {formatMetric(infrastructure?.healthyContainers)}/
              {formatMetric(infrastructure?.containerCount)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500">Avg Query Time</span>
            <span className="text-lg font-bold text-gray-900">
              {formatMetric(database?.avgQueryTime, ' ms')}
            </span>
          </div>
        </div>
      </Card>

      {/* Performance Trends — real charts from the fetched dashboard.trends series */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Performance Trends</h2>
          <span className="text-sm text-gray-500">{range.label}</span>
        </div>
        {!trends || trends.responseTime.length === 0 ? (
          <div className="h-48 flex items-center justify-center text-sm text-gray-500">
            No trend data for this range
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-2">Response Time (ms)</h3>
              <LineChart
                labels={trends.responseTime.map((point) => formatTrendLabel(point.timestamp))}
                datasets={[{ label: 'Response time', data: trends.responseTime.map((point) => point.value) }]}
                height={180}
                className="w-full"
                showLegend={false}
              />
            </div>
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-2">Throughput (req/min)</h3>
              <LineChart
                labels={trends.throughput.map((point) => formatTrendLabel(point.timestamp))}
                datasets={[{ label: 'Throughput', data: trends.throughput.map((point) => point.value) }]}
                height={180}
                className="w-full"
                showLegend={false}
              />
            </div>
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-2">Error Rate (%)</h3>
              <LineChart
                labels={trends.errorRate.map((point) => formatTrendLabel(point.timestamp))}
                datasets={[{ label: 'Error rate', data: trends.errorRate.map((point) => point.value) }]}
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
          <h2 className="text-lg font-semibold text-gray-900">Service Health Status</h2>
          <p className="text-sm text-gray-500 mt-1">Real-time servis saglik durumlari ve performans metrikleri</p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Service Name
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Avg Response
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Error Rate
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Requests
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {serviceBreakdown.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-gray-500">
                    No service data available
                  </td>
                </tr>
              ) : (
                serviceBreakdown.map((service, idx) => {
                  const status = getServiceStatus(service);
                  return (
                    <tr key={idx} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div
                            className={`w-2 h-2 rounded-full ${
                              status === 'healthy'
                                ? 'bg-green-500'
                                : status === 'warning'
                                ? 'bg-yellow-500'
                                : 'bg-red-500'
                            }`}
                          />
                          <span className="font-medium text-gray-900">{service.service}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <Badge variant={getStatusBadgeVariant(status)} size="sm">
                          {status}
                        </Badge>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <span
                          className={`font-medium ${getHealthColor(service.avgResponseTime ?? 0, {
                            warning: 300,
                            critical: 500,
                          })}`}
                        >
                          {Math.round(service.avgResponseTime ?? 0)} ms
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <span
                          className={`font-medium ${getHealthColor(service.errorRate ?? 0, {
                            warning: 0.5,
                            critical: 1,
                          })}`}
                        >
                          {(service.errorRate ?? 0).toFixed(2)}%
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <span className="text-gray-900">{service.requestCount.toLocaleString()}</span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

    </div>
  );
};

export default PerformanceDashboardPage;
