/**
 * Analytics Dashboard Page
 *
 * Comprehensive analytics dashboard with KPIs, charts, and trends.
 * Displays Tenant, User, Financial, and System metrics.
 * Connected to real backend API endpoints.
 */

import { Card, Button, getAdminRoute } from '@aquaculture/shared-ui';
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { analyticsApi } from '../services/adminApi';
import {
  beginAdminRead,
  settleAdminRead,
  type AdminReadState,
} from '../services/admin-read-evidence';
import type {
  AnalyticsGranularity,
  AnalyticsRange,
  DashboardSummary,
  TimeSeriesPoint,
} from '../services/types';

// ============================================================================
// KPI Card Component
// ============================================================================

interface KpiCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  change?: number;
  trend?: 'up' | 'down' | 'stable';
  icon: React.ReactNode;
  color?: string;
}

const KpiCard: React.FC<KpiCardProps> = ({
  title,
  value,
  subtitle,
  change,
  trend,
  icon,
  color = 'blue',
}) => {
  const colorClasses: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-600',
    green: 'bg-green-50 text-green-600',
    purple: 'bg-purple-50 text-purple-600',
    orange: 'bg-orange-50 text-orange-600',
    red: 'bg-red-50 text-red-600',
    indigo: 'bg-indigo-50 text-indigo-600',
  };

  const getTrendColor = (): string => {
    if (trend === 'up') return 'text-green-600';
    if (trend === 'down') return 'text-red-600';
    return 'text-gray-500';
  };

  const getTrendIcon = (): string => {
    if (trend === 'up') return '↑';
    if (trend === 'down') return '↓';
    return '→';
  };

  return (
    <Card className="relative overflow-hidden">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-sm font-medium text-gray-500">{title}</p>
          <p className="mt-2 text-3xl font-bold text-gray-900">{value}</p>
          {subtitle && <p className="mt-1 text-sm text-gray-500">{subtitle}</p>}
          {change !== undefined && (
            <p className={`mt-2 text-sm font-medium ${getTrendColor()}`}>
              <span className="mr-1">{getTrendIcon()}</span>
              {Math.abs(change).toFixed(1)}%
              <span className="ml-1 text-gray-500">vs last month</span>
            </p>
          )}
        </div>
        <div className={`p-3 rounded-lg ${colorClasses[color] || colorClasses.blue}`}>{icon}</div>
      </div>
    </Card>
  );
};

// ============================================================================
// Mini Chart Component
// ============================================================================

interface MiniChartProps {
  data: readonly TimeSeriesPoint[];
  height?: number;
  color?: string;
}

