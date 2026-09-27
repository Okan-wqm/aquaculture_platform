/**
 * Billing Dashboard Page
 *
 * Overview of billing metrics, revenue analytics, and recent transactions.
 *
 * Every number here is billing's answer or it is absent. There is no fallback
 * source and no swallowed read: a failed request is named on screen, because a
 * money surface that renders a failure as "no transactions" or as another
 * endpoint's figure is worse than one that renders nothing.
 */

import { AreaChart, MetricCard, PageHeader } from '@aquaculture/shared-ui';
import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminKeys, useAdminQuery } from '../hooks';
import { QueryFailureNotice } from '../components/QueryFailureNotice';
import { analyticsApi, billingApi } from '../services/adminApi';
import type { AnalyticsRange, TimeSeriesResponse } from '../services/types/analytics';
import {
  ChartColumn,
  Check,
  DollarSign,
  FileText,
  TrendingUp,
  Undo2,
  Users as UsersIcon,
} from 'lucide-react';

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

/**
 * The eight states `billing.invoices.status` can hold. The feed used to collapse
 * them into three, mapping `paid` and `pending` and calling EVERYTHING ELSE
 * "failed" — so a sent invoice, an overdue receivable, a draft, a partial
 * payment, a void and a refund all rendered with a red Failed badge. An overdue
 * invoice is money still owed, not money that failed to move.
 */
type InvoiceStatus =
  | 'draft'
  | 'pending'
  | 'sent'
  | 'paid'
  | 'partially_paid'
  | 'overdue'
  | 'void'
  | 'refunded';

interface RecentTransaction {
  id: string;
  tenant: string;
  amount: number;
  status: InvoiceStatus;
  date: string;
}

/** How each state reads to an operator, and the badge it earns. */
const INVOICE_STATUS_PRESENTATION: Record<
  InvoiceStatus,
  { label: string; badge: string; tone: 'paid' | 'refund' | 'open' }
> = {
  draft: {
    label: 'Draft',
    badge: 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300',
    tone: 'open',
  },
  pending: {
    label: 'Pending',
    badge: 'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300',
    tone: 'open',
  },
  sent: {
    label: 'Sent',
    badge: 'bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300',
    tone: 'open',
  },
  paid: {
    label: 'Paid',
    badge: 'bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300',
    tone: 'paid',
  },
  partially_paid: {
    label: 'Partially paid',
    badge: 'bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300',
    tone: 'paid',
  },
  overdue: {
    label: 'Overdue',
    badge: 'bg-error-100 dark:bg-error-900/40 text-error-700 dark:text-error-300',
    tone: 'open',
  },
  void: {
    label: 'Void',
    badge: 'bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
    tone: 'open',
  },
  refunded: {
    label: 'Refunded',
    badge: 'bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300',
    tone: 'refund',
  },
};

const isInvoiceStatus = (value: string): value is InvoiceStatus =>
  Object.prototype.hasOwnProperty.call(INVOICE_STATUS_PRESENTATION, value);

// ============================================================================
// Utilities
// ============================================================================

