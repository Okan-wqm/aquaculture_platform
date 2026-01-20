/**
 * Tenant Management Page
 * SUPER_ADMIN icin tenant yonetimi
 */

import React, { useState, useEffect, useCallback } from 'react';
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
  total: number;
  active: number;
  suspended: number;
  pending: number;
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
  const [bulkSuspendReason, setBulkSuspendReason] = useState('');

  // Modals
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [selectedTenant, setSelectedTenant] = useState<Tenant | null>(null);

  // Bulk operation state
  const [saving, setSaving] = useState(false);

  // Fetch tenants
  const fetchTenants = useCallback(async () => {
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
      setTenants(result.data);
      setTotalTenants(result.total);
    } catch (err) {
      console.error('Failed to fetch tenants:', err);
      setTenants([]);
      setTotalTenants(0);
      setError('Failed to load tenants. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [searchTerm, statusFilter, tierFilter, page, limit]);

  // Fetch stats
  const fetchInitialData = useCallback(async () => {
    try {
      const statsResult = await tenantsApi.getStats();
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

  // Handle suspend/activate
  const handleToggleStatus = async (tenant: Tenant, action: 'suspend' | 'activate') => {
    try {
      if (action === 'suspend') {
        await tenantsApi.suspend(tenant.id, 'Admin tarafindan askiya alindi');
      } else {
        await tenantsApi.activate(tenant.id);
      }
      fetchTenants();
      fetchInitialData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Islem basarisiz');
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
      setIsBulkSuspendModalOpen(false);
      setBulkSuspendReason('');
      setSelectedIds(new Set());
      fetchTenants();
      fetchInitialData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Toplu askiya alma basarisiz');
    } finally {
      setSaving(false);
    }
  };

  const handleBulkActivate = async () => {
    if (selectedIds.size === 0) return;
    setSaving(true);
    try {
      await tenantsApi.bulkActivate(Array.from(selectedIds));
      setSelectedIds(new Set());
      fetchTenants();
      fetchInitialData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Toplu aktif etme basarisiz');
    } finally {
      setSaving(false);
    }
  };

  const getStatusVariant = (status: TenantStatus | string): 'success' | 'warning' | 'error' | 'default' => {
    const s = String(status).toLowerCase();
    if (s === 'active') return 'success';
    if (s === 'pending') return 'warning';
    if (s === 'suspended') return 'error';
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
          checked={selectedIds.size === tenants.length && tenants.length > 0}
          onChange={toggleSelectAll}
          className="w-4 h-4 rounded border-gray-300"
        />
      ),
      render: (tenant) => (
        <input
          type="checkbox"
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
          <p className="font-medium text-gray-900">{tenant.name}</p>
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
      header: 'Durum',
      sortable: true,
      render: (tenant) => (
        <Badge variant={getStatusVariant(tenant.status)}>{tenant.status}</Badge>
      ),
    },
    {
      key: 'stats',
      header: 'Kullanim',
      render: (tenant) => (
        <div className="text-sm">
          <span className="text-gray-600">{tenant.userCount || 0} kullanici</span>
          <span className="mx-1 text-gray-300">|</span>
          <span className="text-gray-600">{tenant.farmCount || 0} ciftlik</span>
        </div>
      ),
    },
    {
      key: 'lastActivity',
      header: 'Son Aktivite',
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
      header: 'Olusturulma',
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
            onClick={() => navigate(`/admin/tenants/${tenant.id}`)}
          >
            Detay
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
          <h1 className="text-2xl font-bold text-gray-900">Tenant Yonetimi</h1>
          <p className="mt-1 text-sm text-gray-500">
            Toplam {totalTenants} tenant
          </p>
        </div>
        <div className="mt-4 sm:mt-0 flex flex-wrap gap-2">
          {selectedIds.size > 0 && (
            <>
              <Button
                variant="outline"
                onClick={handleBulkActivate}
                disabled={saving}
              >
                Secilenleri Aktif Yap ({selectedIds.size})
              </Button>
              <Button
                variant="danger"
                onClick={() => setIsBulkSuspendModalOpen(true)}
              >
                Secilenleri Askiya Al ({selectedIds.size})
              </Button>
            </>
          )}
          <Button variant="outline" onClick={fetchTenants} disabled={loading}>
            Yenile
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
            <p className="text-sm text-gray-500">Toplam</p>
            <p className="text-2xl font-bold text-gray-900">{stats.total}</p>
          </Card>
          <Card className="p-4">
            <p className="text-sm text-gray-500">Aktif</p>
            <p className="text-2xl font-bold text-green-600">{stats.active}</p>
          </Card>
          <Card className="p-4">
            <p className="text-sm text-gray-500">Beklemede</p>
            <p className="text-2xl font-bold text-yellow-600">{stats.pending}</p>
          </Card>
          <Card className="p-4">
            <p className="text-sm text-gray-500">Askida</p>
            <p className="text-2xl font-bold text-red-600">{stats.suspended}</p>
          </Card>
        </div>
      )}

      {/* Filters */}
      <Card className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <div className="sm:col-span-2">
            <Input
              placeholder="Tenant ara..."
              value={searchTerm}
              onChange={(e) => { setSearchTerm(e.target.value); setPage(1); }}
              leftIcon={
                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              }
            />
          </div>
          <Select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            options={[
              { value: '', label: 'Tum Durumlar' },
              { value: 'active', label: 'Aktif' },
              { value: 'pending', label: 'Beklemede' },
              { value: 'suspended', label: 'Askida' },
            ]}
          />
          <Select
            value={tierFilter}
            onChange={(e) => { setTierFilter(e.target.value); setPage(1); }}
            options={[
              { value: '', label: 'Tum Tier\'lar' },
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
          <p className="mt-2 text-gray-500">Yukleniyor...</p>
        </div>
      ) : (
        <Table
          data={tenants}
          columns={columns}
          keyExtractor={(tenant) => tenant.id}
          emptyMessage="Tenant bulunamadi"
        />
      )}

      {/* Pagination */}
      {totalTenants > limit && (
        <div className="flex justify-center space-x-2">
          <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>
            Onceki
          </Button>
          <span className="py-2 px-4 text-sm text-gray-600">
            Sayfa {page} / {Math.ceil(totalTenants / limit)}
          </span>
          <Button variant="outline" size="sm" disabled={page >= Math.ceil(totalTenants / limit)} onClick={() => setPage(page + 1)}>
            Sonraki
          </Button>
        </div>
      )}

      {/* Detail Modal */}
      <Modal
        isOpen={isDetailModalOpen}
        onClose={() => setIsDetailModalOpen(false)}
        title={selectedTenant?.name || 'Tenant Detayi'}
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
                <p className="text-xs text-gray-500">Durum</p>
                <Badge variant={getStatusVariant(selectedTenant.status)}>{selectedTenant.status}</Badge>
              </div>
              <div>
                <p className="text-xs text-gray-500">Kullanici</p>
                <p className="font-medium">{selectedTenant.userCount}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Farm</p>
                <p className="font-medium">{selectedTenant.farmCount}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Olusturulma</p>
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
                  Askiya Al
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleToggleStatus(selectedTenant, 'activate')}
                >
                  Aktif Yap
                </Button>
              )}
              <Button variant="outline" onClick={() => setIsDetailModalOpen(false)}>
                Kapat
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Bulk Suspend Modal */}
      <Modal
        isOpen={isBulkSuspendModalOpen}
        onClose={() => setIsBulkSuspendModalOpen(false)}
        title="Toplu Askiya Alma"
      >
        <div className="space-y-4">
          <Alert type="warning">
            {selectedIds.size} tenant askiya alinacak. Bu islem tum kullanilarinin erisimini engelleyecektir.
          </Alert>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Askiya Alma Sebebi</label>
            <textarea
              className="w-full border rounded-lg p-3 min-h-[100px]"
              value={bulkSuspendReason}
              onChange={(e) => setBulkSuspendReason(e.target.value)}
              placeholder="Askiya alma sebebini girin..."
            />
          </div>
        </div>
        <div className="flex justify-end space-x-2 mt-6 pt-4 border-t">
          <Button variant="outline" onClick={() => setIsBulkSuspendModalOpen(false)}>
            Iptal
          </Button>
          <Button
            variant="danger"
            onClick={handleBulkSuspend}
            loading={saving}
            disabled={!bulkSuspendReason.trim()}
          >
            Askiya Al ({selectedIds.size})
          </Button>
        </div>
      </Modal>
    </div>
  );
};

export default TenantManagementPage;
