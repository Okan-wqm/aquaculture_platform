/**
 * Billing Dashboard Page
 *
 * Overview of billing metrics, revenue analytics, and recent transactions.
 * Uses real API with mock fallback for development.
 */

import { AreaChart, MetricCard } from '@aquaculture/shared-ui';
import React, { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsyncData } from '../hooks';
import { analyticsApi, billingApi } from '../services/adminApi';
import type { AnalyticsRange, TimeSeriesResponse } from '../services/types/analytics';

// ============================================================================
// Types
// ============================================================================

interface BillingMetrics {
  mrr: number;
  arr: number;
  activeSubscriptions: number;
  churnRate: number;
  avgRevenuePerUser: number;
  /** Open invoice count (pending + sent + overdue). */
  outstandingInvoices: number;
  /** Open invoice amount (pending + overdue sums). */
  outstandingAmount: number;
  totalRevenue: number;
  /** Month-over-month revenue growth (%) from the trend series; null with <2 points. */
  growth: number | null;
  /** 0..1 terminal success rate over the last 30 days; null with no attempts. */
  paymentSuccessRate: number | null;
}

interface RecentTransaction {
  id: string;
  tenant: string;
  amount: number;
  type: 'payment' | 'refund' | 'invoice';
  status: 'completed' | 'pending' | 'failed';
  date: string;
}

// ============================================================================
// Utilities
// ============================================================================

const formatCurrency = (amount: number, compact = false): string => {
  if (compact && Math.abs(amount) >= 1000000) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(amount);
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
};

const formatPercentage = (value: number): string => {
  return `${value.toFixed(1)}%`;
};

/** Month-over-month growth from the last two points of the revenue trend. */
const growthFromTrend = (trend: TimeSeriesResponse): number | null => {
  const points = trend.data;
  if (points.length < 2) return null;
  const prev = points[points.length - 2]!.value;
  const last = points[points.length - 1]!.value;
  if (prev === 0) return null;
  return ((last - prev) / prev) * 100;
};

const invoiceCount = (
  byStatus: Record<string, { count: number; amount: number }>,
  statuses: string[],
): number => statuses.reduce((sum, status) => sum + (byStatus[status]?.count ?? 0), 0);

// ============================================================================
// Sub-components
// ============================================================================

interface TransactionItemProps {
  transaction: RecentTransaction;
}

