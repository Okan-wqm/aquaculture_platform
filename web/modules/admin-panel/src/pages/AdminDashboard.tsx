/**
 * Admin Dashboard
 *
 * SUPER_ADMIN paneli ana sayfası - Sistem metrikleri ve hızlı erişim.
 */

import { Badge, Card, MetricCard, PageHeader } from '@aquaculture/shared-ui';
import React from 'react';
import { Link } from 'react-router-dom';

import { adminRoutes } from '../routes/adminRoutes';
import { adminKeys, useAdminMutation, useAdminQuery } from '../hooks';
import { QueryFailureNotice } from '../components';
import {
  systemApi,
  usersApi,
  auditApi,
  type SystemMetrics,
  type ServiceHealth,
  type AuditLog,
  type CircuitBreakerStatus,
} from '../services/adminApi';
import { Building2, LogIn, RefreshCw, SquareTerminal, Users as UsersIcon } from 'lucide-react';

// ============================================================================
// Quick Links
// ============================================================================

const quickLinks = [
  {
    id: 'tenants',
    label: 'Tenant Management',
    path: '/admin/tenants',
    icon: '🏢',
    description: 'Create tenants, assign modules',
  },
  {
    id: 'users',
    label: 'User Management',
    path: '/admin/users',
    icon: '👥',
    description: 'Manage all users',
  },
  {
    id: 'modules',
    label: 'Module Management',
    path: '/admin/modules',
    icon: '📦',
    description: 'Manage system modules',
  },
  {
    id: 'settings',
    label: 'System Settings',
    path: '/admin/settings',
    icon: '⚙️',
    description: 'Platform settings',
  },
  {
    id: 'audit',
    label: 'Audit Logs',
    path: adminRoutes.audit,
    icon: '📋',
    description: 'System activities',
  },
];

/** What a card shows for a figure the platform did not measure. */
const UNKNOWN = '\u2014';

/**
 * A number, or an em dash when there is none (ADMIN-HIGH-124).
 *
 * Every card on this page used to substitute a literal 0 for a failed read:
 * `metrics?.platform || { totalTenants: 0, totalUsers: 0, apiCallsLast24h: 0 }`
 * under a comment reading "Calculate metrics with fallbacks". Since the
 * fetch used `Promise.allSettled` and only the (unreachable) catch set an
 * error, a rejected `/system/metrics` produced a SUPER_ADMIN landing page
 * reporting zero tenants, zero users and zero API calls, with nothing on
 * screen to say a request had failed.
 */
const formatMetricNumber = (value: number | null | undefined): string =>
  value === null || value === undefined
    ? UNKNOWN
    : new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 }).format(value);

const REFRESH_INTERVAL_MS = 30_000;

/** The dashboard's "recent activity" panel shows the newest ten entries. */
const RECENT_LOG_LIMIT = 10;

const EMPTY_SERVICES: ServiceHealth[] = [];
const EMPTY_LOGS: readonly AuditLog[] = [];

// ============================================================================
// Service Status Component
// ============================================================================

