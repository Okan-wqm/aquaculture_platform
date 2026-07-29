/**
 * Admin Dashboard
 *
 * SUPER_ADMIN paneli ana sayfası - Sistem metrikleri ve hızlı erişim.
 */

import { Alert, Badge, Card, MetricCard } from '@aquaculture/shared-ui';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { adminRoutes } from '../routes/adminRoutes';
import {
  systemApi,
  usersApi,
  auditApi,
  debugApi,
  type SystemMetrics,
  type ServiceHealth,
  type UserStats,
  type AuditLog,
  type CircuitBreakerStatus,
  type CircuitBreakerState,
  type CacheStats,
} from '../services/adminApi';

// ============================================================================
// Types
// ============================================================================

// `CacheStats` comes from the service that computes it — see the import above.
// This file used to declare its own copy with `hitRate`, `missRate` and a
// `byStore` breakdown, all read off a snapshot table nothing wrote.

interface DashboardData {
  metrics: SystemMetrics | null;
  userStats: UserStats | null;
  services: ServiceHealth[];
  recentLogs: AuditLog[];
  circuitBreakers: CircuitBreakerStatus | null;
  cacheStats: CacheStats | null;
  loading: boolean;
  error: string | null;
}

// ============================================================================
// Quick Links
// ============================================================================

const quickLinks = [
  { id: 'tenants', label: 'Tenant Management', path: '/admin/tenants', icon: '🏢', description: 'Create tenants, assign modules' },
  { id: 'users', label: 'User Management', path: '/admin/users', icon: '👥', description: 'Manage all users' },
  { id: 'modules', label: 'Module Management', path: '/admin/modules', icon: '📦', description: 'Manage system modules' },
  { id: 'settings', label: 'System Settings', path: '/admin/settings', icon: '⚙️', description: 'Platform settings' },
  { id: 'audit', label: 'Audit Logs', path: adminRoutes.audit, icon: '📋', description: 'System activities' },
];

const formatMetricNumber = (value: number): string =>
  new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 }).format(value);

// ============================================================================
// Service Status Component
// ============================================================================

