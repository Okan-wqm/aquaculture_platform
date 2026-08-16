import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card } from '@aquaculture/shared-ui';
import { systemSettingsApi } from '../../services/adminApi';
import type { PerformanceDashboard } from '../../services/adminApi';
import { adminApiErrorMessage } from '../../services/http-client';

const REFRESH_INTERVAL_MS = 30_000;

const PerformanceDashboardPage: React.FC = () => {
  const [dashboard, setDashboard] = useState<PerformanceDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const loadDashboard = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setDashboard(await systemSettingsApi.getPerformanceDashboard());
      setLastUpdated(new Date());
    } catch (cause: unknown) {
      setDashboard(null);
      setError(adminApiErrorMessage(cause, 'Failed to load performance data.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const intervalId = window.setInterval(() => {
      void loadDashboard();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [autoRefresh, loadDashboard]);

  const snapshot = dashboard?.currentSnapshot ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Performance Dashboard</h1>
          <p className="mt-1 text-sm text-gray-500">
            Application, database, infrastructure, and threshold state from the latest snapshot.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
            />
            Auto refresh
          </label>
          <Button
            size="sm"
            variant="secondary"
            disabled={loading}
            onClick={() => void loadDashboard()}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </Button>
        </div>
      </div>

      {lastUpdated && (
        <p className="text-xs text-gray-500">Last updated {lastUpdated.toLocaleString()}</p>
      )}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <div className="p-5">
            <p className="text-sm text-gray-500">Health score</p>
            <p className="mt-1 text-3xl font-bold text-gray-900">{dashboard?.healthScore ?? '—'}</p>
          </div>
        </Card>
        <Card>
          <div className="p-5">
            <p className="text-sm text-gray-500">Average response</p>
            <p className="mt-1 text-3xl font-bold text-gray-900">
              {snapshot ? `${Math.round(snapshot.applicationMetrics.avgResponseTime)} ms` : '—'}
            </p>
          </div>
        </Card>
        <Card>
          <div className="p-5">
            <p className="text-sm text-gray-500">Error rate</p>
            <p className="mt-1 text-3xl font-bold text-gray-900">
              {snapshot ? `${snapshot.applicationMetrics.errorRate.toFixed(2)}%` : '—'}
            </p>
          </div>
        </Card>
        <Card>
          <div className="p-5">
            <p className="text-sm text-gray-500">Throughput</p>
            <p className="mt-1 text-3xl font-bold text-gray-900">
              {snapshot ? snapshot.applicationMetrics.throughput.toLocaleString() : '—'}
            </p>
          </div>
        </Card>
      </div>

      {snapshot && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <div className="border-b border-gray-200 p-4">
              <h2 className="font-semibold text-gray-900">Database</h2>
            </div>
            <dl className="grid grid-cols-2 gap-4 p-5 text-sm">
              <div>
                <dt className="text-gray-500">Pool utilization</dt>
                <dd className="font-semibold">
                  {snapshot.databaseMetrics.poolUtilization.toFixed(1)}%
                </dd>
              </div>
              <div>
                <dt className="text-gray-500">Active connections</dt>
                <dd className="font-semibold">{snapshot.databaseMetrics.activeConnections}</dd>
              </div>
              <div>
                <dt className="text-gray-500">Average query</dt>
                <dd className="font-semibold">
                  {snapshot.databaseMetrics.avgQueryTime.toFixed(1)} ms
                </dd>
              </div>
              <div>
                <dt className="text-gray-500">Slow queries</dt>
                <dd className="font-semibold">{snapshot.databaseMetrics.slowQueryCount}</dd>
              </div>
            </dl>
          </Card>
          <Card>
            <div className="border-b border-gray-200 p-4">
              <h2 className="font-semibold text-gray-900">Infrastructure</h2>
            </div>
            <dl className="grid grid-cols-2 gap-4 p-5 text-sm">
              <div>
                <dt className="text-gray-500">CPU</dt>
                <dd className="font-semibold">
                  {snapshot.infrastructureMetrics.cpuUsage.toFixed(1)}%
                </dd>
              </div>
              <div>
                <dt className="text-gray-500">Memory</dt>
                <dd className="font-semibold">
                  {snapshot.infrastructureMetrics.memoryUsage.toFixed(1)}%
                </dd>
              </div>
              <div>
                <dt className="text-gray-500">Disk</dt>
                <dd className="font-semibold">
                  {snapshot.infrastructureMetrics.diskUsage.toFixed(1)}%
                </dd>
              </div>
              <div>
                <dt className="text-gray-500">Healthy containers</dt>
                <dd className="font-semibold">
                  {snapshot.infrastructureMetrics.healthyContainers}/
                  {snapshot.infrastructureMetrics.containerCount}
                </dd>
              </div>
            </dl>
          </Card>
        </div>
      )}

      <Card>
        <div className="border-b border-gray-200 p-4">
          <h2 className="font-semibold text-gray-900">Service breakdown</h2>
        </div>
        <div className="divide-y divide-gray-100">
          {dashboard?.serviceBreakdown.map((service) => (
            <div key={service.service} className="grid grid-cols-4 gap-3 p-4 text-sm">
              <span className="font-medium text-gray-900">{service.service}</span>
              <span>{service.avgResponseTime.toFixed(1)} ms</span>
              <span>{service.errorRate.toFixed(2)}% errors</span>
              <span>{service.requestCount.toLocaleString()} requests</span>
            </div>
          ))}
          {!dashboard?.serviceBreakdown.length && (
            <p className="p-6 text-center text-sm text-gray-500">No service metrics available.</p>
          )}
        </div>
      </Card>

      <Card>
        <div className="border-b border-gray-200 p-4">
          <h2 className="font-semibold text-gray-900">Active thresholds</h2>
        </div>
        <div className="divide-y divide-gray-100">
          {dashboard?.alerts.map((alert) => (
            <div
              key={`${alert.metric}-${alert.threshold}`}
              className="flex items-center justify-between p-4 text-sm"
            >
              <div>
                <p className="font-medium text-gray-900">{alert.metric}</p>
                <p className="text-gray-500">
                  {alert.currentValue} / {alert.threshold}
                </p>
              </div>
              <Badge variant={alert.severity === 'critical' ? 'error' : 'warning'}>
                {alert.severity}
              </Badge>
            </div>
          ))}
          {!dashboard?.alerts.length && (
            <p className="p-6 text-center text-sm text-gray-500">No active threshold alerts.</p>
          )}
        </div>
      </Card>
    </div>
  );
};

export { PerformanceDashboardPage };
export default PerformanceDashboardPage;
