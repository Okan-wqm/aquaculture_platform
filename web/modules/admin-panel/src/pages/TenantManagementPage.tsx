/**
 * Tenant Management Page
 * SUPER_ADMIN icin tenant yonetimi
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card,
  Button,
  Badge,
  Table,
  Input,
  Select,
  Modal,
  Alert,
  formatDate,
} from '@aquaculture/shared-ui';
import type { TableColumn } from '@aquaculture/shared-ui';
import { tenantsApi, type Tenant, TenantTier, TenantStatus } from '../services/adminApi';

// ============================================================================
// Types
// ============================================================================

interface TenantStats {
  totalTenants: number;
  activeTenants: number;
  suspendedTenants: number;
  pendingTenants: number;
}

// ============================================================================
// Tenant Management Page
// ============================================================================

const TenantManagementPage: React.FC = () => {
  const navigate = useNavigate();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [stats, setStats] = useState<TenantStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalTenants, setTotalTenants] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(20);

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [tierFilter, setTierFilter] = useState('');

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkSuspendModalOpen, setIsBulkSuspendModalOpen] = useState(false);
  const [isBulkActivateModalOpen, setIsBulkActivateModalOpen] = useState(false);
  const [bulkSuspendReason, setBulkSuspendReason] = useState('');
  const [suspendReason, setSuspendReason] = useState('');
  const [isSuspendReasonModalOpen, setIsSuspendReasonModalOpen] = useState(false);
  const [tenantToSuspend, setTenantToSuspend] = useState<Tenant | null>(null);

  // Modals
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [selectedTenant, setSelectedTenant] = useState<Tenant | null>(null);

  // Bulk operation state
  const [saving, setSaving] = useState(false);
  const tenantRequestSeq = useRef(0);

  // Fetch tenants
  const fetchTenants = useCallback(async () => {
    const requestId = tenantRequestSeq.current + 1;
    tenantRequestSeq.current = requestId;
    setLoading(true);
    setError(null);
    try {
      const result = await tenantsApi.list({
        search: searchTerm || undefined,
        status: statusFilter || undefined,
        tier: tierFilter || undefined,
        page,
        limit,
      });
      if (tenantRequestSeq.current === requestId) {
        setTenants(result.data);
        setTotalTenants(result.total);
      }
    } catch (err) {
      if (tenantRequestSeq.current !== requestId) return;
      console.error('Failed to fetch tenants:', err);
      setTenants([]);
      setTotalTenants(0);
      setError('Failed to load tenants. Please try again.');
    } finally {
      if (tenantRequestSeq.current === requestId) {
        setLoading(false);
      }
    }
  }, [searchTerm, statusFilter, tierFilter, page, limit]);

  // Cache stats — they're aggregate values, only fetch once per session (PERF-009)
  const statsCacheRef = useRef<{ data: ReturnType<typeof tenantsApi.getStats> extends Promise<infer U> ? U : never; fetchedAt: number } | null>(null);
  const STATS_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

  const fetchInitialData = useCallback(async () => {
    try {
      const now = Date.now();
      if (statsCacheRef.current && now - statsCacheRef.current.fetchedAt < STATS_CACHE_TTL) {
        setStats(statsCacheRef.current.data as Parameters<typeof setStats>[0]);
        return;
      }
      const statsResult = await tenantsApi.getStats();
      statsCacheRef.current = { data: statsResult as never, fetchedAt: Date.now() };
      setStats(statsResult);
    } catch (err) {
      console.error('Failed to fetch stats:', err);
      setStats(null);
    }
  }, []);

  useEffect(() => {
    fetchTenants();
  }, [fetchTenants]);

  useEffect(() => {
    fetchInitialData();
  }, [fetchInitialData]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [searchTerm, statusFilter, tierFilter, page]);

  // Handle suspend/activate
  const handleToggleStatus = async (tenant: Tenant, action: 'suspend' | 'activate') => {
    // The quick-view modal shows pre-action state; close it so the outcome
    // (or the reason modal) is what the operator sees next.
    setIsDetailModalOpen(false);
    if (action === 'suspend') {
      // Require operator to provide a reason — open reason modal
      setTenantToSuspend(tenant);
      setSuspendReason('');
      setIsSuspendReasonModalOpen(true);
      return;
    }
    try {
      await tenantsApi.activate(tenant.id);
      statsCacheRef.current = null;
      fetchTenants();
      fetchInitialData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operation failed');
    }
  };

  const handleConfirmSuspend = async () => {
    if (!tenantToSuspend || !suspendReason.trim()) return;
    try {
      await tenantsApi.suspend(tenantToSuspend.id, suspendReason.trim());
      statsCacheRef.current = null;
      setIsSuspendReasonModalOpen(false);
      setTenantToSuspend(null);
      setSuspendReason('');
      fetchTenants();
      fetchInitialData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Suspend operation failed');
    }
  };

  // Bulk operations
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === tenants.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(tenants.map((t) => t.id)));
    }
  };

  const handleBulkSuspend = async () => {
    if (selectedIds.size === 0 || !bulkSuspendReason.trim()) return;
    setSaving(true);
    try {
      await tenantsApi.bulkSuspend(Array.from(selectedIds), bulkSuspendReason);
      statsCacheRef.current = null;
      setIsBulkSuspendModalOpen(false);
      setBulkSuspendReason('');
      setSelectedIds(new Set());
      fetchTenants();
      fetchInitialData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk suspension failed');
    } finally {
      setSaving(false);
    }
  };

  const handleBulkActivate = () => {
    if (selectedIds.size === 0) return;
    setIsBulkActivateModalOpen(true);
  };

  const handleConfirmBulkActivate = async () => {
    setSaving(true);
    try {
      await tenantsApi.bulkActivate(Array.from(selectedIds));
      statsCacheRef.current = null;
      setIsBulkActivateModalOpen(false);
      setSelectedIds(new Set());
      fetchTenants();
      fetchInitialData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk activation failed');
    } finally {
      setSaving(false);
    }
  };

  const getStatusVariant = (status: TenantStatus | string): 'success' | 'warning' | 'error' | 'default' => {
    const s = String(status).toLowerCase();
    if (s === 'active') return 'success';
    if (s === 'pending' || s === 'provisioning') return 'warning';
    if (s === 'suspended' || s === 'provisioning_failed') return 'error';
    return 'default';
  };

  const getTierVariant = (tier: TenantTier | string): 'success' | 'warning' | 'info' | 'default' => {
    const t = String(tier).toLowerCase();
    if (t === 'enterprise') return 'success';
    if (t === 'professional') return 'warning';
    if (t === 'starter') return 'info';
    return 'default';
  };

  const columns: TableColumn<Tenant>[] = [
    {
      key: 'select',
      header: (
        <input
          type="checkbox"
          aria-label="Select all tenants"
          checked={selectedIds.size === tenants.length && tenants.length > 0}
          onChange={toggleSelectAll}
          className="w-4 h-4 rounded border-gray-300"
        />
      ),
      render: (tenant) => (
        <input
          type="checkbox"
          aria-label={`Select ${tenant.name}`}
          checked={selectedIds.has(tenant.id)}
          onChange={() => toggleSelect(tenant.id)}
          className="w-4 h-4 rounded border-gray-300"
          onClick={(e) => e.stopPropagation()}
        />
      ),
    },
    {
      key: 'name',
      header: 'Tenant',
      sortable: true,
      render: (tenant) => (
        <div
          className="cursor-pointer hover:text-primary-600"
          onClick={() => navigate(`/admin/tenants/${tenant.id}`)}
        >
          <div className="flex items-center space-x-2">
            <p className="font-medium text-gray-900">{tenant.name}</p>
            {tenant.isTrialActive && (
              <Badge variant="warning">Trial</Badge>
            )}
          </div>
          <p className="text-sm text-gray-500">{tenant.slug}</p>
        </div>
      ),
    },
    {
      key: 'tier',
      header: 'Tier',
      sortable: true,
      render: (tenant) => (
        <Badge variant={getTierVariant(tenant.tier)}>{tenant.tier}</Badge>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (tenant) => (
        <Badge variant={getStatusVariant(tenant.status)}>{tenant.status}</Badge>
      ),
    },
    {
      key: 'stats',
      header: 'Usage',
      render: (tenant) => (
        <div className="text-sm">
          <span className="text-gray-600">{tenant.userCount ?? 0} users</span>
          <span className="mx-1 text-gray-500">|</span>
          <span className="text-gray-600">{tenant.farmCount ?? 0} farms</span>
        </div>
      ),
    },
    {
      key: 'lastActivity',
      header: 'Last Activity',
      render: (tenant) => (
        <span className="text-sm text-gray-600">
          {tenant.lastActivityAt
            ? formatDate(new Date(tenant.lastActivityAt), 'short')
            : '-'}
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: 'Created',
      sortable: true,
      render: (tenant) => formatDate(new Date(tenant.createdAt), 'short'),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (tenant) => (
        <div className="flex items-center justify-end space-x-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSelectedTenant(tenant);
              setIsDetailModalOpen(true);
            }}
          >
            Quick View
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/admin/tenants/${tenant.id}`)}
          >
            Details
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tenant Management</h1>
          <p className="mt-1 text-sm text-gray-500">
            Total {totalTenants} tenants
          </p>
        </div>
        <div className="mt-4 sm:mt-0 flex flex-wrap gap-2">
          {selectedIds.size > 0 && (
            <>
              {tenants.filter((tenant) => selectedIds.has(tenant.id)).every((tenant) => tenant.status === TenantStatus.SUSPENDED) && (
                <Button
                  variant="outline"
                  onClick={handleBulkActivate}
                  disabled={saving}
                >
                  Activate Selected ({selectedIds.size})
                </Button>
              )}
              {tenants.filter((tenant) => selectedIds.has(tenant.id)).every((tenant) => tenant.status === TenantStatus.ACTIVE) && (
                <Button
                  variant="danger"
                  onClick={() => setIsBulkSuspendModalOpen(true)}
                >
                  Suspend Selected ({selectedIds.size})
                </Button>
              )}
            </>
          )}
          <Button variant="outline" onClick={fetchTenants} disabled={loading}>
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <Alert type="error" dismissible onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Card className="p-4">
            <p className="text-sm text-gray-500">Total</p>
            <p className="text-2xl font-bold text-gray-900">{stats.totalTenants}</p>
          </Card>
          <Card className="p-4">
            <p className="text-sm text-gray-500">Active</p>
            <p className="text-2xl font-bold text-green-600">{stats.activeTenants}</p>
          </Card>
          <Card className="p-4">
            <p className="text-sm text-gray-500">Pending</p>
            <p className="text-2xl font-bold text-yellow-600">{stats.pendingTenants}</p>
          </Card>
          <Card className="p-4">
            <p className="text-sm text-gray-500">Suspended</p>
            <p className="text-2xl font-bold text-red-600">{stats.suspendedTenants}</p>
          </Card>
        </div>
      )}

      {/* Filters */}
      <Card className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <div className="sm:col-span-2">
            <Input
              placeholder="Search tenants..."
              value={searchTerm}
              onChange={(e) => { setSearchTerm(e.target.value); setPage(1); }}
              leftIcon={
                <svg className="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              }
            />
          </div>
          <Select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            options={[
              { value: '', label: 'All Statuses' },
              { value: TenantStatus.ACTIVE, label: 'Active' },
              { value: TenantStatus.PENDING, label: 'Pending' },
              { value: TenantStatus.PROVISIONING, label: 'Provisioning' },
              { value: TenantStatus.PROVISIONING_FAILED, label: 'Provisioning Failed' },
              { value: TenantStatus.SUSPENDED, label: 'Suspended' },
            ]}
          />
          <Select
            aria-label="Filter by tier"
            value={tierFilter}
            onChange={(e) => { setTierFilter(e.target.value); setPage(1); }}
            options={[
              { value: '', label: 'All Tiers' },
              { value: TenantTier.FREE, label: 'Free' },
              { value: TenantTier.STARTER, label: 'Starter' },
              { value: TenantTier.PROFESSIONAL, label: 'Professional' },
              { value: TenantTier.ENTERPRISE, label: 'Enterprise' },
            ]}
          />
        </div>
      </Card>

      {/* Table */}
      {loading ? (
        <div className="text-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto"></div>
          <p className="mt-2 text-gray-500">Loading...</p>
        </div>
      ) : (
        <Table
          data={tenants}
          columns={columns}
          keyExtractor={(tenant) => tenant.id}
          emptyMessage="No tenants found"
        />
      )}

      {/* Pagination */}
      {totalTenants > limit && (
        <div className="flex justify-center space-x-2">
          <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <span className="py-2 px-4 text-sm text-gray-600">
            Page {page} / {Math.ceil(totalTenants / limit)}
          </span>
          <Button variant="outline" size="sm" disabled={page >= Math.ceil(totalTenants / limit)} onClick={() => setPage(page + 1)}>
            Next
          </Button>
        </div>
      )}

      {/* Detail Modal */}
      <Modal
        isOpen={isDetailModalOpen}
        onClose={() => setIsDetailModalOpen(false)}
        title={selectedTenant?.name || 'Tenant Details'}
        size="lg"
      >
        {selectedTenant && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-gray-500">Slug</p>
                <p className="font-medium">{selectedTenant.slug}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Tier</p>
                <Badge variant={getTierVariant(selectedTenant.tier)}>{selectedTenant.tier}</Badge>
              </div>
              <div>
                <p className="text-xs text-gray-500">Status</p>
                <Badge variant={getStatusVariant(selectedTenant.status)}>{selectedTenant.status}</Badge>
              </div>
              <div>
                <p className="text-xs text-gray-500">Users</p>
                <p className="font-medium">{selectedTenant.userCount}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Farm</p>
                <p className="font-medium">{selectedTenant.farmCount}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Created</p>
                <p className="font-medium">{formatDate(new Date(selectedTenant.createdAt), 'long')}</p>
              </div>
            </div>

            <div className="flex justify-end space-x-2 pt-4 border-t">
              {selectedTenant.status === TenantStatus.ACTIVE ? (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => handleToggleStatus(selectedTenant, 'suspend')}
                >
                  Suspend
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleToggleStatus(selectedTenant, 'activate')}
                >
                  Activate
                </Button>
              )}
              <Button variant="outline" onClick={() => setIsDetailModalOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Bulk Suspend Modal */}
      <Modal
        isOpen={isBulkSuspendModalOpen}
        onClose={() => setIsBulkSuspendModalOpen(false)}
        title="Bulk Suspend"
      >
        <div className="space-y-4">
          <Alert type="warning">
            {selectedIds.size} tenant(s) will be suspended. This action will block all their users' access.
          </Alert>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Suspension Reason</label>
            <textarea
              className="w-full border rounded-lg p-3 min-h-[100px]"
              value={bulkSuspendReason}
              onChange={(e) => setBulkSuspendReason(e.target.value)}
              placeholder="Enter the reason for suspension..."
            />
          </div>
        </div>
        <div className="flex justify-end space-x-2 mt-6 pt-4 border-t">
          <Button variant="outline" onClick={() => setIsBulkSuspendModalOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={handleBulkSuspend}
            loading={saving}
            disabled={!bulkSuspendReason.trim()}
          >
            Suspend ({selectedIds.size})
          </Button>
        </div>
      </Modal>

      {/* Bulk Activate Confirmation Modal */}
      <Modal
        isOpen={isBulkActivateModalOpen}
        onClose={() => setIsBulkActivateModalOpen(false)}
        title="Confirm Bulk Activation"
      >
        <div className="space-y-4">
          <Alert type="warning">
            You are about to activate {selectedIds.size} tenant(s). This will restore access for any tenants that were suspended for policy violations. Please confirm this is intentional.
          </Alert>
        </div>
        <div className="flex justify-end space-x-2 mt-6 pt-4 border-t">
          <Button variant="outline" onClick={() => setIsBulkActivateModalOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirmBulkActivate}
            loading={saving}
          >
            Activate ({selectedIds.size})
          </Button>
        </div>
      </Modal>

      {/* Individual Suspend Reason Modal */}
      <Modal
        isOpen={isSuspendReasonModalOpen}
        onClose={() => { setIsSuspendReasonModalOpen(false); setTenantToSuspend(null); }}
        title="Suspend Tenant"
      >
        <div className="space-y-4">
          <Alert type="warning">
            Suspending tenant: <strong>{tenantToSuspend?.name}</strong>. Please provide a reason for this action — it will be recorded in the audit log.
          </Alert>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Reason <span className="text-red-500">*</span>
            </label>
            <textarea
              className="w-full border rounded-lg p-3 min-h-[80px]"
              value={suspendReason}
              onChange={(e) => setSuspendReason(e.target.value)}
              placeholder="Enter reason for suspension..."
            />
          </div>
        </div>
        <div className="flex justify-end space-x-2 mt-6 pt-4 border-t">
          <Button variant="outline" onClick={() => { setIsSuspendReasonModalOpen(false); setTenantToSuspend(null); }}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={handleConfirmSuspend}
            disabled={!suspendReason.trim()}
          >
            Suspend Tenant
          </Button>
        </div>
      </Modal>
    </div>
  );
};

export default TenantManagementPage;