const TransactionItem: React.FC<TransactionItemProps> = ({ transaction }) => {
  const iconConfig = useMemo(() => {
    switch (transaction.type) {
      case 'payment':
        return {
          bg: 'bg-green-100',
          icon: (
            <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          ),
        };
      case 'refund':
        return {
          bg: 'bg-red-100',
          icon: (
            <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
          ),
        };
      default:
        return {
          bg: 'bg-blue-100',
          icon: (
            <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          ),
        };
    }
  }, [transaction.type]);

  const statusConfig = useMemo(() => {
    switch (transaction.status) {
      case 'completed':
        return 'bg-green-100 text-green-700';
      case 'pending':
        return 'bg-yellow-100 text-yellow-700';
      default:
        return 'bg-red-100 text-red-700';
    }
  }, [transaction.status]);

  return (
    <div className="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
      <div className="flex items-center gap-3 min-w-0">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${iconConfig.bg}`}>
          {iconConfig.icon}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{transaction.tenant}</p>
          <p className="text-xs text-gray-500">{transaction.date}</p>
        </div>
      </div>
      <div className="text-right flex-shrink-0 ml-4">
        <p className={`text-sm font-semibold ${transaction.type === 'refund' ? 'text-red-600' : 'text-gray-900'}`}>
          {transaction.type === 'refund' ? '-' : '+'}{formatCurrency(transaction.amount)}
        </p>
        <span className={`text-xs px-2 py-0.5 rounded-full ${statusConfig}`}>
          {transaction.status}
        </span>
      </div>
    </div>
  );
};

interface QuickStatProps {
  title: string;
  value: string | number;
  valueColor?: string;
  action?: { label: string; href: string };
  subtitle?: string;
}

const QuickStat: React.FC<QuickStatProps> = ({
  title,
  value,
  valueColor = 'text-gray-900',
  action,
  subtitle,
}) => (
  <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm text-gray-500">{title}</p>
        <p className={`text-xl font-bold mt-1 ${valueColor}`}>{value}</p>
      </div>
      {action && (
        <Link to={action.href} className="text-sm text-blue-600 hover:text-blue-700">
          {action.label}
        </Link>
      )}
      {subtitle && <span className="text-xs text-gray-500">{subtitle}</span>}
    </div>
  </div>
);

// ============================================================================
// Skeleton Components
// ============================================================================

const MetricCardSkeleton: React.FC = () => (
  <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 animate-pulse">
    <div className="flex items-center justify-between">
      <div className="flex-1">
        <div className="h-4 bg-gray-200 rounded w-24 mb-2" />
        <div className="h-8 bg-gray-200 rounded w-32" />
      </div>
      <div className="w-12 h-12 bg-gray-200 rounded-lg" />
    </div>
    <div className="h-4 bg-gray-200 rounded w-20 mt-3" />
  </div>
);

const LoadingSkeleton: React.FC = () => (
  <div className="space-y-6">
    <div className="flex items-center justify-between">
      <div>
        <div className="h-8 bg-gray-200 rounded w-48 mb-2 animate-pulse" />
        <div className="h-4 bg-gray-200 rounded w-64 animate-pulse" />
      </div>
      <div className="flex gap-2">
        <div className="h-10 w-28 bg-gray-200 rounded-lg animate-pulse" />
        <div className="h-10 w-28 bg-gray-200 rounded-lg animate-pulse" />
      </div>
    </div>
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {[1, 2, 3, 4].map((i) => (
        <MetricCardSkeleton key={i} />
      ))}
    </div>
  </div>
);

// ============================================================================
// Icons
// ============================================================================

const Icons = {
  Dollar: (
    <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  Chart: (
    <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    </svg>
  ),
  Users: (
    <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
    </svg>
  ),
  TrendDown: (
    <svg className="w-6 h-6 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" />
    </svg>
  ),
};

// ============================================================================
// Main Component
// ============================================================================

const BillingDashboardPage: React.FC = () => {
  const [trendRange, setTrendRange] = useState<AnalyticsRange>('1y');

  // Compose the dashboard from the live stats endpoints (ADMIN-HIGH-008):
  // subscriptions/stats, invoices/stats, payments/stats, revenue + trend.
  const fetchMetrics = useCallback(async () => {
    const [revenue, subs, invoices, payments, trend] = await Promise.all([
      analyticsApi.getRevenueAnalytics(),
      billingApi.getSubscriptionStats(),
      billingApi.getInvoiceStats(),
      billingApi.getPaymentStats(),
      analyticsApi.getRevenueTrend('1y', 'month'),
    ]);
    const metricsResult: BillingMetrics = {
      mrr: subs.mrr || revenue.mrr,
      arr: subs.arr || revenue.arr,
      activeSubscriptions: (subs.byStatus['active'] ?? 0) + (subs.byStatus['trialing'] ?? 0),
      churnRate: subs.churnRate,
      avgRevenuePerUser: subs.averageRevenuePerUser || revenue.averageRevenuePerTenant,
      outstandingInvoices: invoiceCount(invoices.byStatus, ['pending', 'sent', 'overdue']),
      outstandingAmount: invoices.totalPending + invoices.totalOverdue,
      totalRevenue: revenue.totalRevenue,
      growth: growthFromTrend(trend),
      paymentSuccessRate:
        payments.last30Days.succeeded + payments.last30Days.refunded + payments.last30Days.failed > 0
          ? payments.last30Days.successRate
          : null,
    };
    return metricsResult;
  }, []);

  const {
    data: metrics,
    loading: metricsLoading,
    error,
    refresh,
  } = useAsyncData<BillingMetrics>(fetchMetrics, {
    cacheKey: 'billing-metrics',
    cacheTTL: 60000, // 1 minute cache
  });

  // Revenue trend for the chart — refetches when the range select changes.
  const fetchTrend = useCallback(
    () => analyticsApi.getRevenueTrend(trendRange, trendRange === '90d' ? 'week' : 'month'),
    [trendRange],
  );
  const { data: trendSeries, loading: trendLoading } = useAsyncData<TimeSeriesResponse>(fetchTrend, {
    cacheKey: `billing-revenue-trend-${trendRange}`,
    cacheTTL: 60000,
  });

  // Fetch recent transactions from API
  const fetchTransactions = useCallback(async () => {
    // Use billing API to get recent invoices as transactions
    try {
      const data = await billingApi.getInvoices({ limit: 5 });
      // Transform invoices to transactions format
      return (data.invoices || []).map((invoice: { id: string; tenantName?: string; amount: number; status: string; createdAt: string }) => ({
        id: invoice.id,
        tenant: invoice.tenantName || 'Unknown',
        amount: invoice.amount,
        type: 'invoice' as const,
        status: invoice.status === 'paid' ? 'completed' as const : invoice.status === 'pending' ? 'pending' as const : 'failed' as const,
        date: new Date(invoice.createdAt).toISOString().split('T')[0],
      }));
    } catch {
      return [];
    }
  }, []);

  const { data: transactions = [], loading: transactionsLoading } = useAsyncData<RecentTransaction[]>(
    fetchTransactions,
    { cacheKey: 'billing-transactions', cacheTTL: 60000 }
  );

  const loading = metricsLoading;

  if (loading) {
    return <LoadingSkeleton />;
  }

  if (error && !metrics) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
        <p className="text-red-600 font-medium">Failed to load billing data</p>
        <p className="text-red-500 text-sm mt-1">{error}</p>
        <button
          onClick={refresh}
          className="mt-4 px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!metrics) return null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Billing Overview</h1>
          <p className="mt-1 text-sm text-gray-500">
            Monitor revenue, subscriptions, and financial metrics
          </p>
        </div>
        <div className="flex gap-2">
          <button className="px-4 py-2 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors">
            Export Report
          </button>
          <Link
            to="/admin/billing/invoices/new"
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            Create Invoice
          </Link>
        </div>
      </div>

      {/* Metrics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Monthly Recurring Revenue"
          value={formatCurrency(metrics.mrr)}
          icon={Icons.Dollar}
          iconClassName="bg-green-100"
          change={metrics.growth ?? undefined}
          trend={metrics.growth ?? 'neutral'}
          trendLabel="vs last month"
        />
        <MetricCard
          title="Annual Recurring Revenue"
          value={formatCurrency(metrics.arr, true)}
          icon={Icons.Chart}
          iconClassName="bg-blue-100"
          subtitle="Based on current MRR"
        />
        <MetricCard
          title="Active Subscriptions"
          value={metrics.activeSubscriptions.toLocaleString()}
          icon={Icons.Users}
          iconClassName="bg-purple-100"
          subtitle={`ARPU: ${formatCurrency(metrics.avgRevenuePerUser ?? 0)}`}
        />
        <MetricCard
          title="Churn Rate"
          value={formatPercentage(metrics.churnRate)}
          icon={Icons.TrendDown}
          iconClassName="bg-yellow-100"
          subtitle={
            <span className={metrics.churnRate < 3 ? 'text-green-600' : 'text-red-600'}>
              {metrics.churnRate < 3 ? 'Healthy' : 'Needs attention'}
            </span>
          }
        />
      </div>

      {/* Charts and Transactions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Revenue Trend */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Revenue Trend</h3>
            <select
              aria-label="Revenue trend range"
              value={trendRange}
              onChange={(e) => setTrendRange(e.target.value as AnalyticsRange)}
              className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="1y">Last 12 months</option>
              <option value="90d">Last 3 months</option>
              <option value="30d">Last 30 days</option>
            </select>
          </div>
          {trendLoading || !trendSeries ? (
            <div className="h-64 bg-gray-50 rounded-lg animate-pulse" />
          ) : trendSeries.data.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-sm text-gray-500">
              No revenue data for this range
            </div>
          ) : (
            <AreaChart
              data={trendSeries.data.map((point) => ({ label: point.date, value: point.value }))}
              height={256}
              className="w-full"
              formatValue={(v) => formatCurrency(v, true)}
            />
          )}
        </div>

        {/* Recent Transactions */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Recent Transactions</h3>
            <Link to="/admin/billing/invoices" className="text-sm text-blue-600 hover:text-blue-700">
              View all
            </Link>
          </div>
          <div className="space-y-1">
            {(!transactions || transactions.length === 0) ? (
              <div className="py-8 text-center text-gray-500">
                No recent transactions
              </div>
            ) : (
              transactions.map((tx) => (
                <TransactionItem key={tx.id} transaction={tx} />
              ))
            )}
          </div>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <QuickStat
          title="Outstanding Invoices"
          value={`${metrics.outstandingInvoices} (${formatCurrency(metrics.outstandingAmount, true)})`}
          valueColor="text-orange-600"
          action={{ label: 'View all', href: '/admin/billing/invoices?status=pending' }}
        />
        <QuickStat
          title="Total Revenue (YTD)"
          value={formatCurrency(metrics.totalRevenue, true)}
          action={{ label: 'Details', href: '/admin/billing/reports' }}
        />
        <QuickStat
          title="Payment Success Rate"
          value={metrics.paymentSuccessRate != null ? formatPercentage(metrics.paymentSuccessRate * 100) : '—'}
          valueColor={metrics.paymentSuccessRate != null ? 'text-green-600' : 'text-gray-400'}
          subtitle={metrics.paymentSuccessRate != null ? 'Last 30 days' : 'No payment attempts yet'}
        />
      </div>
    </div>
  );
};

export default BillingDashboardPage;