const MiniChart: React.FC<MiniChartProps> = ({ data, height = 60, color = '#3B82F6' }) => {
  if (data.length === 0) return null;

  const values = data.map((d) => d.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const denominator = Math.max(data.length - 1, 1);

  const points = data
    .map((d, i) => {
      const x = (i / denominator) * 100;
      const y = height - ((d.value - min) / range) * height;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <svg width="100%" height={height} className="overflow-visible">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

// ============================================================================
// Bar Chart Component
// ============================================================================

interface BarChartProps {
  data: Array<{ label: string; value: number; color?: string }>;
  maxHeight?: number;
}

const BarChart: React.FC<BarChartProps> = ({ data, maxHeight = 120 }) => {
  const maxValue = Math.max(...data.map((d) => d.value)) || 1;

  return (
    <div className="flex items-end justify-around gap-2 h-full">
      {data.map((item, index) => {
        const height = (item.value / maxValue) * maxHeight;
        const colors = [
          'bg-blue-500',
          'bg-green-500',
          'bg-purple-500',
          'bg-orange-500',
          'bg-pink-500',
        ];
        return (
          <div key={index} className="flex flex-col items-center flex-1">
            <div
              className={`w-full rounded-t ${colors[index % colors.length]}`}
              style={{ height: `${height}px` }}
            />
            <p className="text-xs text-gray-500 mt-2 truncate w-full text-center">{item.label}</p>
          </div>
        );
      })}
    </div>
  );
};

// ============================================================================
// Donut Chart Component
// ============================================================================

interface DonutChartProps {
  data: Array<{ label: string; value: number; color: string }>;
  size?: number;
  strokeWidth?: number;
  centerLabel?: string;
  centerValue?: string;
}

const DonutChart: React.FC<DonutChartProps> = ({
  data,
  size = 160,
  strokeWidth = 24,
  centerLabel,
  centerValue,
}) => {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  let currentOffset = 0;

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="transform -rotate-90">
        {total === 0 ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="#E5E7EB"
            strokeWidth={strokeWidth}
          />
        ) : (
          data.map((item, index) => {
            const percentage = item.value / total;
            const strokeLength = circumference * percentage;
            const offset = currentOffset;
            currentOffset += strokeLength;

            return (
              <circle
                key={index}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={item.color}
                strokeWidth={strokeWidth}
                strokeDasharray={`${strokeLength} ${circumference - strokeLength}`}
                strokeDashoffset={-offset}
                strokeLinecap="round"
              />
            );
          })
        )}
      </svg>
      {(centerLabel || centerValue) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {centerValue && <span className="text-2xl font-bold text-gray-900">{centerValue}</span>}
          {centerLabel && <span className="text-xs text-gray-500">{centerLabel}</span>}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Analytics Dashboard Page
// ============================================================================

const AnalyticsDashboardPage: React.FC = () => {
  const [selectedPeriod, setSelectedPeriod] = useState<AnalyticsRange>('30d');
  type AnalyticsTrendResponse = Awaited<ReturnType<typeof analyticsApi.getTenantGrowthTrend>>;
  const [dashboardRead, setDashboardRead] = useState<AdminReadState<DashboardSummary>>(() =>
    beginAdminRead('admin.analytics.dashboard.v1', { projection: 'dashboard' }),
  );
  const [tenantTrendRead, setTenantTrendRead] = useState<AdminReadState<AnalyticsTrendResponse>>(
    () => beginAdminRead('admin.analytics.snapshot-trend.v1', { metric: 'tenants.total' }),
  );
  const [revenueTrendRead, setRevenueTrendRead] = useState<AdminReadState<AnalyticsTrendResponse>>(
    () => beginAdminRead('admin.analytics.snapshot-trend.v1', { metric: 'financial.mrr' }),
  );
  const [userTrendRead, setUserTrendRead] = useState<AdminReadState<AnalyticsTrendResponse>>(() =>
    beginAdminRead('admin.analytics.snapshot-trend.v1', { metric: 'users.activeLastDay' }),
  );

  const loadData = useCallback(async () => {
    const granularity: AnalyticsGranularity =
      selectedPeriod === '1y' ? 'month' : selectedPeriod === '90d' ? 'week' : 'day';
    const dashboardPending = beginAdminRead('admin.analytics.dashboard.v1', {
      projection: 'dashboard',
    });
    const tenantPending = beginAdminRead('admin.analytics.snapshot-trend.v1', {
      metric: 'tenants.total',
      range: selectedPeriod,
      granularity,
    });
    const revenuePending = beginAdminRead('admin.analytics.snapshot-trend.v1', {
      metric: 'financial.mrr',
      range: selectedPeriod,
      granularity,
    });
    const userPending = beginAdminRead('admin.analytics.snapshot-trend.v1', {
      metric: 'users.activeLastDay',
      range: selectedPeriod,
      granularity,
    });
    setDashboardRead(dashboardPending);
    setTenantTrendRead(tenantPending);
    setRevenueTrendRead(revenuePending);
    setUserTrendRead(userPending);

    const [dashboardResponse, tenantTrendResponse, revenueTrendResponse, userActivityResponse] =
      await Promise.allSettled([
        analyticsApi.getDashboardSummary(),
        analyticsApi.getTenantGrowthTrend(selectedPeriod, granularity),
        analyticsApi.getRevenueTrend(selectedPeriod, granularity),
        analyticsApi.getUserActivity(selectedPeriod, granularity),
      ]);

    setDashboardRead(settleAdminRead(dashboardPending, dashboardResponse));
    setTenantTrendRead(settleAdminRead(tenantPending, tenantTrendResponse));
    setRevenueTrendRead(settleAdminRead(revenuePending, revenueTrendResponse));
    setUserTrendRead(settleAdminRead(userPending, userActivityResponse));
  }, [selectedPeriod]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const formatCurrency = (value: number | null): string => {
    if (value === null) return '—';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const formatNumber = (value: number | null): string => {
    if (value === null) return '—';
    return new Intl.NumberFormat('en-US').format(value);
  };

  const formatPercent = (value: number | null): string =>
    value === null ? '—' : `${formatNumber(value)}%`;

  const formatMilliseconds = (value: number | null): string =>
    value === null ? '—' : `${formatNumber(value)}ms`;

  const trendFor = (value: number | null): 'up' | 'down' | 'stable' | undefined =>
    value === null ? undefined : value > 0 ? 'up' : value < 0 ? 'down' : 'stable';

  const formatBytes = (bytes: number | null): string => {
    if (bytes === null) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unitIndex = 0;
    let value = bytes;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }
    return `${value.toFixed(1)} ${units[unitIndex]}`;
  };

  if (dashboardRead.outcome === 'PENDING') {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (dashboardRead.outcome === 'REJECTED') {
    return (
      <div className="flex h-96 flex-col items-center justify-center gap-4 text-center">
        <p className="text-lg font-semibold text-red-700">Analytics authority rejected the read</p>
        <p className="max-w-xl text-sm text-gray-600">
          {dashboardRead.evidence.failure.message}
          {dashboardRead.evidence.failure.requestId
            ? ` (request ${dashboardRead.evidence.failure.requestId})`
            : ''}
        </p>
        <Button variant="secondary" onClick={() => void loadData()}>
          Retry verified read
        </Button>
      </div>
    );
  }

  const data = dashboardRead.value;
  const tenantTrend = tenantTrendRead.outcome === 'VERIFIED' ? tenantTrendRead.value.data : [];
  const revenueTrend = revenueTrendRead.outcome === 'VERIFIED' ? revenueTrendRead.value.data : [];
  const userTrend = userTrendRead.outcome === 'VERIFIED' ? userTrendRead.value.data : [];
  const unavailableMetricIds = [
    data.tenants.authority.measurementEvidence,
    data.users.authority.measurementEvidence,
    data.financial.authority.measurementEvidence,
    data.system.authority.measurementEvidence,
    data.usage.authority.measurementEvidence,
  ]
    .flatMap((evidence) => Object.values(evidence))
    .filter((evidence) => evidence.state === 'UNAVAILABLE')
    .map((evidence) => evidence.metricId);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Analytics Dashboard</h1>
          <p className="text-gray-500 mt-1">Platform metrikleri ve performans analizi</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex bg-gray-100 rounded-lg p-1">
            {(['7d', '30d', '90d', '1y'] as const).map((period) => (
              <button
                key={period}
                onClick={() => setSelectedPeriod(period)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  selectedPeriod === period
                    ? 'bg-white text-gray-900 shadow'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {period}
              </button>
            ))}
          </div>
          <Button
            variant="secondary"
            onClick={() => {
              void loadData();
            }}
          >
            Refresh
          </Button>
          <Link to={getAdminRoute('analytics-reports').path}>
            <Button variant="primary">Reports</Button>
          </Link>
        </div>
      </div>

      {data.unavailable && data.unavailable.length > 0 && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
          Partial analytics data: {data.unavailable.join(', ')}
        </div>
      )}

      {unavailableMetricIds.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          Unqualified metrics are shown as unavailable, never as zero:{' '}
          {unavailableMetricIds.join(', ')}
        </div>
      )}

      {/* Main KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title="Total Tenants"
          value={formatNumber(data.tenants.total)}
          subtitle={`${formatNumber(data.tenants.active)} aktif`}
          change={data.tenants.growthRate ?? undefined}
          trend={trendFor(data.tenants.growthRate)}
          color="blue"
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
              />
            </svg>
          }
        />
        <KpiCard
          title="Total Users"
          value={formatNumber(data.users.total)}
          subtitle={`${formatNumber(data.users.activeLastDay)} DAU`}
          change={data.users.growthRate ?? undefined}
          trend={trendFor(data.users.growthRate)}
          color="green"
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
              />
            </svg>
          }
        />
        <KpiCard
          title="MRR"
          value={formatCurrency(data.financial.mrr)}
          subtitle={`ARR: ${formatCurrency(data.financial.arr)}`}
          change={data.financial.revenueGrowthRate ?? undefined}
          trend={trendFor(data.financial.revenueGrowthRate)}
          color="purple"
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          }
        />
        <KpiCard
          title="Uptime"
          value={formatPercent(data.system.uptimePercent)}
          subtitle={`Error rate: ${formatPercent(data.system.errorRate)}`}
          color="orange"
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
              />
            </svg>
          }
        />
      </div>

      {/* Second Row KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title="ARPU"
          value={formatCurrency(data.financial.arpu)}
          subtitle="Revenue per user"
          color="indigo"
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
              />
            </svg>
          }
        />
        <KpiCard
          title="Churn Rate"
          value={formatPercent(data.tenants.churnRate)}
          subtitle={`${formatNumber(data.tenants.churnedThisMonth)} churned this month`}
          color="red"
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6"
              />
            </svg>
          }
        />
        <KpiCard
          title="Bekleyen Odemeler"
          value={formatCurrency(data.financial.pendingPayments)}
          subtitle={`${formatCurrency(data.financial.overduePayments)} overdue`}
          color="orange"
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          }
        />
        <KpiCard
          title="API Calls (Today)"
          value={formatNumber(data.system.apiCallsToday)}
          subtitle={`Avg: ${formatMilliseconds(data.system.avgResponseTimeMs)}`}
          color="blue"
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
          }
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Tenant Growth Chart */}
        <Card title="Tenant Growth">
          <div className="h-32 mb-4 relative">
            <MiniChart data={tenantTrend} height={100} color="#3B82F6" />
            {tenantTrend.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-50/80 rounded">
                <p className="text-sm text-gray-500">
                  {tenantTrendRead.outcome === 'REJECTED'
                    ? `Trend read rejected: ${tenantTrendRead.evidence.failure.message}`
                    : 'No catalog-qualified snapshots in this range'}
                </p>
              </div>
            )}
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">Bu ay: {formatNumber(data.tenants.newThisMonth)}</span>
            <span className="text-gray-600 font-medium">
              {formatPercent(data.tenants.growthRate)}
            </span>
          </div>
        </Card>

        {/* Revenue Trend Chart */}
        <Card title="Revenue Trend">
          <div className="h-32 mb-4 relative">
            <MiniChart data={revenueTrend} height={100} color="#8B5CF6" />
            {revenueTrend.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-50/80 rounded">
                <p className="text-sm text-gray-500">
                  {revenueTrendRead.outcome === 'REJECTED'
                    ? `Trend read rejected: ${revenueTrendRead.evidence.failure.message}`
                    : 'No catalog-qualified snapshots in this range'}
                </p>
              </div>
            )}
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">MRR: {formatCurrency(data.financial.mrr)}</span>
            <span className="text-gray-600 font-medium">
              {formatPercent(data.financial.revenueGrowthRate)}
            </span>
          </div>
        </Card>

        <Card title="Daily Active Users">
          <div className="h-32 mb-4 relative">
            <MiniChart data={userTrend} height={100} color="#10B981" />
            {userTrend.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-50/80 rounded">
                <p className="text-sm text-gray-500">
                  {userTrendRead.outcome === 'REJECTED'
                    ? `Trend read rejected: ${userTrendRead.evidence.failure.message}`
                    : 'No catalog-qualified snapshots in this range'}
                </p>
              </div>
            )}
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">DAU: {formatNumber(data.users.activeLastDay)}</span>
          </div>
        </Card>
      </div>

      {/* Distribution Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Plan Distribution */}
        <Card title="Plan Dagilimi">
          {data.tenants.byPlan === null ? (
            <p className="py-8 text-center text-sm text-gray-500">
              tenants.byPlan is unavailable from its declared authority
            </p>
          ) : (
            <div className="flex items-center justify-between">
              <DonutChart
                data={[
                  {
                    label: 'Enterprise',
                    value: data.tenants.byPlan.enterprise ?? 0,
                    color: '#8B5CF6',
                  },
                  {
                    label: 'Professional',
                    value: data.tenants.byPlan.professional ?? 0,
                    color: '#10B981',
                  },
                  {
                    label: 'Starter',
                    value: data.tenants.byPlan.starter ?? 0,
                    color: '#3B82F6',
                  },
                  {
                    label: 'Trial',
                    value: data.tenants.byPlan.trial ?? 0,
                    color: '#F59E0B',
                  },
                ]}
                centerValue={formatNumber(data.tenants.total)}
                centerLabel="Total"
              />
              <div className="flex-1 ml-8 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center">
                    <span className="w-3 h-3 rounded-full bg-purple-500 mr-2" />
                    <span className="text-sm text-gray-600">Enterprise</span>
                  </div>
                  <span className="font-medium">{data.tenants.byPlan.enterprise ?? 0}</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center">
                    <span className="w-3 h-3 rounded-full bg-green-500 mr-2" />
                    <span className="text-sm text-gray-600">Professional</span>
                  </div>
                  <span className="font-medium">{data.tenants.byPlan.professional ?? 0}</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center">
                    <span className="w-3 h-3 rounded-full bg-blue-500 mr-2" />
                    <span className="text-sm text-gray-600">Starter</span>
                  </div>
                  <span className="font-medium">{data.tenants.byPlan.starter ?? 0}</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center">
                    <span className="w-3 h-3 rounded-full bg-orange-500 mr-2" />
                    <span className="text-sm text-gray-600">Trial</span>
                  </div>
                  <span className="font-medium">{data.tenants.byPlan.trial ?? 0}</span>
                </div>
              </div>
            </div>
          )}
        </Card>

        {/* Revenue by Plan */}
        <Card title="Revenue by Plan">
          {data.financial.byPlan === null ? (
            <p className="py-8 text-center text-sm text-gray-500">
              financial.byPlan is unavailable from its declared authority
            </p>
          ) : (
            <>
              <div className="h-40">
                <BarChart
                  data={[
                    { label: 'Starter', value: data.financial.byPlan.starter ?? 0 },
                    { label: 'Professional', value: data.financial.byPlan.professional ?? 0 },
                    { label: 'Enterprise', value: data.financial.byPlan.enterprise ?? 0 },
                  ]}
                  maxHeight={120}
                />
              </div>
              <div className="mt-4 pt-4 border-t grid grid-cols-3 gap-4 text-center">
                <div>
                  <p className="text-lg font-bold text-gray-900">
                    {formatCurrency(data.financial.byPlan.starter ?? 0)}
                  </p>
                  <p className="text-xs text-gray-500">Starter</p>
                </div>
                <div>
                  <p className="text-lg font-bold text-gray-900">
                    {formatCurrency(data.financial.byPlan.professional ?? 0)}
                  </p>
                  <p className="text-xs text-gray-500">Professional</p>
                </div>
                <div>
                  <p className="text-lg font-bold text-gray-900">
                    {formatCurrency(data.financial.byPlan.enterprise ?? 0)}
                  </p>
                  <p className="text-xs text-gray-500">Enterprise</p>
                </div>
              </div>
            </>
          )}
        </Card>
      </div>

      {/* Module Usage & Feature Adoption */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Module Usage */}
        <Card title="Module Usage">
          {data.usage.moduleUsage === null ? (
            <div className="flex items-center justify-center py-8">
              <p className="text-sm text-gray-500">usage.moduleUsage authority is not integrated</p>
            </div>
          ) : (
            <div className="space-y-4">
              {Object.entries(data.usage.moduleUsage).map(([module, stats]) => {
                const percentage =
                  data.users.active !== null && data.users.active > 0
                    ? Math.round((stats.activeUsers / data.users.active) * 100)
                    : null;
                return (
                  <div key={module}>
                    <div className="flex justify-between mb-1">
                      <span className="text-sm font-medium text-gray-700">
                        {module
                          .split('_')
                          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
                          .join(' ')}
                      </span>
                      <span className="text-sm text-gray-500">{stats.activeUsers} users</span>
                    </div>
                    {percentage === null ? (
                      <p className="text-xs text-gray-500">Active-user denominator unavailable</p>
                    ) : (
                      <div className="w-full bg-gray-200 rounded-full h-2">
                        <div
                          className="bg-blue-600 h-2 rounded-full"
                          style={{ width: `${percentage}%` }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* Feature Adoption */}
        <Card title="Feature Adoption">
          {data.usage.topFeatures === null ? (
            <div className="flex items-center justify-center py-8">
              <p className="text-sm text-gray-500">usage.topFeatures authority is not integrated</p>
            </div>
          ) : (
            <div className="space-y-4">
              {data.usage.topFeatures.map((feature) => (
                <div key={feature.feature}>
                  <div className="flex justify-between mb-1">
                    <span className="text-sm font-medium text-gray-700">{feature.feature}</span>
                    <span className="text-sm text-gray-500">{feature.usage}%</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div
                      className="bg-green-600 h-2 rounded-full"
                      style={{ width: `${feature.usage}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* System Metrics */}
      <Card title="System Metrics">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
          <div className="text-center p-4 bg-gray-50 rounded-lg">
            <p className="text-2xl font-bold text-gray-900">
              {formatPercent(data.system.uptimePercent)}
            </p>
            <p className="text-xs text-gray-500 mt-1">Uptime</p>
          </div>
          <div className="text-center p-4 bg-gray-50 rounded-lg">
            <p className="text-2xl font-bold text-gray-900">
              {formatMilliseconds(data.system.avgResponseTimeMs)}
            </p>
            <p className="text-xs text-gray-500 mt-1">Avg Response</p>
          </div>
          <div className="text-center p-4 bg-gray-50 rounded-lg">
            <p className="text-2xl font-bold text-gray-900">
              {formatPercent(data.system.errorRate)}
            </p>
            <p className="text-xs text-gray-500 mt-1">Error Rate</p>
          </div>
          <div className="text-center p-4 bg-gray-50 rounded-lg">
            <p className="text-2xl font-bold text-gray-900">
              {formatBytes(data.system.usedStorageBytes)}
            </p>
            <p className="text-xs text-gray-500 mt-1">Storage Used</p>
          </div>
          <div className="text-center p-4 bg-gray-50 rounded-lg">
            <p className="text-2xl font-bold text-gray-900">
              {formatNumber(data.system.activeConnections)}
            </p>
            <p className="text-xs text-gray-500 mt-1">Active Connections</p>
          </div>
          <div className="text-center p-4 bg-gray-50 rounded-lg">
            <p className="text-2xl font-bold text-gray-900">
              {formatNumber(data.system.queuedJobs)}
            </p>
            <p className="text-xs text-gray-500 mt-1">Queued Jobs</p>
          </div>
        </div>
      </Card>

      {/* Regional Distribution */}
      <Card title="Bolgesel Dagilim">
        {data.tenants.byRegion === null ? (
          <p className="py-8 text-center text-sm text-gray-500">
            tenants.byRegion authority is not integrated
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {Object.entries(data.tenants.byRegion).map(([region, count]) => (
              <div key={region} className="text-center p-4 bg-gray-50 rounded-lg">
                <p className="text-3xl font-bold text-gray-900">{count}</p>
                <p className="text-sm text-gray-500 mt-1">{region}</p>
                <p className="text-xs text-gray-500">
                  {data.tenants.total !== null && data.tenants.total > 0
                    ? ((count / data.tenants.total) * 100).toFixed(1)
                    : '—'}
                  {data.tenants.total !== null && data.tenants.total > 0 ? '%' : ''}
                </p>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Footer */}
      <div className="text-center text-sm text-gray-500">
        Last updated: {new Date(data.generatedAt).toLocaleString('en-US')}
      </div>
    </div>
  );
};

export default AnalyticsDashboardPage;
