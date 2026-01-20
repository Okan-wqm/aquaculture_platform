/**
 * Performance Dashboard Page
 *
 * Enterprise-grade performance monitoring dashboard with real API integration.
 * Displays real-time system metrics, service health, and performance trends.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Card, Button, Badge } from '@aquaculture/shared-ui';
import { systemSettingsApi } from '../../services/adminApi';
import type { PerformanceDashboard, PerformanceMetrics } from '../../services/adminApi';

// ============================================================================
// Types
// ============================================================================

interface TimeRange {
  label: string;
  value: string;
  start: string;
  end: string;
}

interface ServiceHealth {
  name: string;
  status: 'healthy' | 'warning' | 'critical';
  avgResponseTime: number;
  errorRate: number;
  requestCount: number;
}

// ============================================================================
// No Mock Data - Using Real API Only
// ============================================================================

// ============================================================================
// Time Range Helper
// ============================================================================

const getTimeRanges = (): TimeRange[] => {
  const now = new Date();
  return [
    {
      label: 'Son 5 Dakika',
      value: '5m',
      start: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
      end: now.toISOString(),
    },
    {
      label: 'Son 15 Dakika',
      value: '15m',
      start: new Date(now.getTime() - 15 * 60 * 1000).toISOString(),
      end: now.toISOString(),
    },
    {
      label: 'Son 1 Saat',
      value: '1h',
      start: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      end: now.toISOString(),
    },
    {
      label: 'Son 6 Saat',
      value: '6h',
      start: new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString(),
      end: now.toISOString(),
    },
    {
      label: 'Son 24 Saat',
      value: '24h',
      start: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      end: now.toISOString(),
    },
  ];
};

// ============================================================================
// Component
// ============================================================================

export const PerformanceDashboardPage: React.FC = () => {
  // State
  const [dashboard, setDashboard] = useState<PerformanceDashboard | null>(null);
  const [infrastructure, setInfrastructure] = useState({
    cpuUsage: 0,
    memoryUsage: 0,
    diskUsage: 0,
    networkLatency: 0,
    containerCount: 0,
    healthyContainers: 0,
  });
  const [database, setDatabase] = useState({
    activeConnections: 0,
    poolSize: 0,
    poolUtilization: 0,
    avgQueryTime: 0,
    slowQueryCount: 0,
    cacheHitRatio: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>(getTimeRanges()[2]); // Default to 1h
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());

  // ============================================================================
  // Data Loading
  // ============================================================================

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Load all metrics in parallel
      const [dashboardData, infraData, dbData] = await Promise.all([
        systemSettingsApi.getPerformanceDashboard(undefined, {
          start: timeRange.start,
          end: timeRange.end,
        }),
        systemSettingsApi.getInfrastructureMetrics(),
        systemSettingsApi.getDatabasePerformance(),
      ]);

      // Map API response to frontend format
      // API returns: currentSnapshot.applicationMetrics.errorRate
      // Frontend expects: currentSnapshot.errorRate
      const apiSnapshot = dashboardData.currentSnapshot as Record<string, unknown> | undefined;
      const appMetrics = (apiSnapshot?.applicationMetrics as Record<string, number>) ?? {};

      const mappedDashboard: PerformanceDashboard = {
        currentSnapshot: {
          healthScore: (apiSnapshot?.overallHealthScore as number) ?? 100,
          avgResponseTime: appMetrics.avgResponseTime ?? 0,
          errorRate: appMetrics.errorRate ?? 0,
          throughput: appMetrics.throughput ?? 0,
          apdexScore: appMetrics.apdexScore ?? 1,
        },
        trends: dashboardData.trends ?? { responseTime: [], throughput: [], errorRate: [] },
        serviceBreakdown: dashboardData.serviceBreakdown ?? [],
        alerts: dashboardData.alerts ?? [],
      };

      setDashboard(mappedDashboard);
      setInfrastructure(infraData);
      setDatabase(dbData);
      setLastUpdated(new Date());
    } catch (err) {
      console.error('Failed to load performance data:', err);
      setError('Failed to load performance data. Please try again.');
      setDashboard(null);
      setInfrastructure({
        cpuUsage: 0,
        memoryUsage: 0,
        diskUsage: 0,
        networkLatency: 0,
        containerCount: 0,
        healthyContainers: 0,
      });
      setDatabase({
        activeConnections: 0,
        poolSize: 0,
        poolUtilization: 0,
        avgQueryTime: 0,
        slowQueryCount: 0,
        cacheHitRatio: 0,
      });
    } finally {
      setLoading(false);
    }
  }, [timeRange]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(() => {
      loadData();
    }, 30000);

    return () => clearInterval(interval);
  }, [autoRefresh, loadData]);

  // ============================================================================
  // Helpers
  // ============================================================================

  const getHealthColor = (
    value: number,
    thresholds: { warning: number; critical: number },
    inverse = false
  ) => {
    if (inverse) {
      if (value <= thresholds.critical) return 'text-red-600';
      if (value <= thresholds.warning) return 'text-yellow-600';
      return 'text-green-600';
    }
    if (value >= thresholds.critical) return 'text-red-600';
    if (value >= thresholds.warning) return 'text-yellow-600';
    return 'text-green-600';
  };

  const getProgressColor = (value: number, thresholds: { warning: number; critical: number }) => {
    if (value >= thresholds.critical) return 'bg-red-500';
    if (value >= thresholds.warning) return 'bg-yellow-500';
    return 'bg-green-500';
  };

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

  const formatTimestamp = (date: Date) => {
    return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  // ============================================================================
  // Render - Loading State
  // ============================================================================

  if (loading && !dashboard) {
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

  if (!dashboard) {
    return (
      <div className="flex flex-col items-center justify-center h-64 space-y-4">
        <div className="text-red-600 text-lg font-semibold">Failed to load performance data</div>
        <Button onClick={loadData}>Retry</Button>
      </div>
    );
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
            value={timeRange.value}
            onChange={(e) => {
              const selected = getTimeRanges().find((tr) => tr.value === e.target.value);
              if (selected) setTimeRange(selected);
            }}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            {getTimeRanges().map((tr) => (
              <option key={tr.value} value={tr.value}>
                {tr.label}
              </option>
            ))}
          </select>
          <Button onClick={loadData} variant="secondary" disabled={loading}>
            <svg
              className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`}
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

      {/* Alerts Banner */}
      {dashboard.alerts && dashboard.alerts.length > 0 && (
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
              {dashboard.alerts.map((alert, idx) => (
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
            className={`text-3xl font-bold ${getHealthColor(
              dashboard.currentSnapshot.avgResponseTime,
              { warning: 300, critical: 500 }
            )}`}
          >
            {Math.round(dashboard.currentSnapshot.avgResponseTime)} ms
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
            className={`text-3xl font-bold ${getHealthColor(infrastructure.cpuUsage, {
              warning: 70,
              critical: 90,
            })}`}
          >
            {infrastructure.cpuUsage}%
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
            className={`text-3xl font-bold ${getHealthColor(infrastructure.memoryUsage, {
              warning: 70,
              critical: 90,
            })}`}
          >
            {infrastructure.memoryUsage}%
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
            className={`text-3xl font-bold ${getHealthColor(dashboard.currentSnapshot.errorRate ?? 0, {
              warning: 1,
              critical: 5,
            })}`}
          >
            {(dashboard.currentSnapshot.errorRate ?? 0).toFixed(2)}%
          </div>
          <div className="text-xs text-gray-500 mt-1">Hata orani</div>
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
            <div className="text-5xl font-bold text-green-600">
              {Math.round(dashboard.currentSnapshot.healthScore)}
            </div>
            <div className="text-gray-400">/100</div>
          </div>
        </div>
        <div className="h-4 bg-gray-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-green-500 rounded-full transition-all duration-500"
            style={{ width: `${dashboard.currentSnapshot.healthScore}%` }}
          />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 pt-6 border-t">
          <div>
            <div className="text-sm text-gray-500 mb-1">Throughput</div>
            <div className="text-xl font-bold text-gray-900">
              {dashboard.currentSnapshot.throughput.toLocaleString()} req/s
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 mb-1">Apdex Score</div>
            <div
              className={`text-xl font-bold ${getHealthColor(
                dashboard.currentSnapshot.apdexScore ?? 0,
                { warning: 0.85, critical: 0.7 },
                true
              )}`}
            >
              {(dashboard.currentSnapshot.apdexScore ?? 0).toFixed(2)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 mb-1">DB Connections</div>
            <div className="text-xl font-bold text-gray-900">
              {database.activeConnections}/{database.poolSize}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 mb-1">Cache Hit Ratio</div>
            <div className="text-xl font-bold text-green-600">{database.cacheHitRatio}%</div>
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
                className={`text-sm font-bold ${getHealthColor(infrastructure.cpuUsage, {
                  warning: 70,
                  critical: 90,
                })}`}
              >
                {infrastructure.cpuUsage}%
              </span>
            </div>
            <div className="h-3 bg-gray-200 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${getProgressColor(
                  infrastructure.cpuUsage,
                  { warning: 70, critical: 90 }
                )}`}
                style={{ width: `${infrastructure.cpuUsage}%` }}
              />
            </div>
          </div>

          <div>
            <div className="flex justify-between mb-2">
              <span className="text-sm font-medium text-gray-700">Memory Usage</span>
              <span
                className={`text-sm font-bold ${getHealthColor(infrastructure.memoryUsage, {
                  warning: 70,
                  critical: 90,
                })}`}
              >
                {infrastructure.memoryUsage}%
              </span>
            </div>
            <div className="h-3 bg-gray-200 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${getProgressColor(
                  infrastructure.memoryUsage,
                  { warning: 70, critical: 90 }
                )}`}
                style={{ width: `${infrastructure.memoryUsage}%` }}
              />
            </div>
          </div>

          <div>
            <div className="flex justify-between mb-2">
              <span className="text-sm font-medium text-gray-700">Disk Usage</span>
              <span
                className={`text-sm font-bold ${getHealthColor(infrastructure.diskUsage, {
                  warning: 70,
                  critical: 90,
                })}`}
              >
                {infrastructure.diskUsage}%
              </span>
            </div>
            <div className="h-3 bg-gray-200 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${getProgressColor(
                  infrastructure.diskUsage,
                  { warning: 70, critical: 90 }
                )}`}
                style={{ width: `${infrastructure.diskUsage}%` }}
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-6 pt-6 border-t">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500">Network Latency</span>
            <span className="text-lg font-bold text-gray-900">{infrastructure.networkLatency} ms</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500">Healthy Containers</span>
            <span className="text-lg font-bold text-green-600">
              {infrastructure.healthyContainers}/{infrastructure.containerCount}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500">Avg Query Time</span>
            <span className="text-lg font-bold text-gray-900">{database.avgQueryTime} ms</span>
          </div>
        </div>
      </Card>

      {/* Performance Trends Placeholder */}
      <Card className="p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Performance Trends</h2>
        <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-lg border-2 border-dashed border-blue-200 p-12 text-center">
          <svg
            className="w-16 h-16 mx-auto text-blue-300 mb-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
            />
          </svg>
          <h3 className="text-lg font-semibold text-gray-700 mb-2">Interactive Charts Coming Soon</h3>
          <p className="text-sm text-gray-500 max-w-md mx-auto">
            Response time, throughput, and error rate trends will be visualized here with interactive
            charts. Chart library integration planned.
          </p>
          <div className="mt-6 grid grid-cols-3 gap-4 text-left max-w-2xl mx-auto">
            <div className="bg-white rounded-lg p-4 shadow-sm">
              <div className="text-xs text-gray-500 mb-1">Avg Trend</div>
              <div className="text-sm font-mono text-gray-700">
                {dashboard.trends.responseTime.map((_, i, arr) => (i < arr.length - 1 ? '↗' : '→'))}
              </div>
            </div>
            <div className="bg-white rounded-lg p-4 shadow-sm">
              <div className="text-xs text-gray-500 mb-1">Data Points</div>
              <div className="text-lg font-bold text-gray-900">{dashboard.trends.responseTime.length}</div>
            </div>
            <div className="bg-white rounded-lg p-4 shadow-sm">
              <div className="text-xs text-gray-500 mb-1">Time Range</div>
              <div className="text-sm font-medium text-gray-700">{timeRange.label}</div>
            </div>
          </div>
        </div>
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
              {dashboard.serviceBreakdown.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-gray-500">
                    No service data available
                  </td>
                </tr>
              ) : (
                dashboard.serviceBreakdown.map((service, idx) => {
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

      {/* Error Display */}
      {error && (
        <div className="fixed bottom-4 right-4 bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded-lg shadow-lg max-w-md">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                clipRule="evenodd"
              />
            </svg>
            <span>{error}</span>
            <button
              onClick={() => setError(null)}
              className="ml-auto text-red-700 hover:text-red-900"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default PerformanceDashboardPage;
