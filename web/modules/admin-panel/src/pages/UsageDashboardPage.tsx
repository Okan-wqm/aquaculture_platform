/**
 * Usage Dashboard Page
 *
 * Metered billing admin dashboard showing tenant usage overview,
 * usage trends, top tenants by usage, and billing calculation previews.
 * Uses real API with graceful error handling.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsyncData } from '../hooks';
import { billingApi } from '../services/adminApi';
import type {
  UsageSummaryStats,
  TenantUsageOverview,
  UsageTrendPoint,
  TopTenantUsage,
  MeterBreakdown,
} from '../services/types';
import { AggregationPeriod, MeterType } from '../services/types';

// ============================================================================
// Constants
// ============================================================================

const METER_DISPLAY_NAMES: Record<MeterBreakdown['meterType'], string> = {
  [MeterType.API_CALLS]: 'API Calls',
  [MeterType.DATA_STORAGE]: 'Data Storage',
  [MeterType.SENSOR_READINGS]: 'Sensor Readings',
  [MeterType.ALERTS_SENT]: 'Alerts Sent',
  [MeterType.REPORTS_GENERATED]: 'Reports',
  [MeterType.USERS_ACTIVE]: 'Active Users',
  [MeterType.FARMS_ACTIVE]: 'Active Farms',
  [MeterType.PONDS_ACTIVE]: 'Active Ponds',
  [MeterType.SENSORS_ACTIVE]: 'Active Sensors',
  [MeterType.DATA_EXPORT]: 'Data Exports',
  [MeterType.INTEGRATIONS]: 'Integrations',
  [MeterType.CUSTOM]: 'Custom',
};

const METER_COLORS: Record<string, { bg: string; text: string; bar: string }> = {
  [MeterType.API_CALLS]: { bg: 'bg-blue-100', text: 'text-blue-700', bar: 'bg-blue-500' },
  [MeterType.SENSOR_READINGS]: { bg: 'bg-green-100', text: 'text-green-700', bar: 'bg-green-500' },
  [MeterType.ALERTS_SENT]: { bg: 'bg-orange-100', text: 'text-orange-700', bar: 'bg-orange-500' },
  [MeterType.DATA_STORAGE]: { bg: 'bg-purple-100', text: 'text-purple-700', bar: 'bg-purple-500' },
  [MeterType.USERS_ACTIVE]: { bg: 'bg-indigo-100', text: 'text-indigo-700', bar: 'bg-indigo-500' },
  [MeterType.PONDS_ACTIVE]: { bg: 'bg-cyan-100', text: 'text-cyan-700', bar: 'bg-cyan-500' },
  [MeterType.REPORTS_GENERATED]: { bg: 'bg-pink-100', text: 'text-pink-700', bar: 'bg-pink-500' },
  [MeterType.FARMS_ACTIVE]: { bg: 'bg-teal-100', text: 'text-teal-700', bar: 'bg-teal-500' },
  [MeterType.SENSORS_ACTIVE]: {
    bg: 'bg-yellow-100',
    text: 'text-yellow-700',
    bar: 'bg-yellow-500',
  },
};

const DEFAULT_METER_COLOR = { bg: 'bg-gray-100', text: 'text-gray-700', bar: 'bg-gray-500' };

const PERIOD_OPTIONS = [
  { value: AggregationPeriod.DAILY, label: 'Daily' },
  { value: AggregationPeriod.WEEKLY, label: 'Weekly' },
  { value: AggregationPeriod.MONTHLY, label: 'Monthly' },
  { value: AggregationPeriod.QUARTERLY, label: 'Quarterly' },
];

const TOP_TENANTS_METER_OPTIONS = [
  MeterType.API_CALLS,
  MeterType.SENSOR_READINGS,
  MeterType.ALERTS_SENT,
  MeterType.DATA_STORAGE,
  MeterType.USERS_ACTIVE,
  MeterType.PONDS_ACTIVE,
];

// ============================================================================
// Utilities
// ============================================================================

const formatNumber = (num: number, compact = false): string => {
  if (compact && Math.abs(num) >= 1000000) {
    return new Intl.NumberFormat('en-US', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(num);
  }
  if (compact && Math.abs(num) >= 1000) {
    return new Intl.NumberFormat('en-US', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(num);
  }
  return new Intl.NumberFormat('en-US').format(Math.round(num));
};

const formatDate = (dateStr: string): string => {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
};

const getMeterColor = (meterType: string) => METER_COLORS[meterType] || DEFAULT_METER_COLOR;

// ============================================================================
// Sub-components
// ============================================================================

interface SummaryCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ReactNode;
  iconBg: string;
}

const SummaryCard: React.FC<SummaryCardProps> = ({ title, value, subtitle, icon, iconBg }) => (
  <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
    <div className="flex items-center justify-between">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-gray-500 truncate">{title}</p>
        <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
        {subtitle && <p className="text-xs text-gray-500 mt-1">{subtitle}</p>}
      </div>
      <div
        className={`w-12 h-12 ${iconBg} rounded-lg flex items-center justify-center flex-shrink-0 ml-4`}
      >
        {icon}
      </div>
    </div>
  </div>
);

interface MeterBreakdownCardProps {
  meter: MeterBreakdown;
  maxUsage: number;
}

const MeterBreakdownCard: React.FC<MeterBreakdownCardProps> = ({ meter, maxUsage }) => {
  const color = getMeterColor(meter.meterType);
  const widthPercent = maxUsage > 0 ? (meter.totalUsage / maxUsage) * 100 : 0;

  return (
    <div className="flex items-center gap-4 py-3 border-b border-gray-100 last:border-0">
      <div
        className={`w-10 h-10 ${color.bg} rounded-lg flex items-center justify-center flex-shrink-0`}
      >
        <span className={`text-xs font-bold ${color.text}`}>
          {(METER_DISPLAY_NAMES[meter.meterType] || meter.meterType).slice(0, 2).toUpperCase()}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <p className="text-sm font-medium text-gray-900 truncate">
            {METER_DISPLAY_NAMES[meter.meterType] || meter.meterType}
          </p>
          <p className="text-sm font-semibold text-gray-900 ml-2">
            {formatNumber(meter.totalUsage, true)} {meter.unit}
          </p>
        </div>
        <div className="w-full bg-gray-100 rounded-full h-1.5">
          <div
            className={`${color.bar} h-1.5 rounded-full transition-all duration-500`}
            style={{ width: `${Math.min(widthPercent, 100)}%` }}
          />
        </div>
        <div className="flex items-center gap-4 mt-1 text-xs text-gray-500">
          <span>{meter.tenantCount} tenants</span>
          <span>
            Avg: {formatNumber(meter.avgPerTenant, true)}/{meter.unit}
          </span>
          <span>
            Max: {formatNumber(meter.maxPerTenant, true)}/{meter.unit}
          </span>
        </div>
      </div>
    </div>
  );
};

interface TenantUsageRowProps {
  tenant: TenantUsageOverview;
  rank: number;
}

const TenantUsageRow: React.FC<TenantUsageRowProps> = ({ tenant, rank }) => {
  const topMeters = useMemo(() => {
    return [...tenant.meters].sort((a, b) => b.totalUsage - a.totalUsage).slice(0, 4);
  }, [tenant.meters]);

  return (
    <div className="flex items-center gap-4 py-3 border-b border-gray-100 last:border-0">
      <div className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center flex-shrink-0">
        <span className="text-sm font-bold text-gray-600">#{rank}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <Link
            to={`/admin/tenants/${tenant.tenantId}`}
            className="text-sm font-medium text-blue-600 hover:text-blue-700 truncate"
          >
            {tenant.tenantName || tenant.tenantId.slice(0, 8)}
          </Link>
          <span className="text-xs text-gray-500 ml-2 flex-shrink-0">
            {formatNumber(tenant.totalEvents)} events
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {topMeters.map((m) => {
            const color = getMeterColor(m.meterType);
            return (
              <span
                key={m.meterType}
                className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded ${color.bg} ${color.text}`}
              >
                {METER_DISPLAY_NAMES[m.meterType]?.split(' ')[0] || m.meterType}:{' '}
                {formatNumber(m.totalUsage, true)}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
};

interface TopTenantItemProps {
  tenant: TopTenantUsage;
  rank: number;
  maxUsage: number;
}

const TopTenantItem: React.FC<TopTenantItemProps> = ({ tenant, rank, maxUsage }) => {
  const widthPercent = maxUsage > 0 ? (tenant.totalUsage / maxUsage) * 100 : 0;
  const color = getMeterColor(tenant.meterType);

  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-gray-100 last:border-0">
      <span className="text-sm font-semibold text-gray-400 w-6 text-right">{rank}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <Link
            to={`/admin/tenants/${tenant.tenantId}`}
            className="text-sm font-medium text-gray-900 truncate hover:text-blue-600"
          >
            {tenant.tenantName || tenant.tenantId.slice(0, 8)}
          </Link>
          <span className="text-sm font-semibold text-gray-700 ml-2 flex-shrink-0">
            {formatNumber(tenant.totalUsage, true)} {tenant.unit}
          </span>
        </div>
        <div className="w-full bg-gray-100 rounded-full h-1.5">
          <div
            className={`${color.bar} h-1.5 rounded-full transition-all duration-500`}
            style={{ width: `${Math.min(widthPercent, 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
};

interface TrendChartProps {
  trends: readonly UsageTrendPoint[];
  selectedMeter: MeterType;
}

const TrendChart: React.FC<TrendChartProps> = ({ trends, selectedMeter }) => {
  const filteredTrends = useMemo(() => {
    return trends.filter((t) => t.meterType === selectedMeter);
  }, [trends, selectedMeter]);

  const maxValue = useMemo(() => {
    return Math.max(...filteredTrends.map((t) => t.totalUsage), 1);
  }, [filteredTrends]);

  if (filteredTrends.length === 0) {
    return (
      <div className="h-48 flex items-center justify-center bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
        <div className="text-center">
          <svg
            className="w-10 h-10 text-gray-400 mx-auto mb-2"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
            />
          </svg>
          <span className="text-gray-500 text-sm">No usage data for this period</span>
        </div>
      </div>
    );
  }

  const color = getMeterColor(selectedMeter);

  return (
    <div className="h-48 flex items-end gap-1 px-2 pb-6 relative">
      {/* Y-axis labels */}
      <div className="absolute left-0 top-0 bottom-6 flex flex-col justify-between text-xs text-gray-400 w-12">
        <span>{formatNumber(maxValue, true)}</span>
        <span>{formatNumber(maxValue / 2, true)}</span>
        <span>0</span>
      </div>
      {/* Bars */}
      <div className="flex-1 flex items-end gap-1 ml-14">
        {filteredTrends.map((point, idx) => {
          const heightPercent = (point.totalUsage / maxValue) * 100;
          return (
            <div key={idx} className="flex-1 flex flex-col items-center group relative">
              <div
                className={`w-full ${color.bar} rounded-t opacity-80 hover:opacity-100 transition-opacity min-h-[2px]`}
                style={{ height: `${Math.max(heightPercent, 1)}%` }}
                title={`${formatNumber(point.totalUsage)} ${point.unit} - ${formatDate(point.periodStart)}`}
              />
              {/* Tooltip on hover */}
              <div className="absolute bottom-full mb-1 hidden group-hover:block bg-gray-800 text-white text-xs px-2 py-1 rounded whitespace-nowrap z-10">
                {formatNumber(point.totalUsage)} {point.unit}
                <br />
                {formatDate(point.periodStart)}
              </div>
            </div>
          );
        })}
      </div>
      {/* X-axis labels */}
      <div className="absolute left-14 right-2 bottom-0 flex justify-between text-xs text-gray-400">
        {filteredTrends.length > 0 && (
          <>
            <span>{formatDate(filteredTrends[0].periodStart)}</span>
            {filteredTrends.length > 1 && (
              <span>{formatDate(filteredTrends[filteredTrends.length - 1].periodStart)}</span>
            )}
          </>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// Skeleton Components
// ============================================================================

const CardSkeleton: React.FC = () => (
  <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 animate-pulse">
    <div className="flex items-center justify-between">
      <div className="flex-1">
        <div className="h-4 bg-gray-200 rounded w-24 mb-2" />
        <div className="h-8 bg-gray-200 rounded w-32" />
      </div>
      <div className="w-12 h-12 bg-gray-200 rounded-lg" />
    </div>
  </div>
);

const LoadingSkeleton: React.FC = () => (
  <div className="space-y-6">
    <div className="flex items-center justify-between">
      <div>
        <div className="h-8 bg-gray-200 rounded w-48 mb-2 animate-pulse" />
        <div className="h-4 bg-gray-200 rounded w-72 animate-pulse" />
      </div>
      <div className="h-10 w-32 bg-gray-200 rounded-lg animate-pulse" />
    </div>
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {[1, 2, 3, 4].map((i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 animate-pulse">
        <div className="h-6 bg-gray-200 rounded w-40 mb-4" />
        <div className="h-48 bg-gray-100 rounded" />
      </div>
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 animate-pulse">
        <div className="h-6 bg-gray-200 rounded w-40 mb-4" />
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-12 bg-gray-100 rounded" />
          ))}
        </div>
      </div>
    </div>
  </div>
);

// ============================================================================
// Icons
// ============================================================================

const Icons = {
  Activity: (
    <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M13 10V3L4 14h7v7l9-11h-7z"
      />
    </svg>
  ),
  Users: (
    <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
      />
    </svg>
  ),
  Chart: (
    <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
      />
    </svg>
  ),
  Database: (
    <svg className="w-6 h-6 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"
      />
    </svg>
  ),
};

// ============================================================================
// Main Component
// ============================================================================

const UsageDashboardPage: React.FC = () => {
  const [trendPeriod, setTrendPeriod] = useState<AggregationPeriod>(AggregationPeriod.DAILY);
  const [selectedTrendMeter, setSelectedTrendMeter] = useState<MeterType>(MeterType.API_CALLS);
  const [topTenantsMeter, setTopTenantsMeter] = useState<MeterType>(MeterType.API_CALLS);

  // Fetch usage summary
  const fetchSummary = useCallback(async () => {
    return billingApi.getUsageSummary({ period: AggregationPeriod.MONTHLY });
  }, []);

  const {
    data: summary,
    loading: summaryLoading,
    error: summaryError,
    refresh: refreshSummary,
  } = useAsyncData<UsageSummaryStats>(fetchSummary, {
    cacheKey: 'usage-summary',
    cacheTTL: 60000,
  });

  // Fetch tenants usage
  const fetchTenantsUsage = useCallback(async () => {
    const result = await billingApi.getAllTenantsUsage({
      period: AggregationPeriod.MONTHLY,
      limit: 10,
    });
    return result;
  }, []);

  const { data: tenantsData, loading: tenantsLoading } = useAsyncData<{
    tenants: readonly TenantUsageOverview[];
    total: number;
  }>(fetchTenantsUsage, {
    cacheKey: 'usage-tenants',
    cacheTTL: 60000,
  });

  // Fetch usage trends
  const fetchTrends = useCallback(async () => {
    return billingApi.getUsageTrends({
      period: trendPeriod,
      numPeriods:
        trendPeriod === AggregationPeriod.DAILY
          ? 30
          : trendPeriod === AggregationPeriod.WEEKLY
            ? 12
            : 6,
    });
  }, [trendPeriod]);

  const { data: trends = [], loading: trendsLoading } = useAsyncData<readonly UsageTrendPoint[]>(
    fetchTrends,
    {
      cacheKey: `usage-trends-${trendPeriod}`,
      cacheTTL: 60000,
    },
  );

  // Fetch top tenants
  const fetchTopTenants = useCallback(async () => {
    return billingApi.getTopTenantsByUsage(topTenantsMeter, {
      period: AggregationPeriod.MONTHLY,
      limit: 10,
    });
  }, [topTenantsMeter]);

  const { data: topTenants = [], loading: topTenantsLoading } = useAsyncData<
    readonly TopTenantUsage[]
  >(fetchTopTenants, {
    cacheKey: `usage-top-tenants-${topTenantsMeter}`,
    cacheTTL: 60000,
  });

  // Derived data
  const maxMeterUsage = useMemo(() => {
    if (!summary?.meterBreakdown.length) return 1;
    return Math.max(...summary.meterBreakdown.map((m) => m.totalUsage));
  }, [summary]);

  const maxTopTenantUsage = useMemo(() => {
    if (!topTenants?.length) return 1;
    return Math.max(...topTenants.map((t) => t.totalUsage));
  }, [topTenants]);

  const availableTrendMeters = useMemo(() => {
    if (!summary?.meterBreakdown.length) return TOP_TENANTS_METER_OPTIONS;
    return summary.meterBreakdown.map((m) => m.meterType);
  }, [summary]);

  const loading = summaryLoading;

  if (loading) {
    return <LoadingSkeleton />;
  }

  if (summaryError && !summary) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
        <p className="text-red-600 font-medium">Failed to load usage data</p>
        <p className="text-red-500 text-sm mt-1">{summaryError}</p>
        <button
          onClick={refreshSummary}
          className="mt-4 px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Usage Dashboard</h1>
          <p className="mt-1 text-sm text-gray-500">
            Monitor metered billing usage across all tenants
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            to="/admin/billing"
            className="px-4 py-2 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
          >
            Billing Overview
          </Link>
          <button
            onClick={refreshSummary}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            Refresh Data
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard
          title="Active Tenants"
          value={summary?.totalTenants ?? 0}
          subtitle="Tenants with usage data"
          icon={Icons.Users}
          iconBg="bg-purple-100"
        />
        <SummaryCard
          title="Total Events"
          value={formatNumber(summary?.totalEvents ?? 0, true)}
          subtitle="This billing period"
          icon={Icons.Activity}
          iconBg="bg-blue-100"
        />
        <SummaryCard
          title="Meter Types"
          value={summary?.meterBreakdown.length ?? 0}
          subtitle="Active meter categories"
          icon={Icons.Chart}
          iconBg="bg-green-100"
        />
        <SummaryCard
          title="Period Coverage"
          value={
            summary?.periodCovered
              ? `${new Date(summary.periodCovered.from).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${new Date(summary.periodCovered.to).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
              : 'N/A'
          }
          subtitle="Current billing window"
          icon={Icons.Database}
          iconBg="bg-orange-100"
        />
      </div>

      {/* Usage Breakdown + Trends */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Meter Breakdown */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Usage by Meter Type</h3>
          <div className="space-y-1">
            {summary?.meterBreakdown && summary.meterBreakdown.length > 0 ? (
              [...summary.meterBreakdown]
                .sort((a, b) => b.totalUsage - a.totalUsage)
                .map((meter) => (
                  <MeterBreakdownCard
                    key={meter.meterType}
                    meter={meter}
                    maxUsage={maxMeterUsage}
                  />
                ))
            ) : (
              <div className="py-8 text-center text-gray-500">
                <svg
                  className="w-10 h-10 text-gray-400 mx-auto mb-2"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
                  />
                </svg>
                <p>No usage data available</p>
                <p className="text-xs mt-1">
                  Usage will appear once tenants begin consuming metered resources
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Usage Trends Chart */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Usage Trends</h3>
            <div className="flex gap-2">
              <select
                value={selectedTrendMeter}
                onChange={(e) => setSelectedTrendMeter(e.target.value as MeterType)}
                className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                {availableTrendMeters.map((mt) => (
                  <option key={mt} value={mt}>
                    {METER_DISPLAY_NAMES[mt] || mt}
                  </option>
                ))}
              </select>
              <select
                value={trendPeriod}
                onChange={(e) => setTrendPeriod(e.target.value as AggregationPeriod)}
                className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                {PERIOD_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {trendsLoading ? (
            <div className="h-48 bg-gray-50 rounded-lg animate-pulse" />
          ) : (
            <TrendChart trends={trends ?? []} selectedMeter={selectedTrendMeter} />
          )}
        </div>
      </div>

      {/* Top Tenants + Tenant Usage Table */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top Tenants */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Top Tenants by Usage</h3>
            <select
              value={topTenantsMeter}
              onChange={(e) => setTopTenantsMeter(e.target.value as MeterType)}
              className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {TOP_TENANTS_METER_OPTIONS.map((mt) => (
                <option key={mt} value={mt}>
                  {METER_DISPLAY_NAMES[mt] || mt}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-0">
            {topTenantsLoading ? (
              <div className="space-y-3 animate-pulse">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-10 bg-gray-100 rounded" />
                ))}
              </div>
            ) : topTenants && topTenants.length > 0 ? (
              topTenants.map((tenant, idx) => (
                <TopTenantItem
                  key={tenant.tenantId}
                  tenant={tenant}
                  rank={idx + 1}
                  maxUsage={maxTopTenantUsage}
                />
              ))
            ) : (
              <div className="py-8 text-center text-gray-500">
                No tenant usage data for this meter type
              </div>
            )}
          </div>
        </div>

        {/* All Tenants Usage */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Tenant Usage Overview</h3>
            <span className="text-sm text-gray-500">{tenantsData?.total ?? 0} tenants total</span>
          </div>
          <div className="space-y-0">
            {tenantsLoading ? (
              <div className="space-y-3 animate-pulse">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-14 bg-gray-100 rounded" />
                ))}
              </div>
            ) : tenantsData?.tenants && tenantsData.tenants.length > 0 ? (
              tenantsData.tenants.map((tenant, idx) => (
                <TenantUsageRow key={tenant.tenantId} tenant={tenant} rank={idx + 1} />
              ))
            ) : (
              <div className="py-8 text-center text-gray-500">No tenant usage data available</div>
            )}
          </div>
          {tenantsData && tenantsData.total > 10 && (
            <div className="mt-4 text-center">
              <span className="text-sm text-gray-500">
                Showing top 10 of {tenantsData.total} tenants
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Pricing Information */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Metered Billing Pricing Tiers</h3>
        <p className="text-sm text-gray-500 mb-4">
          Usage-based pricing with tiered rates. Overages beyond included units are billed per unit
          at the applicable tier rate.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { meter: 'API Calls', included: '10K-1M', rate: '$0.0005-0.001/call', icon: 'AC' },
            {
              meter: 'Sensor Readings',
              included: '100K-10M',
              rate: '$0.00001-0.00005/reading',
              icon: 'SR',
            },
            { meter: 'Data Storage', included: '5-500 GB', rate: '$0.01-0.10/GB', icon: 'DS' },
            { meter: 'Alerts Sent', included: '100-10K', rate: '$0.005-0.05/alert', icon: 'AS' },
          ].map((item) => (
            <div key={item.meter} className="p-4 bg-gray-50 rounded-lg border border-gray-200">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-8 h-8 bg-blue-100 rounded flex items-center justify-center">
                  <span className="text-xs font-bold text-blue-700">{item.icon}</span>
                </div>
                <span className="text-sm font-semibold text-gray-900">{item.meter}</span>
              </div>
              <p className="text-xs text-gray-600">Included: {item.included}</p>
              <p className="text-xs text-gray-600">Rate: {item.rate}</p>
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-400 mt-3">
          Rates vary by plan tier (Starter, Professional, Enterprise). See plan management for full
          pricing details.
        </p>
      </div>
    </div>
  );
};

export default UsageDashboardPage;
