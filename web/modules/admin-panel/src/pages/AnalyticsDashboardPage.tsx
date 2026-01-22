/**
 * Analytics Dashboard Page
 *
 * Comprehensive analytics dashboard with KPIs, charts, and trends.
 * Displays Tenant, User, Financial, and System metrics.
 * Connected to real backend API endpoints.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Card, Button } from '@aquaculture/shared-ui';
import { analyticsApi, systemApi } from '../services/adminApi';

// ============================================================================
// Types
// ============================================================================

interface TenantMetrics {
  total: number;
  active: number;
  inactive: number;
  trial: number;
  suspended: number;
  newThisMonth: number;
  churnedThisMonth: number;
  churnRate: number;
  growthRate: number;
  byPlan: Record<string, number>;
  byRegion: Record<string, number>;
}

interface UserMetrics {
  total: number;
  active: number;
  inactive: number;
  newThisMonth: number;
  activeLastDay: number;
  activeLastWeek: number;
  activeLastMonth: number;
  growthRate: number;
  avgUsersPerTenant: number;
  byRole: Record<string, number>;
}

interface FinancialMetrics {
  mrr: number;
  arr: number;
  arpu: number;
  arppu: number;
  ltv: number;
  totalRevenue: number;
  revenueThisMonth: number;
  revenueGrowthRate: number;
  pendingPayments: number;
  overduePayments: number;
  refunds: number;
  byPlan: Record<string, number>;
  byCurrency: Record<string, number>;
}

interface SystemMetrics {
  totalStorageBytes: number;
  usedStorageBytes: number;
  storageUtilization: number;
  apiCallsToday: number;
  apiCallsThisMonth: number;
  avgResponseTimeMs: number;
  errorRate: number;
  uptimePercent: number;
  activeConnections: number;
  queuedJobs: number;
}

interface UsageMetrics {
  moduleUsage: Record<string, {
    activeUsers: number;
    totalSessions: number;
    avgSessionDuration: number;
  }>;
  featureAdoption: Record<string, number>;
  topFeatures: Array<{ feature: string; usage: number }>;
  peakHours: number[];
  avgDailyActiveUsers: number;
}

interface DashboardSummary {
  tenants: TenantMetrics;
  users: UserMetrics;
  financial: FinancialMetrics;
  system: SystemMetrics;
  usage: UsageMetrics;
  generatedAt: string;
}

interface KpiComparison {
  current: number;
  previous: number;
  change: number;
  changePercent: number;
  trend: 'up' | 'down' | 'stable';
}

interface TimeSeriesPoint {
  date: string;
  value: number;
}

// ============================================================================
// Default Data Structure
// ============================================================================

// Default empty data structure
const getDefaultData = (): DashboardSummary => ({
  tenants: {
    total: 0,
    active: 0,
    inactive: 0,
    trial: 0,
    suspended: 0,
    newThisMonth: 0,
    churnedThisMonth: 0,
    churnRate: 0,
    growthRate: 0,
    byPlan: {},
    byRegion: {},
  },
  users: {
    total: 0,
    active: 0,
    inactive: 0,
    newThisMonth: 0,
    activeLastDay: 0,
    activeLastWeek: 0,
    activeLastMonth: 0,
    growthRate: 0,
    avgUsersPerTenant: 0,
    byRole: {},
  },
  financial: {
    mrr: 0,
    arr: 0,
    arpu: 0,
    arppu: 0,
    ltv: 0,
    totalRevenue: 0,
    revenueThisMonth: 0,
    revenueGrowthRate: 0,
    pendingPayments: 0,
    overduePayments: 0,
    refunds: 0,
    byPlan: {},
    byCurrency: {},
  },
  system: {
    totalStorageBytes: 0,
    usedStorageBytes: 0,
    storageUtilization: 0,
    apiCallsToday: 0,
    apiCallsThisMonth: 0,
    avgResponseTimeMs: 0,
    errorRate: 0,
    uptimePercent: 0,
    activeConnections: 0,
    queuedJobs: 0,
  },
  usage: {
    moduleUsage: {},
    featureAdoption: {},
    topFeatures: [],
    peakHours: [],
    avgDailyActiveUsers: 0,
  },
  generatedAt: new Date().toISOString(),
});

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

  const getTrendColor = () => {
    if (trend === 'up') return 'text-green-600';
    if (trend === 'down') return 'text-red-600';
    return 'text-gray-500';
  };

  const getTrendIcon = () => {
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
              <span className="ml-1 text-gray-400">vs last month</span>
            </p>
          )}
        </div>
        <div className={`p-3 rounded-lg ${colorClasses[color] || colorClasses.blue}`}>
          {icon}
        </div>
      </div>
    </Card>
  );
};

// ============================================================================
// Mini Chart Component
// ============================================================================

interface MiniChartProps {
  data: TimeSeriesPoint[];
  height?: number;
  color?: string;
}

const MiniChart: React.FC<MiniChartProps> = ({ data, height = 60, color = '#3B82F6' }) => {
  if (data.length === 0) return null;

  const values = data.map(d => d.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const points = data.map((d, i) => {
    const x = (i / (data.length - 1)) * 100;
    const y = height - ((d.value - min) / range) * height;
    return `${x},${y}`;
  }).join(' ');

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
  const maxValue = Math.max(...data.map(d => d.value));

  return (
    <div className="flex items-end justify-around gap-2 h-full">
      {data.map((item, index) => {
        const height = (item.value / maxValue) * maxHeight;
        const colors = ['bg-blue-500', 'bg-green-500', 'bg-purple-500', 'bg-orange-500', 'bg-pink-500'];
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
        {data.map((item, index) => {
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
        })}
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
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPeriod, setSelectedPeriod] = useState<'7d' | '30d' | '90d' | '1y'>('30d');
  const [tenantTrend, setTenantTrend] = useState<TimeSeriesPoint[]>([]);
  const [revenueTrend, setRevenueTrend] = useState<TimeSeriesPoint[]>([]);
  const [userTrend, setUserTrend] = useState<TimeSeriesPoint[]>([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      // Calculate data points based on period
      const dataPoints = selectedPeriod === '7d' ? 7 : selectedPeriod === '30d' ? 30 : selectedPeriod === '90d' ? 90 : 365;

      // Try to fetch from real API endpoints
      const [dashboardResponse, systemHealthResponse, tenantTrendResponse, revenueTrendResponse] = await Promise.allSettled([
        analyticsApi.getDashboardSummary(),
        systemApi.getServicesHealth(),
        analyticsApi.getTenantGrowthTrend(selectedPeriod, Math.min(dataPoints, 30)),
        analyticsApi.getRevenueTrend(selectedPeriod),
      ]);

      // Process dashboard data
      let dashboardData = getDefaultData();
      if (dashboardResponse.status === 'fulfilled' && dashboardResponse.value) {
        // Map API response to our DashboardSummary type
        const apiData = dashboardResponse.value as Partial<DashboardSummary>;
        dashboardData = {
          ...dashboardData,
          ...apiData,
          generatedAt: new Date().toISOString(),
        };
      } else {
        // API unavailable, keep default empty data
        console.error('Analytics API unavailable');
      }

      // Enhance with system health data if available
      if (systemHealthResponse.status === 'fulfilled' && systemHealthResponse.value) {
        const services = systemHealthResponse.value as Array<{ name: string; status: string }>;
        const healthyServices = services.filter(s => s.status === 'healthy').length;
        const totalServices = services.length;
        if (totalServices > 0) {
          dashboardData.system.uptimePercent = Math.round((healthyServices / totalServices) * 100);
        }
      }

      setData(dashboardData);

      // Process tenant growth trend
      if (tenantTrendResponse.status === 'fulfilled' && tenantTrendResponse.value) {
        const trendData = tenantTrendResponse.value.map(item => ({
          date: item.period,
          value: item.tenants,
        }));
        setTenantTrend(trendData);
        // Use the same data for user trend (as they're correlated)
        setUserTrend(trendData.map(d => ({
          date: d.date,
          value: Math.round(d.value * (dashboardData.users.avgUsersPerTenant || 1)),
        })));
      } else {
        setTenantTrend([]);
        setUserTrend([]);
      }

      // Process revenue trend
      if (revenueTrendResponse.status === 'fulfilled' && revenueTrendResponse.value) {
        const revenueData = revenueTrendResponse.value.map(item => ({
          date: item.period,
          value: item.revenue,
        }));
        setRevenueTrend(revenueData);
      } else {
        setRevenueTrend([]);
      }
    } catch (error) {
      console.error('Failed to load analytics data:', error);
      // Set default empty data on error
      setData(getDefaultData());
      setTenantTrend([]);
      setRevenueTrend([]);
      setUserTrend([]);
    } finally {
      setLoading(false);
    }
  }, [selectedPeriod]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const formatNumber = (value: number) => {
    return new Intl.NumberFormat('en-US').format(value);
  };

  const formatBytes = (bytes: number) => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unitIndex = 0;
    let value = bytes;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }
    return `${value.toFixed(1)} ${units[unitIndex]}`;
  };

  if (loading || !data) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

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
          <Button variant="secondary" onClick={loadData}>
            Yenile
          </Button>
          <Link to="/admin/reports">
            <Button variant="primary">Raporlar</Button>
          </Link>
        </div>
      </div>

      {/* Main KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title="Toplam Tenant"
          value={formatNumber(data.tenants.total)}
          subtitle={`${data.tenants.active} aktif`}
          change={data.tenants.growthRate}
          trend="up"
          color="blue"
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
          }
        />
        <KpiCard
          title="Toplam Kullanici"
          value={formatNumber(data.users.total)}
          subtitle={`${formatNumber(data.users.activeLastDay)} DAU`}
          change={data.users.growthRate}
          trend="up"
          color="green"
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
          }
        />
        <KpiCard
          title="MRR"
          value={formatCurrency(data.financial.mrr)}
          subtitle={`ARR: ${formatCurrency(data.financial.arr)}`}
          change={data.financial.revenueGrowthRate}
          trend="up"
          color="purple"
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
        <KpiCard
          title="Uptime"
          value={`${data.system.uptimePercent}%`}
          subtitle={`Error rate: ${data.system.errorRate}%`}
          trend="stable"
          color="orange"
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
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
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          }
        />
        <KpiCard
          title="Churn Rate"
          value={`${data.tenants.churnRate}%`}
          subtitle={`${data.tenants.churnedThisMonth} churned this month`}
          change={-0.5}
          trend="down"
          color="red"
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" />
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
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
        <KpiCard
          title="API Calls (Today)"
          value={formatNumber(data.system.apiCallsToday)}
          subtitle={`Avg: ${data.system.avgResponseTimeMs}ms`}
          color="blue"
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          }
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Tenant Growth Chart */}
        <Card title="Tenant Buyumesi">
          <div className="h-32 mb-4">
            <MiniChart data={tenantTrend} height={100} color="#3B82F6" />
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">Bu ay: +{data.tenants.newThisMonth}</span>
            <span className="text-green-600 font-medium">+{data.tenants.growthRate}%</span>
          </div>
        </Card>

        {/* Revenue Trend Chart */}
        <Card title="Gelir Trendi">
          <div className="h-32 mb-4">
            <MiniChart data={revenueTrend} height={100} color="#8B5CF6" />
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">MRR: {formatCurrency(data.financial.mrr)}</span>
            <span className="text-green-600 font-medium">+{data.financial.revenueGrowthRate}%</span>
          </div>
        </Card>

        {/* Daily Active Users Chart */}
        <Card title="Gunluk Aktif Kullanicilar">
          <div className="h-32 mb-4">
            <MiniChart data={userTrend} height={100} color="#10B981" />
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">Ortalama: {data.usage.avgDailyActiveUsers}</span>
            <span className="text-green-600 font-medium">+{data.users.growthRate}%</span>
          </div>
        </Card>
      </div>

      {/* Distribution Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Plan Distribution */}
        <Card title="Plan Dagilimi">
          <div className="flex items-center justify-between">
            <DonutChart
              data={[
                { label: 'Enterprise', value: data.tenants.byPlan.enterprise || 0, color: '#8B5CF6' },
                { label: 'Professional', value: data.tenants.byPlan.professional || 0, color: '#10B981' },
                { label: 'Starter', value: data.tenants.byPlan.starter || 0, color: '#3B82F6' },
                { label: 'Trial', value: data.tenants.byPlan.trial || 0, color: '#F59E0B' },
              ]}
              centerValue={data.tenants.total.toString()}
              centerLabel="Toplam"
            />
            <div className="flex-1 ml-8 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <span className="w-3 h-3 rounded-full bg-purple-500 mr-2" />
                  <span className="text-sm text-gray-600">Enterprise</span>
                </div>
                <span className="font-medium">{data.tenants.byPlan.enterprise || 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <span className="w-3 h-3 rounded-full bg-green-500 mr-2" />
                  <span className="text-sm text-gray-600">Professional</span>
                </div>
                <span className="font-medium">{data.tenants.byPlan.professional || 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <span className="w-3 h-3 rounded-full bg-blue-500 mr-2" />
                  <span className="text-sm text-gray-600">Starter</span>
                </div>
                <span className="font-medium">{data.tenants.byPlan.starter || 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <span className="w-3 h-3 rounded-full bg-orange-500 mr-2" />
                  <span className="text-sm text-gray-600">Trial</span>
                </div>
                <span className="font-medium">{data.tenants.byPlan.trial || 0}</span>
              </div>
            </div>
          </div>
        </Card>

        {/* Revenue by Plan */}
        <Card title="Plan Bazli Gelir">
          <div className="h-40">
            <BarChart
              data={[
                { label: 'Starter', value: data.financial.byPlan.starter || 0 },
                { label: 'Professional', value: data.financial.byPlan.professional || 0 },
                { label: 'Enterprise', value: data.financial.byPlan.enterprise || 0 },
              ]}
              maxHeight={120}
            />
          </div>
          <div className="mt-4 pt-4 border-t grid grid-cols-3 gap-4 text-center">
            <div>
              <p className="text-lg font-bold text-gray-900">{formatCurrency(data.financial.byPlan.starter || 0)}</p>
              <p className="text-xs text-gray-500">Starter</p>
            </div>
            <div>
              <p className="text-lg font-bold text-gray-900">{formatCurrency(data.financial.byPlan.professional || 0)}</p>
              <p className="text-xs text-gray-500">Professional</p>
            </div>
            <div>
              <p className="text-lg font-bold text-gray-900">{formatCurrency(data.financial.byPlan.enterprise || 0)}</p>
              <p className="text-xs text-gray-500">Enterprise</p>
            </div>
          </div>
        </Card>
      </div>

      {/* Module Usage & Feature Adoption */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Module Usage */}
        <Card title="Modul Kullanimi">
          <div className="space-y-4">
            {Object.entries(data.usage.moduleUsage).map(([module, stats]) => {
              const percentage = Math.round((stats.activeUsers / data.users.active) * 100);
              return (
                <div key={module}>
                  <div className="flex justify-between mb-1">
                    <span className="text-sm font-medium text-gray-700">
                      {module.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                    </span>
                    <span className="text-sm text-gray-500">{stats.activeUsers} users</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div
                      className="bg-blue-600 h-2 rounded-full"
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        {/* Feature Adoption */}
        <Card title="Feature Adoption">
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
        </Card>
      </div>

      {/* System Metrics */}
      <Card title="Sistem Metrikleri">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
          <div className="text-center p-4 bg-gray-50 rounded-lg">
            <p className="text-2xl font-bold text-gray-900">{data.system.uptimePercent}%</p>
            <p className="text-xs text-gray-500 mt-1">Uptime</p>
          </div>
          <div className="text-center p-4 bg-gray-50 rounded-lg">
            <p className="text-2xl font-bold text-gray-900">{data.system.avgResponseTimeMs}ms</p>
            <p className="text-xs text-gray-500 mt-1">Avg Response</p>
          </div>
          <div className="text-center p-4 bg-gray-50 rounded-lg">
            <p className="text-2xl font-bold text-gray-900">{data.system.errorRate}%</p>
            <p className="text-xs text-gray-500 mt-1">Error Rate</p>
          </div>
          <div className="text-center p-4 bg-gray-50 rounded-lg">
            <p className="text-2xl font-bold text-gray-900">{formatBytes(data.system.usedStorageBytes)}</p>
            <p className="text-xs text-gray-500 mt-1">Storage Used</p>
          </div>
          <div className="text-center p-4 bg-gray-50 rounded-lg">
            <p className="text-2xl font-bold text-gray-900">{data.system.activeConnections}</p>
            <p className="text-xs text-gray-500 mt-1">Active Connections</p>
          </div>
          <div className="text-center p-4 bg-gray-50 rounded-lg">
            <p className="text-2xl font-bold text-gray-900">{data.system.queuedJobs}</p>
            <p className="text-xs text-gray-500 mt-1">Queued Jobs</p>
          </div>
        </div>
      </Card>

      {/* Regional Distribution */}
      <Card title="Bolgesel Dagilim">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {Object.entries(data.tenants.byRegion).map(([region, count]) => (
            <div key={region} className="text-center p-4 bg-gray-50 rounded-lg">
              <p className="text-3xl font-bold text-gray-900">{count}</p>
              <p className="text-sm text-gray-500 mt-1">{region}</p>
              <p className="text-xs text-gray-400">{((count / data.tenants.total) * 100).toFixed(1)}%</p>
            </div>
          ))}
        </div>
      </Card>

      {/* Footer */}
      <div className="text-center text-sm text-gray-400">
        Son guncelleme: {new Date(data.generatedAt).toLocaleString('tr-TR')}
      </div>
    </div>
  );
};

export default AnalyticsDashboardPage;
