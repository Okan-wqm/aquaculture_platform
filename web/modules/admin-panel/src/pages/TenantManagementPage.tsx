/**
 * Tenant Management Page
 * SUPER_ADMIN icin tenant yonetimi
 */

import React, { useEffect, useState } from 'react';
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
import {
  tenantsApi,
  type Tenant,
  type TenantStats,
  TenantTier,
  TenantStatus,
} from '../services/adminApi';
import { expectedTotalPages } from '@platform/pagination-contracts';
import { adminKeys, useAdminMutation, useAdminQuery } from '../hooks';
import { QueryFailureNotice } from '../components/QueryFailureNotice';

// ============================================================================
// Tenant Management Page
// ============================================================================

const PAGE_SIZE = 20;

const TenantManagementPage: React.FC = () => {
  const navigate = useNavigate();

  const [page, setPage] = useState(1);

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

  // ==========================================================================
  // Reads (ADMIN-HIGH-121)
  // ==========================================================================

  const listFilters = {
    search: searchTerm || undefined,
    status: statusFilter || undefined,
    tier: tierFilter || undefined,
    page,
    limit: PAGE_SIZE,
  };

  // The filters are IN the key, so React Query keeps one entry per filter
  // combination and cancels the request for a combination the operator has
  // already moved off. The page used to do that itself with a
  // `tenantRequestSeq` ref counter compared inside every `then`/`catch` — a
  // hand-rolled race guard for exactly the problem the `signal` solves.
  const tenantsQuery = useAdminQuery(adminKeys.tenants.list(listFilters), ({ signal }) =>
    tenantsApi.list(listFilters, signal),
  );

  // The four cards were cached in a `useRef` under a two-minute TTL and
  // invalidated by hand — `statsCacheRef.current = null` repeated in FIVE write
  // handlers. A sixth write would have forgotten, and the cards would have
  // shown the tenant estate as it was up to two minutes before the operator
  // suspended someone. `invalidateKeys` makes the refresh part of the write.
  const statsQuery = useAdminQuery(adminKeys.tenants.stats(), ({ signal }) =>
    tenantsApi.getStats(signal),
  );

  const tenants = tenantsQuery.data?.data ?? [];
  const matchingTenants = tenantsQuery.data?.total ?? 0;
  const stats = statsQuery.data;

  const reload = (): void => {
    void tenantsQuery.refetch();
    void statsQuery.refetch();
  };

  // ==========================================================================
  // Writes (ADMIN-HIGH-121)
  // ==========================================================================

  // Every tenant write moves a row between statuses, so each one invalidates
  // BOTH the list it appears in and the counts above it. That pairing lives
  // here, once, instead of in each handler's tail.
  const tenantWriteKeys = [adminKeys.tenants.all()];

  const activateTenant = useAdminMutation<Tenant, { id: string }>(
    ({ id }) => tenantsApi.activate(id),
    { invalidateKeys: tenantWriteKeys },
  );

  const suspendTenant = useAdminMutation<Tenant, { id: string; reason: string }>(
    ({ id, reason }) => tenantsApi.suspend(id, reason),
    { invalidateKeys: tenantWriteKeys },
  );

  const bulkSuspend = useAdminMutation<
    { success: string[]; failed: string[] },
    { ids: string[]; reason: string }
  >(({ ids, reason }) => tenantsApi.bulkSuspend(ids, reason), {
    invalidateKeys: tenantWriteKeys,
  });

  const bulkActivate = useAdminMutation<{ success: string[]; failed: string[] }, { ids: string[] }>(
    ({ ids }) => tenantsApi.bulkActivate(ids),
    { invalidateKeys: tenantWriteKeys },
  );

  const saving = bulkSuspend.isPending || bulkActivate.isPending;

  const queryErrors = [
    tenantsQuery.error,
    statsQuery.error,
    activateTenant.error,
    suspendTenant.error,
    bulkSuspend.error,
    bulkActivate.error,
  ];

  // A bulk endpoint answers 200 with the ids it could NOT change. Reporting
  // only the transport failure would leave an operator believing every
  // selected tenant was suspended when some were refused.
  const bulkRejections = [
    ...(bulkSuspend.data?.failed ?? []),
    ...(bulkActivate.data?.failed ?? []),
  ];

  useEffect(() => {
    setSelectedIds(new Set());
  }, [searchTerm, statusFilter, tierFilter, page]);

  // Handle suspend/activate
  const handleToggleStatus = (tenant: Tenant, action: 'suspend' | 'activate'): void => {
    if (action === 'suspend') {
      // Require operator to provide a reason — open reason modal
      setTenantToSuspend(tenant);
      setSuspendReason('');
      setIsSuspendReasonModalOpen(true);
      return;
    }
    activateTenant.mutate({ id: tenant.id });
  };

  const handleConfirmSuspend = (): void => {
    if (!tenantToSuspend || !suspendReason.trim()) return;
    suspendTenant.mutate(
      { id: tenantToSuspend.id, reason: suspendReason.trim() },
      {
        onSuccess: () => {
          setIsSuspendReasonModalOpen(false);
          setTenantToSuspend(null);
          setSuspendReason('');
        },
      },
    );
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

  const handleBulkSuspend = (): void => {
    if (selectedIds.size === 0 || !bulkSuspendReason.trim()) return;
    bulkSuspend.mutate(
      { ids: Array.from(selectedIds), reason: bulkSuspendReason },
      {
        onSuccess: () => {
          setIsBulkSuspendModalOpen(false);
          setBulkSuspendReason('');
          setSelectedIds(new Set());
        },
      },
    );
  };

  const handleBulkActivate = () => {
    if (selectedIds.size === 0) return;
    setIsBulkActivateModalOpen(true);
  };

  const handleConfirmBulkActivate = (): void => {
    bulkActivate.mutate(
      { ids: Array.from(selectedIds) },
      {
        onSuccess: () => {
          setIsBulkActivateModalOpen(false);
          setSelectedIds(new Set());
        },
      },
    );
  };

  const getStatusVariant = (
    status: TenantStatus | string,
  ): 'success' | 'warning' | 'error' | 'default' => {
    const s = String(status).toLowerCase();
    if (s === 'active') return 'success';
    if (s === 'pending' || s === 'provisioning') return 'warning';
    if (s === 'suspended' || s === 'provisioning_failed') return 'error';
    return 'default';
  };

  const getTierVariant = (
    tier: TenantTier | string,
  ): 'success' | 'warning' | 'info' | 'default' => {
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
            {tenant.isTrialActive && <Badge variant="warning">Trial</Badge>}
          </div>
          <p className="text-sm text-gray-500">{tenant.slug}</p>
        </div>
      ),
    },
    {
      key: 'tier',
      header: 'Tier',
      sortable: true,
      render: (tenant) => <Badge variant={getTierVariant(tenant.tier)}>{tenant.tier}</Badge>,
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (tenant) => <Badge variant={getStatusVariant(tenant.status)}>{tenant.status}</Badge>,
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
          <Button variant="ghost" size="sm" onClick={() => navigate(`/admin/tenants/${tenant.id}`)}>
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
          {/* The FILTERED result total, so it is labelled as one. It sat here
              as "Total N tenants" beside a "Total" card holding the platform
              figure, and with a status filter applied the two disagreed by
              design while both claimed to be the total. */}
          <p className="mt-1 text-sm text-gray-500">
            {matchingTenants.toLocaleString()} tenant
            {matchingTenants === 1 ? '' : 's'} match
          </p>
        </div>
        <div className="mt-4 sm:mt-0 flex flex-wrap gap-2">
          {selectedIds.size > 0 && (
            <>
              {tenants
                .filter((tenant) => selectedIds.has(tenant.id))
                .every((tenant) => tenant.status === TenantStatus.SUSPENDED) && (
                <Button variant="outline" onClick={handleBulkActivate} disabled={saving}>
                  Activate Selected ({selectedIds.size})
                </Button>
              )}
              {tenants
                .filter((tenant) => selectedIds.has(tenant.id))
                .every((tenant) => tenant.status === TenantStatus.ACTIVE) && (
                <Button variant="danger" onClick={() => setIsBulkSuspendModalOpen(true)}>
                  Suspend Selected ({selectedIds.size})
                </Button>
              )}
            </>
          )}
          <Button variant="outline" onClick={reload} disabled={tenantsQuery.isFetching}>
            Refresh
          </Button>
        </div>
      </div>

      <QueryFailureNotice errors={queryErrors} hasContent={tenants.length > 0} onRetry={reload} />

      {bulkRejections.length > 0 && (
        <Alert type="warning">
          The server refused {bulkRejections.length} of the selected tenants:{' '}
          {bulkRejections.join(', ')}
        </Alert>
      )}

      {/* Platform-wide counts from the server's aggregate — an em dash when it
          has not loaded, never a zero, and never the filtered page's own
          arithmetic. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card className="p-4">
          <p className="text-sm text-gray-500">Total</p>
          <p className="text-2xl font-bold text-gray-900">
            {stats ? stats.totalTenants.toLocaleString() : '—'}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-gray-500">Active</p>
          <p className="text-2xl font-bold text-green-600">
            {stats ? stats.activeTenants.toLocaleString() : '—'}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-gray-500">Pending</p>
          <p className="text-2xl font-bold text-yellow-600">
            {stats ? stats.pendingTenants.toLocaleString() : '—'}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-gray-500">Suspended</p>
          <p className="text-2xl font-bold text-red-600">
            {stats ? stats.suspendedTenants.toLocaleString() : '—'}
          </p>
        </Card>
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <div className="sm:col-span-2">
            <Input
              placeholder="Search tenants..."
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setPage(1);
              }}
              leftIcon={
                <svg
                  className="w-5 h-5 text-gray-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
              }
            />
          </div>
          <Select
            aria-label="Status"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
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
            aria-label="Tier"
            value={tierFilter}
            onChange={(e) => {
              setTierFilter(e.target.value);
              setPage(1);
            }}
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
      {tenantsQuery.isPending ? (
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
      {matchingTenants > PAGE_SIZE && (
        <div className="flex justify-center space-x-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </Button>
          <span className="py-2 px-4 text-sm text-gray-600">
            Page {page} / {expectedTotalPages(matchingTenants, PAGE_SIZE)}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= expectedTotalPages(matchingTenants, PAGE_SIZE)}
            onClick={() => setPage(page + 1)}
          >
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
                <Badge variant={getStatusVariant(selectedTenant.status)}>
                  {selectedTenant.status}
                </Badge>
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
                <p className="font-medium">
                  {formatDate(new Date(selectedTenant.createdAt), 'long')}
                </p>
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
            {selectedIds.size} tenant(s) will be suspended. This action will block all their users'
            access.
          </Alert>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Suspension Reason
            </label>
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
            You are about to activate {selectedIds.size} tenant(s). This will restore access for any
            tenants that were suspended for policy violations. Please confirm this is intentional.
          </Alert>
        </div>
        <div className="flex justify-end space-x-2 mt-6 pt-4 border-t">
          <Button variant="outline" onClick={() => setIsBulkActivateModalOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleConfirmBulkActivate} loading={saving}>
            Activate ({selectedIds.size})
          </Button>
        </div>
      </Modal>

      {/* Individual Suspend Reason Modal */}
      <Modal
        isOpen={isSuspendReasonModalOpen}
        onClose={() => {
          setIsSuspendReasonModalOpen(false);
          setTenantToSuspend(null);
        }}
        title="Suspend Tenant"
      >
        <div className="space-y-4">
          <Alert type="warning">
            Suspending tenant: <strong>{tenantToSuspend?.name}</strong>. Please provide a reason for
            this action — it will be recorded in the audit log.
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
          <Button
            variant="outline"
            onClick={() => {
              setIsSuspendReasonModalOpen(false);
              setTenantToSuspend(null);
            }}
          >
            Cancel
          </Button>
          <Button variant="danger" onClick={handleConfirmSuspend} disabled={!suspendReason.trim()}>
            Suspend Tenant
          </Button>
        </div>
      </Modal>
    </div>
  );
};

export default TenantManagementPage;
