/**
 * TenantBillingPage
 *
 * Displays subscription, invoices, plan limits, and usage metrics
 * for the current tenant. Strictly read-only -- no mutations.
 *
 * SEC-007: Protected by RequireTenantAdmin guard in Module.tsx.
 * BILLING-SAFETY: Read-only. Tenant admin cannot change plan or pricing.
 */

import React from 'react';
import {
  CreditCard,
  FileText,
  RefreshCw,
  AlertCircle,
  CheckCircle,
  Clock,
  XCircle,
  AlertTriangle,
  TrendingUp,
  HardDrive,
  Cpu,
  Users,
  Waves,
  BarChart3,
  Calendar,
} from 'lucide-react';
import { parseMoney } from '@aquaculture/shared-ui';

import { useTenantBilling, type TenantInvoice } from '../hooks/useTenantBilling';

// ============================================================================
// Sub-Components
// ============================================================================

/**
 * Subscription status badge
 */
const SubscriptionStatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const config: Record<string, { bg: string; text: string; icon: React.ReactNode; label: string }> = {
    ACTIVE: {
      bg: 'bg-green-100',
      text: 'text-green-700',
      icon: <CheckCircle className="w-3.5 h-3.5" />,
      label: 'Active',
    },
    TRIAL: {
      bg: 'bg-blue-100',
      text: 'text-blue-700',
      icon: <Clock className="w-3.5 h-3.5" />,
      label: 'Trial',
    },
    PAST_DUE: {
      bg: 'bg-yellow-100',
      text: 'text-yellow-700',
      icon: <AlertTriangle className="w-3.5 h-3.5" />,
      label: 'Past Due',
    },
    CANCELLED: {
      bg: 'bg-gray-100',
      text: 'text-gray-700',
      icon: <XCircle className="w-3.5 h-3.5" />,
      label: 'Cancelled',
    },
    SUSPENDED: {
      bg: 'bg-red-100',
      text: 'text-red-700',
      icon: <AlertCircle className="w-3.5 h-3.5" />,
      label: 'Suspended',
    },
  };

  const c = config[status] || config.ACTIVE;

  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium ${c.bg} ${c.text}`}>
      {c.icon}
      {c.label}
    </span>
  );
};

/**
 * Invoice status badge
 */
const InvoiceStatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const config: Record<string, { bg: string; text: string }> = {
    PAID: { bg: 'bg-green-100', text: 'text-green-700' },
    PENDING: { bg: 'bg-yellow-100', text: 'text-yellow-700' },
    OVERDUE: { bg: 'bg-red-100', text: 'text-red-700' },
    DRAFT: { bg: 'bg-gray-100', text: 'text-gray-600' },
    VOID: { bg: 'bg-gray-100', text: 'text-gray-500' },
  };

  const c = config[status] || config.DRAFT;

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${c.bg} ${c.text}`}>
      {status}
    </span>
  );
};

/**
 * Usage bar component
 */
const UsageBar: React.FC<{
  label: string;
  current: number;
  limit: number;
  unit?: string;
  icon: React.ReactNode;
}> = ({ label, current, limit, unit = '', icon }) => {
  const percentage = limit > 0 ? Math.min((current / limit) * 100, 100) : 0;
  let barColor = 'bg-tenant-500';
  if (percentage >= 90) barColor = 'bg-red-500';
  else if (percentage >= 70) barColor = 'bg-yellow-500';

  return (
    <div className="p-4 bg-white rounded-xl border border-gray-100">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-sm font-medium text-gray-700">{label}</span>
        </div>
        <span className="text-sm text-gray-500">
          {current.toLocaleString()}{unit} / {limit.toLocaleString()}{unit}
        </span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-2">
        <div
          className={`${barColor} rounded-full h-2 transition-all duration-300`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <p className="text-xs text-gray-500 mt-1 text-right">{percentage.toFixed(1)}% used</p>
    </div>
  );
};

/**
 * Stat card component
 */
const StatCard: React.FC<{
  label: string;
  value: string;
  subtext?: string;
  icon: React.ReactNode;
  color: string;
}> = ({ label, value, subtext, icon, color }) => (
  <div className="bg-white rounded-xl border border-gray-100 p-5">
    <div className="flex items-center gap-3">
      <div className={`p-2.5 rounded-xl ${color}`}>{icon}</div>
      <div>
        <p className="text-xs font-medium text-gray-500 uppercase">{label}</p>
        <p className="text-lg font-bold text-gray-900">{value}</p>
        {subtext && <p className="text-xs text-gray-500">{subtext}</p>}
      </div>
    </div>
  </div>
);

// ============================================================================
// Skeleton Loading
// ============================================================================

const BillingSkeleton: React.FC = () => (
  <div className="space-y-6 animate-pulse">
    {/* Header skeleton */}
    <div className="flex justify-between">
      <div>
        <div className="w-48 h-7 bg-gray-200 rounded" />
        <div className="w-64 h-4 bg-gray-200 rounded mt-2" />
      </div>
    </div>
    {/* Cards skeleton */}
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {[1, 2, 3].map((i) => (
        <div key={i} className="bg-white rounded-xl border border-gray-100 p-5">
          <div className="w-32 h-4 bg-gray-200 rounded" />
          <div className="w-24 h-6 bg-gray-200 rounded mt-2" />
        </div>
      ))}
    </div>
    {/* Table skeleton */}
    <div className="bg-white rounded-xl border border-gray-100 p-6">
      <div className="w-36 h-5 bg-gray-200 rounded mb-4" />
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="flex gap-4 py-3 border-b border-gray-50">
          <div className="w-24 h-4 bg-gray-200 rounded" />
          <div className="w-16 h-4 bg-gray-200 rounded" />
          <div className="w-20 h-4 bg-gray-200 rounded" />
          <div className="flex-1" />
          <div className="w-16 h-5 bg-gray-200 rounded-full" />
        </div>
      ))}
    </div>
  </div>
);