const ServiceStatusCard: React.FC<{ services: ServiceHealth[] }> = ({ services }) => {
  const healthyCount = services.filter((s) => s.status === 'healthy').length;
  const degradedCount = services.filter((s) => s.status === 'degraded').length;
  const unhealthyCount = services.filter((s) => s.status === 'unhealthy').length;

  return (
    <Card>
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">Service Status</h3>
        <div className="flex items-center space-x-2 text-sm">
          <span className="text-green-600">{healthyCount} Healthy</span>
          {degradedCount > 0 && <span className="text-yellow-600">{degradedCount} Degraded</span>}
          {unhealthyCount > 0 && <span className="text-red-600">{unhealthyCount} Unhealthy</span>}
        </div>
      </div>
      <div className="p-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {services.map((service) => (
            <div
              key={service.name}
              className={`p-3 rounded-lg border ${
                service.status === 'healthy'
                  ? 'border-green-200 bg-green-50'
                  : service.status === 'degraded'
                  ? 'border-yellow-200 bg-yellow-50'
                  : 'border-red-200 bg-red-50'
              }`}
            >
              <div className="flex items-center space-x-2">
                <div
                  className={`w-2 h-2 rounded-full ${
                    service.status === 'healthy'
                      ? 'bg-green-500'
                      : service.status === 'degraded'
                      ? 'bg-yellow-500'
                      : 'bg-red-500'
                  }`}
                />
                <span className="text-sm font-medium text-gray-700">{service.name}</span>
              </div>
              {service.responseTime && (
                <p className="text-xs text-gray-500 mt-1">{service.responseTime}ms</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
};

// ============================================================================
// Database Stats Component
// ============================================================================

const DatabaseStatsCard: React.FC<{ database: SystemMetrics['database'] | undefined }> = ({ database }) => {
  if (!database) return null;

  return (
    <Card>
      <div className="px-4 py-3 border-b border-gray-200">
        <h3 className="text-lg font-semibold text-gray-900">Database</h3>
      </div>
      <div className="p-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-gray-500">Size</p>
            <p className="text-lg font-semibold text-gray-900">{database.databaseSize}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Table Count</p>
            <p className="text-lg font-semibold text-gray-900">{database.tablesCount}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Active Connections</p>
            <p className="text-lg font-semibold text-gray-900">{database.activeConnections}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Total Connections</p>
            <p className="text-lg font-semibold text-gray-900">{database.totalConnections}</p>
          </div>
        </div>
      </div>
    </Card>
  );
};

// ============================================================================
// Recent Activity Component
// ============================================================================

const RecentActivityCard: React.FC<{ logs: AuditLog[] }> = ({ logs }) => {
  // Maps the backend AuditSeverity enum (info | warning | critical) to a badge
  // variant; pinned by tests/invariants/admin-audit-severity-vocab.spec.ts. The
  // prior high/medium branches never matched a real row (APA-004).
  const getSeverityColor = (severity: string): 'error' | 'warning' | 'info' | 'default' => {
    switch (severity) {
      case 'critical':
        return 'error';
      case 'warning':
        return 'warning';
      case 'info':
        return 'info';
      default:
        return 'default';
    }
  };

  const formatTime = (dateStr: string): string => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return date.toLocaleDateString('en-US');
  };

  return (
    <Card>
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">Recent Activity</h3>
        <Link to={adminRoutes.audit} className="text-sm text-primary-600 hover:text-primary-700">
          View All
        </Link>
      </div>
      <div className="divide-y divide-gray-100 max-h-80 overflow-y-auto">
        {logs.length === 0 ? (
          <div className="p-4 text-center text-gray-500">No activity found</div>
        ) : (
          logs.map((log) => (
            <div key={log.id} className="px-4 py-3 hover:bg-gray-50">
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center space-x-2">
                    <p className="text-sm font-medium text-gray-900 truncate">{log.action}</p>
                    <Badge variant={getSeverityColor(log.severity)} size="sm">
                      {log.severity}
                    </Badge>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    {log.entityType} - {log.performedByEmail || log.performedBy}
                  </p>
                </div>
                <span className="text-xs text-gray-500 whitespace-nowrap ml-2">
                  {formatTime(log.createdAt)}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
  );
};

// ============================================================================
// Circuit Breaker Status Component
// ============================================================================

// Exhaustive over the breaker vocabulary, so a new state is a compile error
// rather than something the `|| stateStyles.closed` fallback used to paint green.
const stateStyles: Record<
  CircuitBreakerState,
  { bg: string; border: string; dot: string; label: string }
> = {
  closed: { bg: 'bg-green-50', border: 'border-green-200', dot: 'bg-green-500', label: 'Closed' },
  open: { bg: 'bg-red-50', border: 'border-red-200', dot: 'bg-red-500', label: 'Open' },
  half_open: { bg: 'bg-yellow-50', border: 'border-yellow-200', dot: 'bg-yellow-500', label: 'Half-Open' },
};

const CircuitBreakerCard: React.FC<{
  circuitBreakers: CircuitBreakerStatus | null;
  onReset: (name: string) => void;
  resetting: string | null;
}> = ({ circuitBreakers, onReset, resetting }) => {
  if (!circuitBreakers) return null;

  const entries = Object.entries(circuitBreakers);
  if (entries.length === 0) return null;

  const formatTime = (timestamp: number): string => {
    if (!timestamp) return '-';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <Card>
      <div className="px-4 py-3 border-b border-gray-200">
        <h3 className="text-lg font-semibold text-gray-900">Circuit Breakers</h3>
      </div>
      <div className="p-4 space-y-3">
        {entries.map(([name, info]) => {
          const style = stateStyles[info.state];
          const isOpen = info.state === 'open';
          const isResetting = resetting === name;

          return (
            <div
              key={name}
              className={`p-4 rounded-lg border ${style.border} ${style.bg}`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className={`w-3 h-3 rounded-full ${style.dot}`} />
                  <div>
                    <p className="text-sm font-semibold text-gray-900 uppercase">{name}</p>
                    <Badge
                      variant={info.state === 'closed' ? 'success' : info.state === 'open' ? 'error' : 'warning'}
                      size="sm"
                    >
                      {style.label}
                    </Badge>
                  </div>
                </div>
                {(isOpen || info.state === 'half_open') && (
                  <button
                    onClick={() => onReset(name)}
                    disabled={isResetting}
                    className="inline-flex items-center px-3 py-1.5 border border-gray-300 rounded-md text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
                  >
                    {isResetting ? 'Resetting...' : 'Reset'}
                  </button>
                )}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-4 text-xs">
                <div>
                  <span className="text-gray-500">Failures</span>
                  <p className="font-semibold text-gray-900">{info.consecutiveFailures}</p>
                </div>
                <div>
                  <span className="text-gray-500">Last failure</span>
                  <p className="font-semibold text-gray-900">{formatTime(info.lastFailureTime)}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
};

// ============================================================================
// Cache Stats Component
// ============================================================================

const CacheStatsCard: React.FC<{
  cacheStats: CacheStats | null;
  onClearCache: () => void;
  clearing: boolean;
  error: string | null;
  notice: string | null;
}> = ({ cacheStats, onClearCache, clearing, error, notice }) => {
  return (
    <Card>
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">Cache</h3>
        <button
          onClick={onClearCache}
          disabled={clearing}
          className="inline-flex items-center px-3 py-1.5 border border-red-300 rounded-md text-xs font-medium text-red-700 bg-white hover:bg-red-50 disabled:opacity-50"
        >
          {clearing ? 'Clearing...' : 'Clear Cache'}
        </button>
      </div>
      <div className="p-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-gray-500">Keys in namespace</p>
            <p className="text-lg font-semibold text-gray-900">
              {cacheStats ? formatMetricNumber(cacheStats.keysInNamespace) : '-'}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Hit rate (instance)</p>
            <p className="text-lg font-semibold text-gray-900">
              {/* Null means Redis has served no lookup since it started. The
                  previous card multiplied a fabricated ratio by 100 and printed
                  it to one decimal place. */}
              {cacheStats && cacheStats.instance.hitRatePercent !== null
                ? `${cacheStats.instance.hitRatePercent}%`
                : '-'}
            </p>
          </div>
        </div>
        {error && <p className="text-xs text-red-600 mt-3">{error}</p>}
        {notice && <p className="text-xs text-green-700 mt-3">{notice}</p>}
      </div>
    </Card>
  );
};

// ============================================================================
// Admin Dashboard
// ============================================================================

const AdminDashboard: React.FC = () => {
  const [data, setData] = useState<DashboardData>({
    metrics: null,
    userStats: null,
    services: [],
    recentLogs: [],
    circuitBreakers: null,
    cacheStats: null,
    loading: true,
    error: null,
  });
  const [resettingBreaker, setResettingBreaker] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchDashboardData = useCallback(async () => {
    // Abort any in-flight request before starting a new one
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setData((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const [metrics, userStats, services, logsResult, circuitBreakers] = await Promise.allSettled([
        systemApi.getMetrics(),
        usersApi.getStats(),
        systemApi.getServicesHealth(),
        auditApi.query({ limit: 10 }),
        systemApi.getCircuitBreakers(),
      ]);

      // If this request was aborted while awaiting, discard results
      if (controller.signal.aborted) return;

      setData({
        metrics: metrics.status === 'fulfilled' ? metrics.value : null,
        userStats: userStats.status === 'fulfilled' ? userStats.value : null,
        services: services.status === 'fulfilled' ? services.value : [],
        recentLogs: logsResult.status === 'fulfilled' ? logsResult.value.data : [],
        circuitBreakers: circuitBreakers.status === 'fulfilled' ? circuitBreakers.value : null,
        cacheStats: null,
        loading: false,
        error: null,
      });
    } catch (error) {
      if (controller.signal.aborted) return;

      setData((prev) => ({
        ...prev,
        loading: false,
        error: error instanceof Error ? error.message : 'An error occurred while loading data',
      }));
    }
  }, []);

  const handleResetCircuitBreaker = useCallback(async (name: string) => {
    setResettingBreaker(name);
    try {
      await systemApi.resetCircuitBreaker(name);
      // Refresh circuit breaker data after reset
      const updated = await systemApi.getCircuitBreakers();
      setData((prev) => ({ ...prev, circuitBreakers: updated }));
    } catch {
      setData((prev) => ({
        ...prev,
        error: `Failed to reset circuit breaker '${name}'`,
      }));
    } finally {
      setResettingBreaker(null);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const scheduleFetch = async (): Promise<void> => {
      await fetchDashboardData();

      // Only schedule next refresh if the effect has not been cleaned up
      if (!controller.signal.aborted) {
        refreshTimeoutRef.current = setTimeout(() => {
          void scheduleFetch();
        }, 30000);
      }
    };

    void scheduleFetch();

    return () => {
      controller.abort();
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
        refreshTimeoutRef.current = null;
      }
    };
  }, [fetchDashboardData]);

  const [clearingCache, setClearingCache] = useState(false);

  // Cache management is available in Debug Tools page (/admin/system/debug-tools)
  // which is only accessible in non-production environments.
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [cacheNotice, setCacheNotice] = useState<string | null>(null);

  const handleClearCache = useCallback(async () => {
    setClearingCache(true);
    setCacheError(null);
    setCacheNotice(null);
    try {
      const result = await debugApi.invalidateCacheByPattern('*');
      const freshStats = await debugApi.getCacheStats();
      setData((prev) => ({ ...prev, cacheStats: freshStats }));
      // The count is rendered. A backend that stopped deleting would report 0
      // and the operator would see it, which is the whole point of returning it.
      setCacheNotice(
        `Removed ${result.invalidated} key${result.invalidated === 1 ? '' : 's'}.`,
      );
    } catch (err) {
      // Surfaced, not swallowed. The empty catch here read "Debug endpoints are
      // blocked in production by nginx" — which is true, and is exactly why an
      // operator pressing this button in production needed to be told.
      setCacheError(err instanceof Error ? err.message : 'Could not clear the cache');
    } finally {
      setClearingCache(false);
    }
  }, []);

  const { metrics, userStats, services, recentLogs, circuitBreakers, cacheStats, loading, error } = data;

  // Calculate metrics with fallbacks
  const platformMetrics = metrics?.platform || {
    totalTenants: 0,
    activeTenants: 0,
    totalUsers: 0,
    eventsLast24h: 0,
    apiCallsLast24h: 0,
  };

  return (
    <div className="space-y-6">
      {/* Sayfa Basligi */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Admin Dashboard</h1>
          <p className="mt-1 text-sm text-gray-500">System management and monitoring</p>
        </div>
        <button
          onClick={() => {
            void fetchDashboardData();
          }}
          disabled={loading}
          className="inline-flex items-center px-3 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
        >
          <svg
            className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          Refresh
        </button>
      </div>

      {error && (
        <Alert type="error" dismissible onDismiss={() => setData((prev) => ({ ...prev, error: null }))}>
          {error}
        </Alert>
      )}

      {/* Ana Metrikler */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Total Users"
          value={formatMetricNumber(userStats?.totalUsers || platformMetrics.totalUsers)}
          change={userStats?.newUsersLast30Days ? ((userStats.newUsersLast30Days / (userStats.totalUsers || 1)) * 100) : 0}
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
          }
        />
        <MetricCard
          title="Active Tenants"
          value={
            platformMetrics.activeTenants === 0 && platformMetrics.totalTenants === 0
              ? '\u2014'
              : `${platformMetrics.activeTenants}/${platformMetrics.totalTenants}`
          }
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
          }
        />
        <MetricCard
          title="Logins (Last 24h)"
          value={formatMetricNumber(userStats?.loginsLast24Hours || 0)}
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
            </svg>
          }
        />
        <MetricCard
          title="API Calls (24h)"
          value={formatMetricNumber(platformMetrics.apiCallsLast24h)}
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          }
        />
      </div>

      {/* Hizli Erisim */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Quick Access</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {quickLinks.map((link) => (
            <Link key={link.id} to={link.path}>
              <Card className="p-4 hover:shadow-md hover:bg-gray-50 transition-all cursor-pointer h-full">
                <div className="text-3xl mb-2">{link.icon}</div>
                <p className="text-sm font-medium text-gray-900">{link.label}</p>
                <p className="text-xs text-gray-500 mt-1">{link.description}</p>
              </Card>
            </Link>
          ))}
        </div>
      </div>

      {/* Alt Kisim: Servis Durumu, Veritabani, Circuit Breakers, Son Aktiviteler */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <ServiceStatusCard services={services} />
          <DatabaseStatsCard database={metrics?.database} />
          {cacheStats && (
            <CacheStatsCard
              cacheStats={cacheStats}
              onClearCache={() => {
                void handleClearCache();
              }}
              clearing={clearingCache}
              error={cacheError}
              notice={cacheNotice}
            />
          )}
        </div>
        <div className="space-y-6">
          <CircuitBreakerCard
            circuitBreakers={circuitBreakers}
            onReset={(name) => {
              void handleResetCircuitBreaker(name);
            }}
            resetting={resettingBreaker}
          />
          <RecentActivityCard logs={recentLogs} />
        </div>
      </div>

      {/* Kullanici Dagilimi */}
      {userStats && userStats.usersByRole.length > 0 && (
        <Card>
          <div className="px-4 py-3 border-b border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900">User Distribution</h3>
          </div>
          <div className="p-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {userStats.usersByRole.map((item) => (
                <div key={item.role} className="text-center p-4 bg-gray-50 rounded-lg">
                  <p className="text-2xl font-bold text-primary-600">{item.count}</p>
                  <p className="text-sm text-gray-600 mt-1">{item.role}</p>
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* Sistem Kaynak Kullanimi */}
      {metrics?.resources && (
        <Card>
          <div className="px-4 py-3 border-b border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900">System Resources</h3>
          </div>
          <div className="p-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-gray-500">Heap Usage</p>
                <p className="text-lg font-semibold text-gray-900">
                  {Math.round(metrics.resources.memoryUsage.heapUsed / (1024 * 1024))} MB
                </p>
                <p className="text-xs text-gray-500">
                  / {Math.round(metrics.resources.memoryUsage.heapTotal / (1024 * 1024))} MB
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">RSS Memory</p>
                <p className="text-lg font-semibold text-gray-900">
                  {Math.round(metrics.resources.memoryUsage.rss / (1024 * 1024))} MB
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Uptime</p>
                <p className="text-lg font-semibold text-gray-900">
                  {Math.round(metrics.resources.uptime / 3600)}h
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Node Version</p>
                <p className="text-lg font-semibold text-gray-900">{metrics.resources.nodeVersion}</p>
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
};

export default AdminDashboard;
