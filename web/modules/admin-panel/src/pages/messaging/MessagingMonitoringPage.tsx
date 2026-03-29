/**
 * Messaging Monitoring Page
 *
 * Enterprise monitoring dashboard for SUPER_ADMIN showing real-time stats,
 * per-tenant breakdown, WebSocket connections, and outbox health for the
 * messaging service.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Card, Button, Badge } from '@aquaculture/shared-ui';

// ============================================================================
// Types
// ============================================================================

interface MessagingStats {
  totalMessagesToday: number;
  activeChannels: number;
  onlineUsers: number;
  mediaStorageUsedMB: number;
  wsConnectionsCurrent: number;
  wsConnectionsPeakToday: number;
}

interface TenantMessagingStats {
  tenantId: string;
  tenantName: string;
  messageCount: number;
  channelCount: number;
  storageUsedMB: number;
  lastActivity: string;
}

interface OutboxHealth {
  pendingEvents: number;
  failedEvents: number;
  avgPublishLatencyMs: number;
}

interface SystemAlert {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  timestamp: string;
}

interface HourlyData {
  hour: string;
  count: number;
}

// ============================================================================
// Mock Data (TODO: Replace with admin API calls)
// ============================================================================

const MOCK_STATS: MessagingStats = {
  totalMessagesToday: 0,
  activeChannels: 0,
  onlineUsers: 0,
  mediaStorageUsedMB: 0,
  wsConnectionsCurrent: 0,
  wsConnectionsPeakToday: 0,
};

const MOCK_TENANT_STATS: TenantMessagingStats[] = [];
const MOCK_OUTBOX: OutboxHealth = { pendingEvents: 0, failedEvents: 0, avgPublishLatencyMs: 0 };
const MOCK_ALERTS: SystemAlert[] = [];
const MOCK_HOURLY: HourlyData[] = [];

// ============================================================================
// StatCard Component
// ============================================================================

const StatCard: React.FC<{
  title: string;
  value: string | number;
  subtitle?: string;
  color?: 'blue' | 'green' | 'yellow' | 'red' | 'purple';
}> = ({ title, value, subtitle, color = 'blue' }) => {
  const colorMap = {
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    green: 'bg-green-50 text-green-700 border-green-200',
    yellow: 'bg-yellow-50 text-yellow-700 border-yellow-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    purple: 'bg-purple-50 text-purple-700 border-purple-200',
  };

  return (
    <div className={`rounded-xl border p-5 ${colorMap[color]}`}>
      <p className="text-sm font-medium opacity-80">{title}</p>
      <p className="text-3xl font-bold mt-1">{value}</p>
      {subtitle && <p className="text-xs mt-1 opacity-60">{subtitle}</p>}
    </div>
  );
};

// ============================================================================
// SeverityBadge Component
// ============================================================================

const SeverityBadge: React.FC<{ severity: SystemAlert['severity'] }> = ({ severity }) => {
  const map = {
    info: 'bg-blue-100 text-blue-800',
    warning: 'bg-yellow-100 text-yellow-800',
    critical: 'bg-red-100 text-red-800',
  };

  return (
    <span className={`px-2 py-0.5 text-xs font-semibold rounded-full ${map[severity]}`}>
      {severity.toUpperCase()}
    </span>
  );
};

// ============================================================================
// BarChart Component (Simple SVG)
// ============================================================================

const SimpleBarChart: React.FC<{ data: HourlyData[]; height?: number }> = ({
  data,
  height = 160,
}) => {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center text-gray-400 text-sm" style={{ height }}>
        No data available
      </div>
    );
  }

  const maxVal = Math.max(...data.map((d) => d.count), 1);
  const barWidth = Math.max(12, Math.floor(400 / data.length) - 4);

  return (
    <svg viewBox={`0 0 ${data.length * (barWidth + 4)} ${height}`} className="w-full" style={{ height }}>
      {data.map((d, i) => {
        const barHeight = (d.count / maxVal) * (height - 20);
        return (
          <g key={d.hour}>
            <rect
              x={i * (barWidth + 4)}
              y={height - 20 - barHeight}
              width={barWidth}
              height={barHeight}
              rx={3}
              className="fill-blue-500"
            />
            <text
              x={i * (barWidth + 4) + barWidth / 2}
              y={height - 4}
              textAnchor="middle"
              className="fill-gray-500"
              fontSize="8"
            >
              {d.hour}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

// ============================================================================
// Main Component
// ============================================================================

const MessagingMonitoringPage: React.FC = () => {
  const [stats, setStats] = useState<MessagingStats>(MOCK_STATS);
  const [tenantStats, setTenantStats] = useState<TenantMessagingStats[]>(MOCK_TENANT_STATS);
  const [outbox, setOutbox] = useState<OutboxHealth>(MOCK_OUTBOX);
  const [alerts, setAlerts] = useState<SystemAlert[]>(MOCK_ALERTS);
  const [hourlyData, setHourlyData] = useState<HourlyData[]>(MOCK_HOURLY);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // TODO: Replace with actual admin API calls
      // const [statsRes, tenantRes, outboxRes, alertsRes, hourlyRes] = await Promise.all([
      //   adminApi.get('/admin/messaging/stats'),
      //   adminApi.get('/admin/messaging/tenants/stats'),
      //   adminApi.get('/admin/messaging/outbox/health'),
      //   adminApi.get('/admin/messaging/alerts'),
      //   adminApi.get('/admin/messaging/stats/hourly'),
      // ]);
      // setStats(statsRes.data);
      // setTenantStats(tenantRes.data);
      // setOutbox(outboxRes.data);
      // setAlerts(alertsRes.data);
      // setHourlyData(hourlyRes.data);

      setStats(MOCK_STATS);
      setTenantStats(MOCK_TENANT_STATS);
      setOutbox(MOCK_OUTBOX);
      setAlerts(MOCK_ALERTS);
      setHourlyData(MOCK_HOURLY);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to fetch messaging monitoring data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      void fetchData();
    }, 30_000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchData]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Messaging Monitoring</h1>
          <p className="text-sm text-gray-500 mt-1">
            Real-time overview of the messaging service
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Auto-refresh (30s)
          </label>
          <Button
            onClick={() => void fetchData()}
            disabled={loading}
            variant="secondary"
            size="sm"
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </Button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard title="Messages Today" value={stats.totalMessagesToday.toLocaleString()} color="blue" />
        <StatCard title="Active Channels" value={stats.activeChannels.toLocaleString()} color="green" />
        <StatCard title="Online Users" value={stats.onlineUsers.toLocaleString()} color="purple" />
        <StatCard
          title="Media Storage"
          value={`${stats.mediaStorageUsedMB.toFixed(1)} MB`}
          color="yellow"
        />
        <StatCard
          title="WS Connections"
          value={stats.wsConnectionsCurrent}
          subtitle={`Peak: ${stats.wsConnectionsPeakToday}`}
          color="blue"
        />
        <StatCard
          title="Outbox Pending"
          value={outbox.pendingEvents}
          subtitle={outbox.failedEvents > 0 ? `${outbox.failedEvents} failed` : undefined}
          color={outbox.failedEvents > 0 ? 'red' : 'green'}
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <div className="p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">Messages Per Hour</h3>
            <SimpleBarChart data={hourlyData} />
          </div>
        </Card>

        <Card>
          <div className="p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">Outbox Health</h3>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-600">Pending Events</span>
                <Badge variant={outbox.pendingEvents > 100 ? 'warning' : 'success'}>
                  {outbox.pendingEvents}
                </Badge>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-600">Failed Events</span>
                <Badge variant={outbox.failedEvents > 0 ? 'error' : 'success'}>
                  {outbox.failedEvents}
                </Badge>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-600">Avg Publish Latency</span>
                <Badge variant={outbox.avgPublishLatencyMs > 500 ? 'warning' : 'success'}>
                  {outbox.avgPublishLatencyMs.toFixed(0)} ms
                </Badge>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Per-Tenant Breakdown */}
      <Card>
        <div className="p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Per-Tenant Breakdown</h3>
          {tenantStats.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">
              No tenant messaging data available yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tenant</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Messages</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Channels</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Storage (MB)</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Last Activity</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {tenantStats.map((t) => (
                    <tr key={t.tenantId} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{t.tenantName}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right">{t.messageCount.toLocaleString()}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right">{t.channelCount}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right">{t.storageUsedMB.toFixed(1)}</td>
                      <td className="px-4 py-3 text-sm text-gray-500 text-right">
                        {new Date(t.lastActivity).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      {/* System Alerts */}
      <Card>
        <div className="p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">System Alerts</h3>
          {alerts.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <div className="text-center">
                <svg className="w-10 h-10 text-green-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-sm text-gray-500">All systems operational</p>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {alerts.map((alert) => (
                <div
                  key={alert.id}
                  className="flex items-center justify-between p-3 rounded-lg bg-gray-50 border border-gray-100"
                >
                  <div className="flex items-center gap-3">
                    <SeverityBadge severity={alert.severity} />
                    <span className="text-sm text-gray-700">{alert.message}</span>
                  </div>
                  <span className="text-xs text-gray-400">
                    {new Date(alert.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};

export default MessagingMonitoringPage;
