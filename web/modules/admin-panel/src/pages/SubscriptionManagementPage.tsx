/**
 * Subscription Management Page
 *
 * Admin panel for managing subscriptions, plans, and billing.
 */

import React, { useState, useEffect } from 'react';
import { Card, Button, Badge, Input } from '@aquaculture/shared-ui';
import {
  billingApi,
  SubscriptionOverview,
  SubscriptionStats,
  SubscriptionStatus,
  BillingCycle,
  PlanTier,
} from '../services/adminApi';

// ============================================================================
// Subscription Management Page
// ============================================================================

const SubscriptionManagementPage: React.FC = () => {
  const [subscriptions, setSubscriptions] = useState<SubscriptionOverview[]>([]);
  const [stats, setStats] = useState<SubscriptionStats | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<SubscriptionStatus | ''>('');
  const [planFilter, setPlanFilter] = useState<PlanTier | ''>('');
  const [page, setPage] = useState(1);
  const limit = 20;

  // Modals
  const [selectedSubscription, setSelectedSubscription] = useState<SubscriptionOverview | null>(null);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [showExtendTrialModal, setShowExtendTrialModal] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [trialDays, setTrialDays] = useState(7);

  useEffect(() => {
    loadData();
  }, [search, statusFilter, planFilter, page]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [subsResult, statsResult] = await Promise.all([
        billingApi.getSubscriptions({
          search: search || undefined,
          status: statusFilter ? [statusFilter] : undefined,
          planTier: planFilter ? [planFilter] : undefined,
          limit,
          offset: (page - 1) * limit,
        }),
        billingApi.getSubscriptionStats(),
      ]);
      setSubscriptions(subsResult.subscriptions);
      setTotal(subsResult.total);
      setStats(statsResult);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleCancelSubscription = async () => {
    if (!selectedSubscription || !cancelReason) return;

    try {
      await billingApi.cancelSubscription(
        selectedSubscription.tenantId,
        cancelReason,
        'admin', // TODO: get from auth context
      );
      setShowCancelModal(false);
      setSelectedSubscription(null);
      setCancelReason('');
      loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleExtendTrial = async () => {
    if (!selectedSubscription || trialDays <= 0) return;

    try {
      await billingApi.extendTrial(
        selectedSubscription.tenantId,
        trialDays,
        'admin', // TODO: get from auth context
      );
      setShowExtendTrialModal(false);
      setSelectedSubscription(null);
      setTrialDays(7);
      loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleReactivate = async (tenantId: string) => {
    try {
      await billingApi.reactivateSubscription(tenantId, 'admin');
      loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const getStatusBadge = (status: SubscriptionStatus) => {
    const variants: Record<SubscriptionStatus, 'success' | 'warning' | 'error' | 'info' | 'default'> = {
      [SubscriptionStatus.ACTIVE]: 'success',
      [SubscriptionStatus.TRIAL]: 'info',
      [SubscriptionStatus.PAST_DUE]: 'warning',
      [SubscriptionStatus.CANCELLED]: 'error',
      [SubscriptionStatus.SUSPENDED]: 'error',
      [SubscriptionStatus.EXPIRED]: 'default',
    };
    return <Badge variant={variants[status]}>{status.replace('_', ' ').toUpperCase()}</Badge>;
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(amount);
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const totalPages = Math.ceil(total / limit);

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
        {error}
        <Button onClick={loadData} className="ml-4">
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Subscription Management</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage tenant subscriptions, billing cycles, and plan changes
          </p>
        </div>
        <div className="mt-4 sm:mt-0">
          <Button onClick={() => billingApi.processRenewals()}>
            Process Renewals
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="p-4">
            <div className="text-sm font-medium text-gray-500">MRR</div>
            <div className="mt-1 text-2xl font-bold text-green-600">
              {formatCurrency(stats.mrr)}
            </div>
            <div className="text-xs text-gray-400">
              ARR: {formatCurrency(stats.arr)}
            </div>
          </Card>

          <Card className="p-4">
            <div className="text-sm font-medium text-gray-500">Total Subscriptions</div>
            <div className="mt-1 text-2xl font-bold text-gray-900">
              {stats.totalSubscriptions}
            </div>
            <div className="text-xs text-gray-400">
              Active: {stats.byStatus[SubscriptionStatus.ACTIVE] || 0}
            </div>
          </Card>

          <Card className="p-4">
            <div className="text-sm font-medium text-gray-500">Churn Rate</div>
            <div className="mt-1 text-2xl font-bold text-orange-600">
              {stats.churnRate.toFixed(1)}%
            </div>
            <div className="text-xs text-gray-400">
              Trial Conversion: {stats.trialConversionRate.toFixed(1)}%
            </div>
          </Card>

          <Card className="p-4">
            <div className="text-sm font-medium text-gray-500">Attention Needed</div>
            <div className="mt-1 text-2xl font-bold text-red-600">
              {stats.pastDueCount}
            </div>
            <div className="text-xs text-gray-400">
              Expiring this month: {stats.expiringThisMonth}
            </div>
          </Card>
        </div>
      )}

      {/* Status Breakdown */}
      {stats && (
        <Card className="p-4">
          <h3 className="text-lg font-semibold mb-4">Subscription Status Breakdown</h3>
          <div className="flex flex-wrap gap-4">
            {Object.entries(stats.byStatus).map(([status, count]) => (
              <div
                key={status}
                className="flex items-center gap-2 px-4 py-2 bg-gray-50 rounded-lg"
              >
                {getStatusBadge(status as SubscriptionStatus)}
                <span className="font-semibold">{count}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Filters */}
      <Card className="p-4">
        <div className="flex flex-wrap gap-4">
          <div className="flex-1 min-w-[200px]">
            <Input
              placeholder="Search by tenant name..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>

          <select
            className="px-3 py-2 border border-gray-300 rounded-lg"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as SubscriptionStatus | '');
              setPage(1);
            }}
          >
            <option value="">All Statuses</option>
            {Object.values(SubscriptionStatus).map((status) => (
              <option key={status} value={status}>
                {status.replace('_', ' ').toUpperCase()}
              </option>
            ))}
          </select>

          <select
            className="px-3 py-2 border border-gray-300 rounded-lg"
            value={planFilter}
            onChange={(e) => {
              setPlanFilter(e.target.value as PlanTier | '');
              setPage(1);
            }}
          >
            <option value="">All Plans</option>
            {Object.values(PlanTier).map((tier) => (
              <option key={tier} value={tier}>
                {tier.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
      </Card>

      {/* Subscriptions Table */}
      <Card>
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Tenant
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Plan
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Billing
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Period End
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Auto Renew
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {subscriptions.map((sub) => (
                  <tr key={sub.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="font-medium text-gray-900">{sub.tenantName}</div>
                      <div className="text-sm text-gray-500">{sub.tenantId.substring(0, 8)}...</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="font-medium">{sub.planName}</div>
                      <div className="text-sm text-gray-500">{sub.planTier}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {getStatusBadge(sub.status)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div>{formatCurrency(sub.monthlyPrice)}/mo</div>
                      <div className="text-sm text-gray-500">{sub.billingCycle}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {formatDate(sub.currentPeriodEnd)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {sub.autoRenew ? (
                        <Badge variant="success">Yes</Badge>
                      ) : (
                        <Badge variant="default">No</Badge>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <div className="flex gap-2 justify-end">
                        {sub.status === SubscriptionStatus.TRIAL && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setSelectedSubscription(sub);
                              setShowExtendTrialModal(true);
                            }}
                          >
                            Extend Trial
                          </Button>
                        )}
                        {sub.status === SubscriptionStatus.CANCELLED && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleReactivate(sub.tenantId)}
                          >
                            Reactivate
                          </Button>
                        )}
                        {(sub.status === SubscriptionStatus.ACTIVE ||
                          sub.status === SubscriptionStatus.TRIAL) && (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => {
                              setSelectedSubscription(sub);
                              setShowCancelModal(true);
                            }}
                          >
                            Cancel
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
            <div className="text-sm text-gray-500">
              Showing {(page - 1) * limit + 1} to {Math.min(page * limit, total)} of {total} results
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 1}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page === totalPages}
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Cancel Modal */}
      {showCancelModal && selectedSubscription && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <Card className="w-full max-w-md p-6">
            <h3 className="text-lg font-semibold mb-4">Cancel Subscription</h3>
            <p className="text-gray-600 mb-4">
              Are you sure you want to cancel the subscription for{' '}
              <strong>{selectedSubscription.tenantName}</strong>?
            </p>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Cancellation Reason
              </label>
              <textarea
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                rows={3}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="Enter the reason for cancellation..."
              />
            </div>
            <div className="flex gap-3 justify-end">
              <Button
                variant="outline"
                onClick={() => {
                  setShowCancelModal(false);
                  setSelectedSubscription(null);
                  setCancelReason('');
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={handleCancelSubscription}
                disabled={!cancelReason}
              >
                Confirm Cancellation
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Extend Trial Modal */}
      {showExtendTrialModal && selectedSubscription && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <Card className="w-full max-w-md p-6">
            <h3 className="text-lg font-semibold mb-4">Extend Trial Period</h3>
            <p className="text-gray-600 mb-4">
              Extend the trial period for{' '}
              <strong>{selectedSubscription.tenantName}</strong>
            </p>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Additional Days
              </label>
              <Input
                type="number"
                min={1}
                max={90}
                value={trialDays}
                onChange={(e) => setTrialDays(parseInt(e.target.value, 10) || 0)}
              />
            </div>
            <div className="flex gap-3 justify-end">
              <Button
                variant="outline"
                onClick={() => {
                  setShowExtendTrialModal(false);
                  setSelectedSubscription(null);
                  setTrialDays(7);
                }}
              >
                Cancel
              </Button>
              <Button onClick={handleExtendTrial} disabled={trialDays <= 0}>
                Extend Trial
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};

export default SubscriptionManagementPage;
