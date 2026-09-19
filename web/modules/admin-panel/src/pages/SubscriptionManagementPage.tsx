/**
 * Subscription Management Page
 *
 * Admin panel for managing subscriptions, plans, and billing.
 */

import React, { useState, useEffect } from 'react';
import {
  Card,
  Button,
  Badge,
  DataTable,
  Input,
  Modal,
  type DataTableColumn,
  PageHeader,
} from '@aquaculture/shared-ui';
import {
  billingApi,
  SubscriptionOverview,
  SubscriptionStats,
  SubscriptionStatus,
  BillingCycle,
  PlanTier,
} from '../services/adminApi';
import { expectedTotalPages } from '@platform/pagination-contracts';

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
  const [selectedSubscription, setSelectedSubscription] = useState<SubscriptionOverview | null>(
    null,
  );
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

  const closeCancelModal = (): void => {
    setShowCancelModal(false);
    setSelectedSubscription(null);
    setCancelReason('');
  };

  const closeExtendTrialModal = (): void => {
    setShowExtendTrialModal(false);
    setSelectedSubscription(null);
    setTrialDays(7);
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
    const variants: Record<
      SubscriptionStatus,
      'success' | 'warning' | 'error' | 'info' | 'default'
    > = {
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

  const totalPages = expectedTotalPages(total, limit);

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

  const subscriptionColumns: DataTableColumn<SubscriptionOverview>[] = [
    {
      key: 'tenantName',
      header: 'Tenant',
      render: (_value, sub) => (
        <>
          <div className="font-medium text-gray-900">{sub.tenantName}</div>
          <div className="text-sm text-gray-500">{sub.tenantId.substring(0, 8)}...</div>
        </>
      ),
    },
    {
      key: 'planName',
      header: 'Plan',
      render: (_value, sub) => (
        <>
          <div className="font-medium">{sub.planName}</div>
          <div className="text-sm text-gray-500">{sub.planTier}</div>
        </>
      ),
    },
    { key: 'status', header: 'Status', render: (_value, sub) => getStatusBadge(sub.status) },
    {
      key: 'monthlyPrice',
      header: 'Billing',
      render: (_value, sub) => (
        <>
          <div>{formatCurrency(sub.monthlyPrice)}/mo</div>
          <div className="text-sm text-gray-500">{sub.billingCycle}</div>
        </>
      ),
    },
    {
      key: 'currentPeriodEnd',
      header: 'Period End',
      render: (_value, sub) => (
        <span className="text-sm text-gray-500">{formatDate(sub.currentPeriodEnd)}</span>
      ),
    },
    {
      key: 'autoRenew',
      header: 'Auto Renew',
      render: (_value, sub) =>
        sub.autoRenew ? <Badge variant="success">Yes</Badge> : <Badge variant="default">No</Badge>,
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (_value, sub) => (
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
            <Button variant="outline" size="sm" onClick={() => handleReactivate(sub.tenantId)}>
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
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        title="Subscription Management"
        description="Manage tenant subscriptions, billing cycles, and plan changes"
      />

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="p-4">
            <div className="text-sm font-medium text-gray-500">MRR</div>
            <div className="mt-1 text-2xl font-bold text-green-600">
              {formatCurrency(stats.mrr)}
            </div>
            <div className="text-xs text-gray-500">ARR: {formatCurrency(stats.arr)}</div>
          </Card>

          <Card className="p-4">
            <div className="text-sm font-medium text-gray-500">Total Subscriptions</div>
            <div className="mt-1 text-2xl font-bold text-gray-900">{stats.totalSubscriptions}</div>
            <div className="text-xs text-gray-500">
              Active: {stats.byStatus[SubscriptionStatus.ACTIVE] || 0}
            </div>
          </Card>

          <Card className="p-4">
            <div className="text-sm font-medium text-gray-500">Churn Rate</div>
            <div className="mt-1 text-2xl font-bold text-orange-600">
              {stats.churnRate.toFixed(1)}%
            </div>
            <div className="text-xs text-gray-500">
              Trial Conversion: {stats.trialConversionRate.toFixed(1)}%
            </div>
          </Card>

          <Card className="p-4">
            <div className="text-sm font-medium text-gray-500">Attention Needed</div>
            <div className="mt-1 text-2xl font-bold text-red-600">{stats.pastDueCount}</div>
            <div className="text-xs text-gray-500">
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
              <div key={status} className="flex items-center gap-2 px-4 py-2 bg-gray-50 rounded-lg">
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
      <DataTable<SubscriptionOverview>
        data={subscriptions}
        columns={subscriptionColumns}
        keyExtractor={(sub) => sub.id}
        loading={loading}
        loadingMessage="Loading subscriptions..."
        emptyMessage="No subscriptions found"
        searchable={false}
        sortable={false}
        stickyHeader={false}
        pagination={{ page, limit, total, totalPages }}
        onPageChange={setPage}
      />

      {/* Cancel Modal */}
      {showCancelModal && selectedSubscription && (
        <Modal
          isOpen
          onClose={closeCancelModal}
          size="sm"
          title="Cancel Subscription"
          bodyClassName="p-6"
          footer={
            <>
              <Button variant="outline" onClick={closeCancelModal}>
                Cancel
              </Button>
              <Button variant="danger" onClick={handleCancelSubscription} disabled={!cancelReason}>
                Confirm Cancellation
              </Button>
            </>
          }
        >
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
        </Modal>
      )}

      {/* Extend Trial Modal */}
      {showExtendTrialModal && selectedSubscription && (
        <Modal
          isOpen
          onClose={closeExtendTrialModal}
          size="sm"
          title="Extend Trial Period"
          bodyClassName="p-6"
          footer={
            <>
              <Button variant="outline" onClick={closeExtendTrialModal}>
                Cancel
              </Button>
              <Button onClick={handleExtendTrial} disabled={trialDays <= 0}>
                Extend Trial
              </Button>
            </>
          }
        >
          <p className="text-gray-600 mb-4">
            Extend the trial period for <strong>{selectedSubscription.tenantName}</strong>
          </p>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">Additional Days</label>
            <Input
              type="number"
              min={1}
              max={90}
              value={trialDays}
              onChange={(e) => setTrialDays(parseInt(e.target.value, 10) || 0)}
            />
          </div>
        </Modal>
      )}
    </div>
  );
};

export default SubscriptionManagementPage;
