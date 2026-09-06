/**
 * Custom Plans List Page
 *
 * Lists all custom plans with status-based filtering, approval workflow actions
 * (submit, approve, reject, activate, clone, delete), and navigation to the builder.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Button, Badge, Input } from '@aquaculture/shared-ui';
import {
  billingApi,
  CustomPlan,
  CustomPlanStatus,
  PaginatedCustomPlans,
  PlanTier,
} from '../services/adminApi';
import { expectedTotalPages } from '@platform/pagination-contracts';

// ============================================================================
// Constants
// ============================================================================

const STATUS_CONFIG: Record<
  CustomPlanStatus,
  { label: string; variant: 'default' | 'info' | 'warning' | 'success' | 'error' | 'outline' }
> = {
  [CustomPlanStatus.DRAFT]: { label: 'Draft', variant: 'default' },
  [CustomPlanStatus.PENDING_APPROVAL]: { label: 'Pending Approval', variant: 'warning' },
  [CustomPlanStatus.APPROVED]: { label: 'Approved', variant: 'info' },
  [CustomPlanStatus.REJECTED]: { label: 'Rejected', variant: 'error' },
  [CustomPlanStatus.ACTIVE]: { label: 'Active', variant: 'success' },
  [CustomPlanStatus.EXPIRED]: { label: 'Expired', variant: 'default' },
  [CustomPlanStatus.CANCELLED]: { label: 'Cancelled', variant: 'default' },
};

const TIER_LABELS: Record<PlanTier, string> = {
  [PlanTier.FREE]: 'Free',
  [PlanTier.STARTER]: 'Starter',
  [PlanTier.PROFESSIONAL]: 'Professional',
  [PlanTier.ENTERPRISE]: 'Enterprise',
  [PlanTier.CUSTOM]: 'Custom',
};

const STATUS_FILTERS: { value: CustomPlanStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All Statuses' },
  { value: CustomPlanStatus.DRAFT, label: 'Draft' },
  { value: CustomPlanStatus.PENDING_APPROVAL, label: 'Pending Approval' },
  { value: CustomPlanStatus.APPROVED, label: 'Approved' },
  { value: CustomPlanStatus.ACTIVE, label: 'Active' },
  { value: CustomPlanStatus.REJECTED, label: 'Rejected' },
  { value: CustomPlanStatus.EXPIRED, label: 'Expired' },
  { value: CustomPlanStatus.CANCELLED, label: 'Cancelled' },
];

// ============================================================================
// Custom Plans List Page
// ============================================================================

const CustomPlansListPage: React.FC = () => {
  const navigate = useNavigate();

  const [plans, setPlans] = useState<readonly CustomPlan[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<CustomPlanStatus | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const limit = 20;

  // Reject modal
  const [rejectModal, setRejectModal] = useState<{ planId: string; planName: string } | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  // Clone modal
  const [cloneModal, setCloneModal] = useState<{ planId: string; planName: string } | null>(null);
  const [cloneTenantId, setCloneTenantId] = useState('');

  // ============================================================================
  // Data Loading
  // ============================================================================

  const loadPlans = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result: PaginatedCustomPlans = await billingApi.getCustomPlans({
        status: statusFilter !== 'all' ? statusFilter : undefined,
        search: searchQuery || undefined,
        page,
        limit,
      });
      setPlans(result.data);
      setTotal(result.total || 0);
    } catch (err) {
      console.error('Failed to load custom plans:', err);
      setError((err as Error).message || 'Failed to load custom plans');
      setPlans([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, searchQuery, page]);

  useEffect(() => {
    loadPlans();
  }, [loadPlans]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [statusFilter, searchQuery]);

  // ============================================================================
  // Actions
  // ============================================================================

  const handleSubmitForApproval = async (planId: string) => {
    setActionLoading(planId);
    setError(null);
    try {
      await billingApi.submitCustomPlanForApproval(planId);
      setSuccess('Plan submitted for approval.');
      loadPlans();
    } catch (err) {
      setError((err as Error).message || 'Failed to submit plan for approval');
    } finally {
      setActionLoading(null);
    }
  };

  const handleApprove = async (planId: string) => {
    setActionLoading(planId);
    setError(null);
    try {
      await billingApi.approveCustomPlan(planId, 'admin');
      setSuccess('Plan approved successfully.');
      loadPlans();
    } catch (err) {
      setError((err as Error).message || 'Failed to approve plan');
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async () => {
    if (!rejectModal || !rejectReason.trim()) {
      setError('Please provide a rejection reason.');
      return;
    }

    setActionLoading(rejectModal.planId);
    setError(null);
    try {
      await billingApi.rejectCustomPlan(rejectModal.planId, rejectReason.trim(), 'admin');
      setSuccess(`Plan "${rejectModal.planName}" rejected.`);
      setRejectModal(null);
      setRejectReason('');
      loadPlans();
    } catch (err) {
      setError((err as Error).message || 'Failed to reject plan');
    } finally {
      setActionLoading(null);
    }
  };

  const handleActivate = async (planId: string) => {
    setActionLoading(planId);
    setError(null);
    try {
      await billingApi.activateCustomPlan(planId);
      setSuccess('Plan activated successfully.');
      loadPlans();
    } catch (err) {
      setError((err as Error).message || 'Failed to activate plan');
    } finally {
      setActionLoading(null);
    }
  };

  const handleClone = async () => {
    if (!cloneModal || !cloneTenantId.trim()) {
      setError('Please provide a tenant ID for the cloned plan.');
      return;
    }

    setActionLoading(cloneModal.planId);
    setError(null);
    try {
      await billingApi.cloneCustomPlan(cloneModal.planId, cloneTenantId.trim());
      setSuccess(`Plan "${cloneModal.planName}" cloned successfully.`);
      setCloneModal(null);
      setCloneTenantId('');
      loadPlans();
    } catch (err) {
      setError((err as Error).message || 'Failed to clone plan');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (planId: string, planName: string) => {
    if (!confirm(`Are you sure you want to delete the plan "${planName}"? This cannot be undone.`)) {
      return;
    }

    setActionLoading(planId);
    setError(null);
    try {
      await billingApi.deleteCustomPlan(planId);
      setSuccess(`Plan "${planName}" deleted.`);
      loadPlans();
    } catch (err) {
      setError((err as Error).message || 'Failed to delete plan');
    } finally {
      setActionLoading(null);
    }
  };

  // ============================================================================
  // Helpers
  // ============================================================================

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount);

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const getStatusCounts = () => {
    const counts: Record<string, number> = {};
    plans.forEach((p) => {
      counts[p.status] = (counts[p.status] || 0) + 1;
    });
    return counts;
  };

  const totalPages = expectedTotalPages(total, limit);

  // ============================================================================
  // Render
  // ============================================================================

  if (loading && plans.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Custom Plans</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage custom plans, approvals, and activations
          </p>
        </div>
        <div className="mt-4 sm:mt-0">
          <Button onClick={() => navigate('/admin/billing/custom-plan-builder')}>
            Create Custom Plan
          </Button>
        </div>
      </div>

      {/* Alerts */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          {error}
          <button
            onClick={() => setError(null)}
            className="ml-4 text-red-500 hover:text-red-700"
          >
            Dismiss
          </button>
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-green-700">
          {success}
          <button
            onClick={() => setSuccess(null)}
            className="ml-4 text-green-500 hover:text-green-700"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        {STATUS_FILTERS.filter((s) => s.value !== 'all').map((statusItem) => {
          const counts = getStatusCounts();
          const count = counts[statusItem.value] || 0;
          const cfg = STATUS_CONFIG[statusItem.value as CustomPlanStatus];
          return (
            <Card
              key={statusItem.value}
              className={`p-3 cursor-pointer transition-all ${
                statusFilter === statusItem.value
                  ? 'ring-2 ring-blue-500 bg-blue-50'
                  : 'hover:bg-gray-50'
              }`}
              onClick={() =>
                setStatusFilter(
                  statusFilter === statusItem.value ? 'all' : (statusItem.value as CustomPlanStatus)
                )
              }
            >
              <div className="text-xs font-medium text-gray-500">{cfg.label}</div>
              <div className="mt-1 text-xl font-bold text-gray-900">{count}</div>
            </Card>
          );
        })}
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <Input
              placeholder="Search by plan name or tenant ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div>
            <select
              className="w-full sm:w-48 px-3 py-2 border border-gray-300 rounded-md focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as CustomPlanStatus | 'all')
              }
            >
              {STATUS_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      {/* Plans Table */}
      <Card>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Plan
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Tenant
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Tier
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Monthly Total
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Modules
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Validity
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {plans.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-gray-500">
                    {loading ? 'Loading...' : 'No custom plans found.'}
                  </td>
                </tr>
              ) : (
                plans.map((plan) => {
                  const statusCfg = STATUS_CONFIG[plan.status];
                  const isLoading = actionLoading === plan.id;

                  return (
                    <tr key={plan.id} className="hover:bg-gray-50">
                      {/* Plan Name */}
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="font-medium text-gray-900">{plan.name}</div>
                        {plan.description && (
                          <div className="text-sm text-gray-500 truncate max-w-xs">
                            {plan.description}
                          </div>
                        )}
                      </td>

                      {/* Tenant */}
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-mono text-gray-600 truncate max-w-[180px]" title={plan.tenantId}>
                          {plan.tenantId}
                        </div>
                      </td>

                      {/* Tier */}
                      <td className="px-6 py-4 whitespace-nowrap">
                        <Badge variant="info">
                          {TIER_LABELS[plan.tier] || plan.tier}
                        </Badge>
                      </td>

                      {/* Monthly Total */}
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-semibold text-gray-900">
                          {formatCurrency(plan.monthlyTotal)}
                        </div>
                        {plan.discountPercent > 0 && (
                          <div className="text-xs text-green-600">
                            -{plan.discountPercent}% discount
                          </div>
                        )}
                      </td>

                      {/* Modules */}
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-600">
                          {plan.modules?.length || 0} module{(plan.modules?.length || 0) !== 1 ? 's' : ''}
                        </div>
                      </td>

                      {/* Validity */}
                      <td className="px-6 py-4 whitespace-nowrap text-sm">
                        <div>{formatDate(plan.validFrom)}</div>
                        {plan.validTo && (
                          <div className="text-gray-400">to {formatDate(plan.validTo)}</div>
                        )}
                      </td>

                      {/* Status */}
                      <td className="px-6 py-4 whitespace-nowrap">
                        <Badge variant={statusCfg.variant}>{statusCfg.label}</Badge>
                        {plan.rejectionReason && plan.status === CustomPlanStatus.REJECTED && (
                          <div className="text-xs text-red-500 mt-1 truncate max-w-[140px]" title={plan.rejectionReason}>
                            {plan.rejectionReason}
                          </div>
                        )}
                        {plan.approvedBy && plan.status === CustomPlanStatus.APPROVED && (
                          <div className="text-xs text-gray-400 mt-1">
                            by {plan.approvedBy}
                          </div>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="px-6 py-4 whitespace-nowrap text-right">
                        <div className="flex items-center justify-end gap-2 flex-wrap">
                          {/* Draft -> Submit */}
                          {plan.status === CustomPlanStatus.DRAFT && (
                            <>
                              <Button
                                variant="primary"
                                size="sm"
                                disabled={isLoading}
                                onClick={() => handleSubmitForApproval(plan.id)}
                              >
                                {isLoading ? '...' : 'Submit'}
                              </Button>
                              <Button
                                variant="danger"
                                size="sm"
                                disabled={isLoading}
                                onClick={() => handleDelete(plan.id, plan.name)}
                              >
                                Delete
                              </Button>
                            </>
                          )}

                          {/* Pending Approval -> Approve / Reject */}
                          {plan.status === CustomPlanStatus.PENDING_APPROVAL && (
                            <>
                              <Button
                                variant="primary"
                                size="sm"
                                disabled={isLoading}
                                onClick={() => handleApprove(plan.id)}
                              >
                                {isLoading ? '...' : 'Approve'}
                              </Button>
                              <Button
                                variant="danger"
                                size="sm"
                                disabled={isLoading}
                                onClick={() =>
                                  setRejectModal({ planId: plan.id, planName: plan.name })
                                }
                              >
                                Reject
                              </Button>
                            </>
                          )}

                          {/* Approved -> Activate */}
                          {plan.status === CustomPlanStatus.APPROVED && (
                            <Button
                              variant="primary"
                              size="sm"
                              disabled={isLoading}
                              onClick={() => handleActivate(plan.id)}
                            >
                              {isLoading ? '...' : 'Activate'}
                            </Button>
                          )}

                          {/* Clone (available on any status) */}
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={isLoading}
                            onClick={() =>
                              setCloneModal({ planId: plan.id, planName: plan.name })
                            }
                          >
                            Clone
                          </Button>

                          {/* Rejected -> can Delete */}
                          {plan.status === CustomPlanStatus.REJECTED && (
                            <Button
                              variant="danger"
                              size="sm"
                              disabled={isLoading}
                              onClick={() => handleDelete(plan.id, plan.name)}
                            >
                              Delete
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-6 py-3 border-t border-gray-200">
            <div className="text-sm text-gray-500">
              Showing {(page - 1) * limit + 1}-{Math.min(page * limit, total)} of {total} plans
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Reject Modal */}
      {rejectModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="w-full max-w-md p-6">
            <h3 className="text-lg font-semibold mb-2">Reject Plan</h3>
            <p className="text-sm text-gray-500 mb-4">
              Rejecting: <span className="font-medium text-gray-700">{rejectModal.planName}</span>
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Rejection Reason <span className="text-red-500">*</span>
                </label>
                <textarea
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-hidden focus:ring-2 focus:ring-blue-500 resize-none"
                  rows={3}
                  placeholder="Explain why this plan is being rejected..."
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                />
              </div>
            </div>

            <div className="flex gap-3 justify-end mt-6">
              <Button
                variant="outline"
                onClick={() => {
                  setRejectModal(null);
                  setRejectReason('');
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={!rejectReason.trim() || actionLoading === rejectModal.planId}
                onClick={handleReject}
              >
                {actionLoading === rejectModal.planId ? 'Rejecting...' : 'Reject Plan'}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Clone Modal */}
      {cloneModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="w-full max-w-md p-6">
            <h3 className="text-lg font-semibold mb-2">Clone Plan</h3>
            <p className="text-sm text-gray-500 mb-4">
              Cloning: <span className="font-medium text-gray-700">{cloneModal.planName}</span>
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Target Tenant ID <span className="text-red-500">*</span>
                </label>
                <Input
                  placeholder="tenant-uuid"
                  value={cloneTenantId}
                  onChange={(e) => setCloneTenantId(e.target.value)}
                />
                <p className="mt-1 text-xs text-gray-400">
                  The cloned plan will be created as a draft for this tenant.
                </p>
              </div>
            </div>

            <div className="flex gap-3 justify-end mt-6">
              <Button
                variant="outline"
                onClick={() => {
                  setCloneModal(null);
                  setCloneTenantId('');
                }}
              >
                Cancel
              </Button>
              <Button
                disabled={!cloneTenantId.trim() || actionLoading === cloneModal.planId}
                onClick={handleClone}
              >
                {actionLoading === cloneModal.planId ? 'Cloning...' : 'Clone Plan'}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};

export default CustomPlansListPage;