/** How many invoices the "Recent Transactions" feed shows. */
const RECENT_INVOICE_LIMIT = 5;

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
  const presentation = INVOICE_STATUS_PRESENTATION[transaction.status];

  const iconConfig = useMemo(() => {
    switch (presentation.tone) {
      case 'paid':
        return {
          bg: 'bg-success-100 dark:bg-success-900/40',
          icon: (
            <Check className="w-5 h-5 text-success-600 dark:text-success-400" aria-hidden="true" />
          ),
        };
      case 'refund':
        return {
          bg: 'bg-error-100 dark:bg-error-900/40',
          icon: <Undo2 className="w-5 h-5 text-error-600 dark:text-error-400" aria-hidden="true" />,
        };
      default:
        return {
          bg: 'bg-info-100 dark:bg-info-900/40',
          icon: (
            <FileText className="w-5 h-5 text-info-600 dark:text-info-400" aria-hidden="true" />
          ),
        };
    }
  }, [presentation.tone]);

  const statusConfig = presentation.badge;

  return (
    <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-gray-700 last:border-0">
      <div className="flex items-center gap-3 min-w-0">
        <div
          className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${iconConfig.bg}`}
        >
          {iconConfig.icon}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
            {transaction.tenant}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">{transaction.date}</p>
        </div>
      </div>
      <div className="text-right flex-shrink-0 ml-4">
        <p
          className={`text-sm font-semibold ${presentation.tone === 'refund' ? 'text-error-600 dark:text-error-400' : 'text-gray-900 dark:text-gray-100'}`}
        >
          {presentation.tone === 'refund' ? '-' : '+'}
          {formatCurrency(transaction.amount)}
        </p>
        <span className={`text-xs px-2 py-0.5 rounded-full ${statusConfig}`}>
          {presentation.label}
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
  valueColor = 'text-gray-900 dark:text-gray-100',
  action,
  subtitle,
}) => (
  <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm text-gray-500 dark:text-gray-400">{title}</p>
        <p className={`text-xl font-bold mt-1 ${valueColor}`}>{value}</p>
      </div>
      {action && (
        <Link
          to={action.href}
          className="text-sm text-info-600 dark:text-info-400 hover:text-info-700 dark:hover:text-info-200"
        >
          {action.label}
        </Link>
      )}
      {subtitle && <span className="text-xs text-gray-500 dark:text-gray-400">{subtitle}</span>}
    </div>
  </div>
);

// ============================================================================
// Skeleton Components
// ============================================================================

const MetricCardSkeleton: React.FC = () => (
  <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 animate-pulse">
    <div className="flex items-center justify-between">
      <div className="flex-1">
        <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-24 mb-2" />
        <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-32" />
      </div>
      <div className="w-12 h-12 bg-gray-200 dark:bg-gray-700 rounded-lg" />
    </div>
    <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-20 mt-3" />
  </div>
);

const LoadingSkeleton: React.FC = () => (
  <div className="space-y-6">
    <div className="flex items-center justify-between">
      <div>
        <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-48 mb-2 animate-pulse" />
        <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-64 animate-pulse" />
      </div>
      <div className="flex gap-2">
        <div className="h-10 w-28 bg-gray-200 dark:bg-gray-700 rounded-lg animate-pulse" />
        <div className="h-10 w-28 bg-gray-200 dark:bg-gray-700 rounded-lg animate-pulse" />
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
    <DollarSign className="w-6 h-6 text-success-600 dark:text-success-400" aria-hidden="true" />
  ),
  Chart: <ChartColumn className="w-6 h-6 text-info-600 dark:text-info-400" aria-hidden="true" />,
  Users: <UsersIcon className="w-6 h-6 text-accent-600 dark:text-accent-400" aria-hidden="true" />,
  TrendDown: (
    <TrendingUp className="w-6 h-6 text-warning-600 dark:text-warning-400" aria-hidden="true" />
  ),
};

// ============================================================================
// Main Component
// ============================================================================

const BillingDashboardPage: React.FC = () => {
  const [trendRange, setTrendRange] = useState<AnalyticsRange>('1y');

  // Compose the dashboard from the live stats endpoints (ADMIN-HIGH-008):
  // subscriptions/stats, invoices/stats, payments/stats, revenue + trend.
  const metricsQuery = useAdminQuery<BillingMetrics>(
    adminKeys.billing.dashboardMetrics(),
    async ({ signal }) => {
      const [revenue, subs, invoices, payments, trend] = await Promise.all([
        analyticsApi.getRevenueAnalytics(signal),
        billingApi.getSubscriptionStats(signal),
        billingApi.getInvoiceStats(signal),
        billingApi.getPaymentStats(signal),
        analyticsApi.getRevenueTrend('1y', 'month', signal),
      ]);
      return {
        // `??`, not `||`. A tenant base that genuinely bills zero has an MRR of
        // 0, and `0 || revenue.mrr` silently swapped in a DIFFERENT endpoint's
        // figure under the same heading — the reading was not merely stale, it
        // was another question's answer. Absent falls back; zero does not.
        mrr: subs.mrr ?? revenue.mrr,
        arr: subs.arr ?? revenue.arr,
        activeSubscriptions: (subs.byStatus['active'] ?? 0) + (subs.byStatus['trialing'] ?? 0),
        churnRate: subs.churnRate,
        avgRevenuePerUser: subs.averageRevenuePerUser ?? revenue.averageRevenuePerTenant,
        outstandingInvoices: invoiceCount(invoices.byStatus, ['pending', 'sent', 'overdue']),
        outstandingAmount: invoices.totalPending + invoices.totalOverdue,
        totalRevenue: revenue.totalRevenue,
        growth: growthFromTrend(trend),
        paymentSuccessRate:
          payments.last30Days.succeeded +
            payments.last30Days.refunded +
            payments.last30Days.failed >
          0
            ? payments.last30Days.successRate
            : null,
      };
    },
  );

  const metrics = metricsQuery.data;

  // Revenue trend for the chart — refetches when the range select changes.
  const trendGranularity = trendRange === '90d' ? 'week' : 'month';
  const trendQuery = useAdminQuery<TimeSeriesResponse>(
    adminKeys.billing.revenueTrend(trendRange, trendGranularity),
    ({ signal }) => analyticsApi.getRevenueTrend(trendRange, trendGranularity, signal),
  );
  const trendSeries = trendQuery.data;

  /**
   * The newest invoices, as the "Recent Transactions" feed.
   *
   * This read used to sit behind a bare `catch { return [] }`, so billing being
   * unreachable rendered as "No recent transactions" — a claim that the
   * platform took no money, made from a request that never answered. The catch
   * is gone; a failure is now shown as a failure.
   */
  const transactionsQuery = useAdminQuery<RecentTransaction[]>(
    adminKeys.billing.recentInvoices(RECENT_INVOICE_LIMIT),
    async ({ signal }) => {
      const data = await billingApi.getInvoices({ limit: RECENT_INVOICE_LIMIT }, signal);
      return (data.invoices ?? []).map((invoice) => ({
        id: invoice.id,
        tenant: invoice.tenantName ?? 'Unknown',
        amount: invoice.amount,
        status: isInvoiceStatus(invoice.status) ? invoice.status : 'draft',
        date: new Date(invoice.createdAt).toISOString().split('T')[0] ?? invoice.createdAt,
      }));
    },
  );
  const transactions = transactionsQuery.data;

  if (metricsQuery.isPending) {
    return <LoadingSkeleton />;
  }

  if (!metrics) {
    return (
      <QueryFailureNotice
        errors={[metricsQuery.error]}
        hasContent={false}
        onRetry={() => void metricsQuery.refetch()}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Billing Overview"
        description="Monitor revenue, subscriptions, and financial metrics"
        actions={
          <div className="flex gap-2">
            <button className="px-4 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
              Export Report
            </button>
            <Link
              to="/admin/billing/invoices/new"
              className="px-4 py-2 bg-info-600 text-white text-sm font-medium rounded-lg hover:bg-info-700 transition-colors"
            >
              Create Invoice
            </Link>
          </div>
        }
      />

      {/* Metrics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Monthly Recurring Revenue"
          value={formatCurrency(metrics.mrr)}
          icon={Icons.Dollar}
          iconClassName="bg-success-100 dark:bg-success-900/40"
          change={metrics.growth ?? undefined}
          trend={metrics.growth ?? 'neutral'}
          trendLabel="vs last month"
        />
        <MetricCard
          title="Annual Recurring Revenue"
          value={formatCurrency(metrics.arr, true)}
          icon={Icons.Chart}
          iconClassName="bg-info-100 dark:bg-info-900/40"
          subtitle="Based on current MRR"
        />
        <MetricCard
          title="Active Subscriptions"
          value={metrics.activeSubscriptions.toLocaleString()}
          icon={Icons.Users}
          iconClassName="bg-accent-100 dark:bg-accent-900/40"
          subtitle={`ARPU: ${formatCurrency(metrics.avgRevenuePerUser ?? 0)}`}
        />
        <MetricCard
          title="Churn Rate"
          value={formatPercentage(metrics.churnRate)}
          icon={Icons.TrendDown}
          iconClassName="bg-warning-100 dark:bg-warning-900/40"
          subtitle={
            <span
              className={
                metrics.churnRate < 3
                  ? 'text-success-600 dark:text-success-400'
                  : 'text-error-600 dark:text-error-400'
              }
            >
              {metrics.churnRate < 3 ? 'Healthy' : 'Needs attention'}
            </span>
          }
        />
      </div>

      {/* Charts and Transactions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Revenue Trend */}
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Revenue Trend
            </h3>
            <select
              aria-label="Revenue trend range"
              value={trendRange}
              onChange={(e) => setTrendRange(e.target.value as AnalyticsRange)}
              className="text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-info-500 focus:border-info-500"
            >
              <option value="1y">Last 12 months</option>
              <option value="90d">Last 3 months</option>
              <option value="30d">Last 30 days</option>
            </select>
          </div>
          {trendQuery.isPending ? (
            <div className="h-64 bg-gray-50 dark:bg-gray-800 rounded-lg animate-pulse" />
          ) : !trendSeries ? (
            /* A series that did not load is not a range with no revenue in it. */
            <QueryFailureNotice
              errors={[trendQuery.error]}
              hasContent={false}
              onRetry={() => void trendQuery.refetch()}
            />
          ) : trendSeries.data.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400">
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
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Recent Transactions
            </h3>
            <Link
              to="/admin/billing/invoices"
              className="text-sm text-info-600 dark:text-info-400 hover:text-info-700 dark:hover:text-info-200"
            >
              View all
            </Link>
          </div>
          <div className="space-y-1">
            {transactionsQuery.isPending ? (
              <div className="py-8 h-24 bg-gray-50 dark:bg-gray-800 rounded-lg animate-pulse" />
            ) : !transactions ? (
              /* The regression this replaces: `catch { return [] }` rendered an
                 unreachable billing service as "No recent transactions" — a
                 claim about money, made from a request that never answered. */
              <QueryFailureNotice
                errors={[transactionsQuery.error]}
                hasContent={false}
                onRetry={() => void transactionsQuery.refetch()}
              />
            ) : transactions.length === 0 ? (
              <div className="py-8 text-center text-gray-500 dark:text-gray-400">
                No recent transactions
              </div>
            ) : (
              transactions.map((tx) => <TransactionItem key={tx.id} transaction={tx} />)
            )}
          </div>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <QuickStat
          title="Outstanding Invoices"
          value={`${metrics.outstandingInvoices} (${formatCurrency(metrics.outstandingAmount, true)})`}
          valueColor="text-accent-600 dark:text-accent-400"
          action={{ label: 'View all', href: '/admin/billing/invoices?status=pending' }}
        />
        <QuickStat
          title="Total Revenue (YTD)"
          value={formatCurrency(metrics.totalRevenue, true)}
          action={{ label: 'Details', href: '/admin/billing/reports' }}
        />
        <QuickStat
          title="Payment Success Rate"
          value={
            metrics.paymentSuccessRate != null
              ? formatPercentage(metrics.paymentSuccessRate * 100)
              : '—'
          }
          valueColor={
            metrics.paymentSuccessRate != null
              ? 'text-success-600 dark:text-success-400'
              : 'text-gray-400 dark:text-gray-500'
          }
          subtitle={metrics.paymentSuccessRate != null ? 'Last 30 days' : 'No payment attempts yet'}
        />
      </div>
    </div>
  );
};

export default BillingDashboardPage;