// ============================================================================
// Main Component
// ============================================================================

const TenantBillingPage: React.FC = () => {
  const {
    subscription,
    invoices,
    planLimits,
    usageMetrics,
    isLoading,
    error,
    refetch,
  } = useTenantBilling();

  if (isLoading) {
    return <BillingSkeleton />;
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Billing & Subscription</h1>
          <p className="text-sm text-gray-500 mt-1">
            View your subscription details, invoices, and usage metrics
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => refetch()}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-5 h-5 text-gray-500" />
          </button>
          <span className="px-3 py-1.5 rounded-lg bg-amber-50 text-amber-700 text-xs font-medium">
            Read-Only
          </span>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-800">Failed to load billing data</p>
            <p className="text-sm text-red-600">{(error as Error).message}</p>
          </div>
          <button
            onClick={() => refetch()}
            className="ml-auto px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-100 rounded-lg transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Subscription Card */}
      {subscription ? (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="p-6 border-b border-gray-100 bg-gradient-to-r from-tenant-50 to-white">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-tenant-100">
                  <CreditCard className="w-6 h-6 text-tenant-600" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-gray-900">
                    {subscription.plan} Plan
                  </h2>
                  <SubscriptionStatusBadge status={subscription.status} />
                </div>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold text-gray-900">
                  {subscription.currency === 'USD' ? '$' : subscription.currency}
                  {parseMoney(subscription.monthlyPriceDecimal).toFixed(2)}
                </p>
                <p className="text-sm text-gray-500">
                  / {subscription.billingPeriod === 'MONTHLY' ? 'month' : 'year'}
                </p>
              </div>
            </div>
          </div>
          <div className="p-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase">Billing Period</p>
              <p className="text-sm text-gray-900 mt-0.5">
                {subscription.billingPeriod === 'MONTHLY' ? 'Monthly' : 'Yearly'}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase">Current Period</p>
              <p className="text-sm text-gray-900 mt-0.5">
                {new Date(subscription.currentPeriodStart).toLocaleDateString()} -{' '}
                {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
              </p>
            </div>
            {subscription.trialEndDate && (
              <div>
                <p className="text-xs font-medium text-gray-500 uppercase">Trial Ends</p>
                <p className="text-sm text-gray-900 mt-0.5">
                  {new Date(subscription.trialEndDate).toLocaleDateString()}
                </p>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
          <CreditCard className="w-12 h-12 text-gray-500 mx-auto" />
          <h3 className="mt-4 text-sm font-medium text-gray-900">No subscription data</h3>
          <p className="mt-1 text-sm text-gray-500">
            Subscription information will appear here once billing is configured.
          </p>
        </div>
      )}

      {/* Plan Limits */}
      {planLimits && (
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Plan Limits</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <UsageBar
              label="Farms"
              current={planLimits.currentFarms}
              limit={planLimits.maxFarms}
              icon={<Waves className="w-4 h-4 text-tenant-500" />}
            />
            <UsageBar
              label="Sensors"
              current={planLimits.currentSensors}
              limit={planLimits.maxSensors}
              icon={<Cpu className="w-4 h-4 text-blue-500" />}
            />
            <UsageBar
              label="Users"
              current={planLimits.currentUsers}
              limit={planLimits.maxUsers}
              icon={<Users className="w-4 h-4 text-purple-500" />}
            />
            <UsageBar
              label="Storage"
              current={planLimits.currentStorage}
              limit={planLimits.maxStorage}
              unit=" GB"
              icon={<HardDrive className="w-4 h-4 text-yellow-500" />}
            />
          </div>
        </div>
      )}

      {/* Usage Metrics */}
      {usageMetrics && (
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Usage Metrics</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatCard
              label="API Calls"
              value={usageMetrics.apiCallsThisMonth.toLocaleString()}
              subtext={`of ${usageMetrics.apiCallsLimit.toLocaleString()} limit`}
              icon={<TrendingUp className="w-5 h-5 text-tenant-600" />}
              color="bg-tenant-50"
            />
            <StatCard
              label="Storage Used"
              value={`${usageMetrics.storageUsedGb.toFixed(1)} GB`}
              subtext={`of ${usageMetrics.storageLimit} GB limit`}
              icon={<HardDrive className="w-5 h-5 text-blue-600" />}
              color="bg-blue-50"
            />
            <StatCard
              label="Sensor Readings"
              value={usageMetrics.sensorReadingsThisMonth.toLocaleString()}
              subtext={`of ${usageMetrics.sensorReadingsLimit.toLocaleString()} limit`}
              icon={<BarChart3 className="w-5 h-5 text-purple-600" />}
              color="bg-purple-50"
            />
          </div>
        </div>
      )}

      {/* Invoices */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Invoices</h2>
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          {invoices.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-100">
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Invoice
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Date
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider hidden sm:table-cell">
                      Due Date
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Amount
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {invoices.map((invoice: TenantInvoice) => (
                    <tr key={invoice.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <FileText className="w-4 h-4 text-gray-500" />
                          <div>
                            <p className="text-sm font-medium text-gray-900">
                              {invoice.invoiceNumber}
                            </p>
                            <p className="text-xs text-gray-500">{invoice.description}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className="text-sm text-gray-600">
                          {new Date(invoice.issuedAt).toLocaleDateString()}
                        </span>
                      </td>
                      <td className="px-6 py-4 hidden sm:table-cell">
                        <span className="text-sm text-gray-600">
                          {new Date(invoice.dueDate).toLocaleDateString()}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <span className="text-sm font-medium text-gray-900">
                          {invoice.currency === 'USD' ? '$' : invoice.currency}
                          {parseMoney(invoice.amountDecimal).toFixed(2)}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <InvoiceStatusBadge status={invoice.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-12 text-center">
              <FileText className="w-12 h-12 text-gray-500 mx-auto" />
              <h3 className="mt-4 text-sm font-medium text-gray-900">No invoices</h3>
              <p className="mt-1 text-sm text-gray-500">
                Invoices will appear here once billing is active.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Payment History Note */}
      {invoices.filter((inv) => inv.paidAt).length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Payment History</h2>
          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-100">
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Invoice
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Paid Date
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {invoices
                    .filter((inv) => inv.paidAt)
                    .map((invoice) => (
                      <tr key={`payment-${invoice.id}`} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-3">
                          <div className="flex items-center gap-2">
                            <CheckCircle className="w-4 h-4 text-green-500" />
                            <span className="text-sm text-gray-900">{invoice.invoiceNumber}</span>
                          </div>
                        </td>
                        <td className="px-6 py-3">
                          <div className="flex items-center gap-2">
                            <Calendar className="w-3.5 h-3.5 text-gray-500" />
                            <span className="text-sm text-gray-600">
                              {invoice.paidAt ? new Date(invoice.paidAt).toLocaleDateString() : '--'}
                            </span>
                          </div>
                        </td>
                        <td className="px-6 py-3 text-right">
                          <span className="text-sm font-medium text-green-600">
                            {invoice.currency === 'USD' ? '$' : invoice.currency}
                            {parseMoney(invoice.amountDecimal).toFixed(2)}
                          </span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Info Banner */}
      <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-medium text-blue-800">Read-Only View</p>
          <p className="text-sm text-blue-600 mt-0.5">
            To change your subscription plan or update payment details, please contact your account
            manager or reach out through Support.
          </p>
        </div>
      </div>
    </div>
  );
};

export default TenantBillingPage;