const ServiceStatusCard: React.FC<{ services: ServiceHealth[] }> = ({ services }) => {
  const healthyCount = services.filter((s) => s.status === 'healthy').length;
  const degradedCount = services.filter((s) => s.status === 'degraded').length;
  const unhealthyCount = services.filter((s) => s.status === 'unhealthy').length;

  return (
    <Card>
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Service Status</h3>
        <div className="flex items-center space-x-2 text-sm">
          <span className="text-success-600 dark:text-success-400">{healthyCount} Healthy</span>
          {degradedCount > 0 && (
            <span className="text-warning-600 dark:text-warning-400">{degradedCount} Degraded</span>
          )}
          {unhealthyCount > 0 && (
            <span className="text-error-600 dark:text-error-400">{unhealthyCount} Unhealthy</span>
          )}
        </div>
      </div>
      <div className="p-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {services.map((service) => (
            <div
              key={service.name}
              className={`p-3 rounded-lg border ${
                service.status === 'healthy'
                  ? 'border-success-200 dark:border-success-800 bg-success-50 dark:bg-success-900/20'
                  : service.status === 'degraded'
                    ? 'border-warning-200 dark:border-warning-800 bg-warning-50 dark:bg-warning-900/20'
                    : 'border-error-200 dark:border-error-800 bg-error-50 dark:bg-error-900/20'
              }`}
            >
              <div className="flex items-center space-x-2">
                <div
                  className={`w-2 h-2 rounded-full ${
                    service.status === 'healthy'
                      ? 'bg-success-500'
                      : service.status === 'degraded'
                        ? 'bg-warning-500'
                        : 'bg-error-500'
                  }`}
                />
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {service.name}
                </span>
              </div>
              {service.responseTime && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {service.responseTime}ms
                </p>
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

const DatabaseStatsCard: React.FC<{ database: SystemMetrics['database'] | undefined }> = ({
  database,
}) => {
  if (!database) return null;

  return (
    <Card>
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Database</h3>
      </div>
      <div className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400">Size</p>
            <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {database.databaseSize}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400">Table Count</p>
            <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {database.tablesCount}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400">Active Connections</p>
            <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {database.activeConnections}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400">Total Connections</p>
            <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {database.totalConnections}
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
};

// ============================================================================
// Recent Activity Component
// ============================================================================

const RecentActivityCard: React.FC<{ logs: readonly AuditLog[] }> = ({ logs }) => {
  const getSeverityColor = (severity: string): 'error' | 'warning' | 'info' | 'default' => {
    switch (severity) {
      case 'critical':
        return 'error';
      case 'high':
        return 'warning';
      case 'medium':
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
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Recent Activity</h3>
        <Link
          to={adminRoutes.audit}
          className="text-sm text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-200"
        >
          View All
        </Link>
      </div>
      <div className="divide-y divide-gray-100 dark:divide-gray-700 max-h-80 overflow-y-auto">
        {logs.length === 0 ? (
          <div className="p-4 text-center text-gray-500 dark:text-gray-400">No activity found</div>
        ) : (
          logs.map((log) => (
            <div key={log.id} className="px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800">
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center space-x-2">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                      {log.action}
                    </p>
                    <Badge variant={getSeverityColor(log.severity)} size="sm">
                      {log.severity}
                    </Badge>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {log.entityType} - {log.performedByEmail || log.performedBy}
                  </p>
                </div>
                <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap ml-2">
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

const stateStyles: Record<string, { bg: string; border: string; dot: string; label: string }> = {
  closed: {
    bg: 'bg-success-50 dark:bg-success-900/20',
    border: 'border-success-200 dark:border-success-800',
    dot: 'bg-success-500',
    label: 'Closed',
  },
  open: {
    bg: 'bg-error-50 dark:bg-error-900/20',
    border: 'border-error-200 dark:border-error-800',
    dot: 'bg-error-500',
    label: 'Open',
  },
  half_open: {
    bg: 'bg-warning-50 dark:bg-warning-900/20',
    border: 'border-warning-200 dark:border-warning-800',
    dot: 'bg-warning-500',
    label: 'Half-Open',
  },
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
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <Card>
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Circuit Breakers</h3>
      </div>
      <div className="p-4 space-y-3">
        {entries.map(([name, info]) => {
          const style = stateStyles[info.state] || stateStyles.closed;
          const isOpen = info.state === 'open';
          const isResetting = resetting === name;

          return (
            <div key={name} className={`p-4 rounded-lg border ${style.border} ${style.bg}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className={`w-3 h-3 rounded-full ${style.dot}`} />
                  <div>
                    <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 uppercase">
                      {name}
                    </p>
                    <Badge
                      variant={
                        info.state === 'closed'
                          ? 'success'
                          : info.state === 'open'
                            ? 'error'
                            : 'warning'
                      }
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
                    className="inline-flex items-center px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-md text-xs font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
                  >
                    {isResetting ? 'Resetting...' : 'Reset'}
                  </button>
                )}
              </div>
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div>
                  <span className="text-gray-500 dark:text-gray-400">Failures</span>
                  <p className="font-semibold text-gray-900 dark:text-gray-100">
                    {info.consecutiveFailures}
                  </p>
                </div>
                <div>
                  <span className="text-gray-500 dark:text-gray-400">Last failure</span>
                  <p className="font-semibold text-gray-900 dark:text-gray-100">
                    {formatTime(info.lastFailureTime)}
                  </p>
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
// Admin Dashboard
// ============================================================================

const AdminDashboard: React.FC = () => {
  // ==========================================================================
  // Data — five independent reads (ADMIN-HIGH-121)
  //
  // They were one `Promise.allSettled` whose per-promise rejections were
  // silently mapped to `null` and `[]`, while the only `setError` call sat in
  // a catch that `allSettled` can never reach. So every failure on the
  // platform's landing page was invisible. Five keyed queries fail
  // independently and `QueryFailureNotice` reports whichever of them did.
  //
  // The old code also built an `AbortController` and never handed it to a
  // single request: `systemApi.getMetrics()` and friends took no signal, so
  // aborting only discarded a response that had already been fetched.
  // ==========================================================================

  const metricsQuery = useAdminQuery(
    [...adminKeys.system.all(), 'metrics'],
    ({ signal }) => systemApi.getMetrics(signal),
    { refetchInterval: REFRESH_INTERVAL_MS },
  );

  const userStatsQuery = useAdminQuery(
    [...adminKeys.users.all(), 'stats'],
    ({ signal }) => usersApi.getStats(signal),
    { refetchInterval: REFRESH_INTERVAL_MS },
  );

  const servicesQuery = useAdminQuery(
    adminKeys.system.health(),
    ({ signal }) => systemApi.getServicesHealth(signal),
    { refetchInterval: REFRESH_INTERVAL_MS },
  );

  const logsQuery = useAdminQuery(
    adminKeys.security.audit({ limit: RECENT_LOG_LIMIT }),
    ({ signal }) => auditApi.query({ limit: RECENT_LOG_LIMIT }, signal),
    { refetchInterval: REFRESH_INTERVAL_MS },
  );

  const circuitBreakersQuery = useAdminQuery(
    [...adminKeys.system.all(), 'circuit-breakers'],
    ({ signal }) => systemApi.getCircuitBreakers(signal),
    { refetchInterval: REFRESH_INTERVAL_MS },
  );

  const metrics = metricsQuery.data ?? null;
  const userStats = userStatsQuery.data ?? null;
  const services = servicesQuery.data ?? EMPTY_SERVICES;
  const recentLogs = logsQuery.data?.data ?? EMPTY_LOGS;
  const circuitBreakers = circuitBreakersQuery.data ?? null;

  const platform: SystemMetrics['platform'] | null = metrics?.platform ?? null;

  const queries = [metricsQuery, userStatsQuery, servicesQuery, logsQuery, circuitBreakersQuery];
  const loading = queries.some((query) => query.isFetching);
  const hasContent = queries.some((query) => query.data !== undefined);

  /**
   * Resetting a breaker changes the breaker list and nothing else, so that is
   * the one key it invalidates. The old handler re-fetched the list by hand
   * and, on failure, wrote a message into the same `error` slot the page used
   * for read failures.
   */
  const resetBreaker = useAdminMutation<{ success: boolean; name: string; state: string }, string>(
    (name) => systemApi.resetCircuitBreaker(name),
    { invalidateKeys: [[...adminKeys.system.all(), 'circuit-breakers']] },
  );

  const resettingBreaker = resetBreaker.isPending ? (resetBreaker.variables ?? null) : null;

  const queryErrors = [
    ...queries.map((query) => query.error),
    resetBreaker.error
      ? new Error(`Failed to reset circuit breaker: ${resetBreaker.error.message}`)
      : null,
  ];

  const refresh = (): void => {
    for (const query of queries) void query.refetch();
  };

  return (
    <div className="space-y-6">
      {/* Sayfa Basligi */}
      <PageHeader
        title="Admin Dashboard"
        description="System management and monitoring"
        actions={
          <button
            onClick={() => {
              refresh();
            }}
            disabled={loading}
            className="inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            <RefreshCw
              className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            Refresh
          </button>
        }
      />

      {/* Whichever reads failed, named — where a rejected `/system/metrics`
          used to show as zeros and nothing else (ADMIN-HIGH-124). */}
      <QueryFailureNotice errors={queryErrors} hasContent={hasContent} onRetry={refresh} />

      {/* Ana Metrikler */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Total Users"
          value={formatMetricNumber(userStats?.totalUsers ?? platform?.totalUsers)}
          change={
            userStats?.newUsersLast30Days !== undefined && userStats.totalUsers
              ? (userStats.newUsersLast30Days / userStats.totalUsers) * 100
              : undefined
          }
          icon={<UsersIcon className="w-6 h-6" aria-hidden="true" />}
        />
        <MetricCard
          title="Active Tenants"
          value={
            // The previous guard printed a dash whenever BOTH counts were 0,
            // which also hid a real, correctly-measured "no tenants yet". The
            // question is whether the read answered, not what it answered.
            platform === null ? UNKNOWN : `${platform.activeTenants}/${platform.totalTenants}`
          }
          icon={<Building2 className="w-6 h-6" aria-hidden="true" />}
        />
        <MetricCard
          title="Logins (Last 24h)"
          value={formatMetricNumber(userStats?.loginsLast24Hours)}
          icon={<LogIn className="w-6 h-6" aria-hidden="true" />}
        />
        <MetricCard
          title="API Calls (24h)"
          value={formatMetricNumber(platform?.apiCallsLast24h)}
          icon={<SquareTerminal className="w-6 h-6" aria-hidden="true" />}
        />
      </div>

      {/* Hizli Erisim */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Quick Access
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {quickLinks.map((link) => (
            <Link key={link.id} to={link.path}>
              <Card className="p-4 hover:shadow-md hover:bg-gray-50 dark:hover:bg-gray-800 transition-all cursor-pointer h-full">
                <div className="text-3xl mb-2">{link.icon}</div>
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{link.label}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{link.description}</p>
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
        </div>
        <div className="space-y-6">
          <CircuitBreakerCard
            circuitBreakers={circuitBreakers}
            onReset={(name) => {
              resetBreaker.mutate(name);
            }}
            resetting={resettingBreaker}
          />
          <RecentActivityCard logs={recentLogs} />
        </div>
      </div>

      {/* Kullanici Dagilimi */}
      {userStats && userStats.usersByRole.length > 0 && (
        <Card>
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              User Distribution
            </h3>
          </div>
          <div className="p-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {userStats.usersByRole.map((item) => (
                <div
                  key={item.role}
                  className="text-center p-4 bg-gray-50 dark:bg-gray-800 rounded-lg"
                >
                  <p className="text-2xl font-bold text-primary-600 dark:text-primary-400">
                    {item.count}
                  </p>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{item.role}</p>
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* Sistem Kaynak Kullanimi */}
      {metrics?.resources && (
        <Card>
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              System Resources
            </h3>
          </div>
          <div className="p-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">Heap Usage</p>
                <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  {Math.round(metrics.resources.memoryUsage.heapUsed / (1024 * 1024))} MB
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  / {Math.round(metrics.resources.memoryUsage.heapTotal / (1024 * 1024))} MB
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">RSS Memory</p>
                <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  {Math.round(metrics.resources.memoryUsage.rss / (1024 * 1024))} MB
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">Uptime</p>
                <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  {Math.round(metrics.resources.uptime / 3600)}h
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">Node Version</p>
                <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  {metrics.resources.nodeVersion}
                </p>
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
};

export default AdminDashboard;
