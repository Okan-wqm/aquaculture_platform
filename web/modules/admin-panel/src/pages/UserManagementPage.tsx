/**
 * User Management Page
 * Tum kullanicilari yonetme - SUPER_ADMIN icin
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Card,
  Button,
  Input,
  Select,
  Badge,
  Table,
  Modal,
  ConfirmModal,
  Alert,
  formatDate,
} from '@aquaculture/shared-ui';
import type { TableColumn } from '@aquaculture/shared-ui';
import {
  usersApi,
  tenantsApi,
  TenantTier,
  TenantStatus,
  type User,
  type UserStats,
  type PaginatedResult,
  type Tenant,
  type RoleTemplate,
  type UserLimitCheckResult,
} from '../services/adminApi';

// ============================================================================
// User Management Page
// ============================================================================

const UserManagementPage: React.FC = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [stats, setStats] = useState<UserStats | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalUsers, setTotalUsers] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(20);

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [tenantFilter, setTenantFilter] = useState('');

  // Modals
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);

  // Role templates for invitation
  const [roleTemplates, setRoleTemplates] = useState<RoleTemplate[]>([]);
  const [userLimitCheck, setUserLimitCheck] = useState<UserLimitCheckResult | null>(null);

  // Form state
  const [formData, setFormData] = useState({
    email: '',
    firstName: '',
    lastName: '',
    password: '',
    role: 'MODULE_USER',
    tenantId: '',
    isActive: true,
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Invite form state
  const [inviteFormData, setInviteFormData] = useState({
    email: '',
    firstName: '',
    lastName: '',
    role: 'MODULE_USER',
    tenantId: '',
    message: '',
  });
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  // Fetch users
  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await usersApi.list({
        search: searchTerm || undefined,
        role: roleFilter || undefined,
        status: statusFilter || undefined,
        tenantId: tenantFilter || undefined,
        page,
        limit,
      });
      setUsers(result.data);
      setTotalUsers(result.total);
    } catch (err) {
      console.error('Failed to load users:', err);
      setError(err instanceof Error ? err.message : 'Failed to load users');
      setUsers([]);
      setTotalUsers(0);
    } finally {
      setLoading(false);
    }
  }, [searchTerm, roleFilter, statusFilter, tenantFilter, page, limit]);

  // Fetch stats and tenants
  const fetchInitialData = useCallback(async () => {
    try {
      const [statsResult, tenantsResult, rolesResult] = await Promise.allSettled([
        usersApi.getStats(),
        tenantsApi.list({ limit: 100 }),
        usersApi.getRoleTemplates(),
      ]);
      if (statsResult.status === 'fulfilled') setStats(statsResult.value);
      else setStats(null);
      if (tenantsResult.status === 'fulfilled') setTenants(tenantsResult.value.data);
      else setTenants([]);
      if (rolesResult.status === 'fulfilled') setRoleTemplates(rolesResult.value);
      else setRoleTemplates([]);
    } catch (err) {
      console.error('Failed to fetch initial data:', err);
      setStats(null);
      setTenants([]);
      setRoleTemplates([]);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  useEffect(() => {
    fetchInitialData();
  }, [fetchInitialData]);

  // Handle create/update user
  const handleSaveUser = async () => {
    setFormError(null);
    setSaving(true);

    try {
      if (selectedUser) {
        // Update
        await usersApi.update(selectedUser.id, {
          firstName: formData.firstName,
          lastName: formData.lastName,
          role: formData.role,
          tenantId: formData.tenantId || undefined,
          isActive: formData.isActive,
        });
      } else {
        // Create
        if (!formData.password) {
          setFormError('Sifre zorunludur');
          setSaving(false);
          return;
        }
        await usersApi.create({
          email: formData.email,
          firstName: formData.firstName,
          lastName: formData.lastName,
          password: formData.password,
          role: formData.role,
          tenantId: formData.tenantId || undefined,
        });
      }
      setIsModalOpen(false);
      fetchUsers();
      fetchInitialData();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Islem basarisiz');
    } finally {
      setSaving(false);
    }
  };

  // Handle delete user
  const handleDeleteUser = async () => {
    if (!selectedUser) return;
    try {
      await usersApi.delete(selectedUser.id);
      setDeleteModalOpen(false);
      setSelectedUser(null);
      fetchUsers();
      fetchInitialData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Silme basarisiz');
    }
  };

  // Handle activate/deactivate
  const handleToggleStatus = async (user: User) => {
    try {
      if (user.isActive) {
        await usersApi.deactivate(user.id);
      } else {
        await usersApi.activate(user.id);
      }
      fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Islem basarisiz');
    }
  };

  // Handle force logout
  const handleForceLogout = async (user: User) => {
    try {
      await usersApi.forceLogout(user.id);
      alert('Kullanici tum oturumlardan cikarildi');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Islem basarisiz');
    }
  };

  // Handle invite user
  const handleInviteUser = async () => {
    setInviteError(null);
    setInviteSuccess(null);
    setInviting(true);

    try {
      if (!inviteFormData.email) {
        setInviteError('E-posta adresi zorunludur');
        setInviting(false);
        return;
      }

      if (!inviteFormData.tenantId) {
        setInviteError('Tenant secimi zorunludur');
        setInviting(false);
        return;
      }

      // Check user limit before inviting
      const limitCheck = await usersApi.checkTenantLimit(inviteFormData.tenantId);
      if (!limitCheck.canCreate) {
        setInviteError(limitCheck.message || 'Kullanici limiti doldu');
        setInviting(false);
        return;
      }

      const result = await usersApi.invite({
        tenantId: inviteFormData.tenantId,
        email: inviteFormData.email,
        firstName: inviteFormData.firstName || undefined,
        lastName: inviteFormData.lastName || undefined,
        role: inviteFormData.role,
        message: inviteFormData.message || undefined,
        invitedBy: 'system', // In real app, get from auth context
      });

      setInviteSuccess(`Davet gonderildi: ${inviteFormData.email}`);

      // Reset form
      setInviteFormData({
        email: '',
        firstName: '',
        lastName: '',
        role: 'MODULE_USER',
        tenantId: '',
        message: '',
      });

      fetchUsers();
      fetchInitialData();

      // Close modal after success
      setTimeout(() => {
        setIsInviteModalOpen(false);
        setInviteSuccess(null);
      }, 2000);
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Davet gonderilemedi');
    } finally {
      setInviting(false);
    }
  };

  // Open invite modal
  const openInviteModal = async () => {
    setInviteError(null);
    setInviteSuccess(null);
    setInviteFormData({
      email: '',
      firstName: '',
      lastName: '',
      role: 'MODULE_USER',
      tenantId: '',
      message: '',
    });
    setIsInviteModalOpen(true);
  };

  // Check user limit when tenant changes in invite form
  const handleInviteTenantChange = async (tenantId: string) => {
    setInviteFormData({ ...inviteFormData, tenantId });
    if (tenantId) {
      try {
        const limitCheck = await usersApi.checkTenantLimit(tenantId);
        setUserLimitCheck(limitCheck);
      } catch (err) {
        console.error('Failed to check user limit:', err);
        setUserLimitCheck(null);
      }
    } else {
      setUserLimitCheck(null);
    }
  };

  // Open edit modal
  const openEditModal = (user: User | null) => {
    setSelectedUser(user);
    setFormData({
      email: user?.email || '',
      firstName: user?.firstName || '',
      lastName: user?.lastName || '',
      password: '',
      role: user?.role || 'MODULE_USER',
      tenantId: user?.tenantId || '',
      isActive: user?.isActive ?? true,
    });
    setFormError(null);
    setIsModalOpen(true);
  };

  // Role labels
  const getRoleLabel = (role: string) => {
    const labels: Record<string, string> = {
      SUPER_ADMIN: 'Super Admin',
      TENANT_ADMIN: 'Tenant Admin',
      MODULE_MANAGER: 'Modul Yoneticisi',
      MODULE_USER: 'Kullanici',
    };
    return labels[role] || role;
  };

  const getRoleVariant = (role: string) => {
    const variants: Record<string, 'error' | 'warning' | 'info' | 'success' | 'default'> = {
      SUPER_ADMIN: 'error',
      TENANT_ADMIN: 'warning',
      MODULE_MANAGER: 'info',
      MODULE_USER: 'default',
    };
    return variants[role] || 'default';
  };

  const columns: TableColumn<User>[] = [
    {
      key: 'name',
      header: 'Kullanici',
      sortable: true,
      render: (user) => (
        <div>
          <p className="font-medium text-gray-900">{`${user.firstName} ${user.lastName}`}</p>
          <p className="text-sm text-gray-500">{user.email}</p>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Rol',
      sortable: true,
      render: (user) => (
        <Badge variant={getRoleVariant(user.role)}>{getRoleLabel(user.role)}</Badge>
      ),
    },
    {
      key: 'tenantName',
      header: 'Tenant',
      sortable: true,
      render: (user) => (
        <span className="text-sm text-gray-600">{user.tenantName || '-'}</span>
      ),
    },
    {
      key: 'isActive',
      header: 'Durum',
      sortable: true,
      render: (user) => (
        <Badge variant={user.isActive ? 'success' : 'default'}>
          {user.isActive ? 'Aktif' : 'Pasif'}
        </Badge>
      ),
    },
    {
      key: 'lastLoginAt',
      header: 'Son Giris',
      sortable: true,
      render: (user) => (
        <span className="text-sm text-gray-500">
          {user.lastLoginAt ? formatDate(new Date(user.lastLoginAt), 'short') : 'Hic giris yapmadi'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (user) => (
        <div className="flex items-center justify-end space-x-1">
          <Button variant="ghost" size="sm" onClick={() => { setSelectedUser(user); setIsDetailModalOpen(true); }}>
            Detay
          </Button>
          <Button variant="ghost" size="sm" onClick={() => openEditModal(user)}>
            Duzenle
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { setSelectedUser(user); setDeleteModalOpen(true); }}>
            <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
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
          <h1 className="text-2xl font-bold text-gray-900">Kullanici Yonetimi</h1>
          <p className="mt-1 text-sm text-gray-500">
            Toplam {totalUsers} kullanici
          </p>
        </div>
        <div className="mt-4 sm:mt-0 flex space-x-2">
          <Button variant="outline" onClick={fetchUsers} disabled={loading}>
            Yenile
          </Button>
          <Button variant="outline" onClick={openInviteModal}>
            <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            Davet Gonder
          </Button>
          <Button onClick={() => openEditModal(null)}>
            <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Yeni Kullanici
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
            <p className="text-2xl font-bold text-gray-900">{stats.totalUsers}</p>
          </Card>
          <Card className="p-4">
            <p className="text-sm text-gray-500">Aktif</p>
            <p className="text-2xl font-bold text-green-600">{stats.activeUsers}</p>
          </Card>
          <Card className="p-4">
            <p className="text-sm text-gray-500">Son 24 Saat Giris</p>
            <p className="text-2xl font-bold text-blue-600">{stats.loginsLast24Hours}</p>
          </Card>
          <Card className="p-4">
            <p className="text-sm text-gray-500">Son 30 Gun Yeni</p>
            <p className="text-2xl font-bold text-purple-600">{stats.newUsersLast30Days}</p>
          </Card>
        </div>
      )}

      {/* Filters */}
      <Card className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-5 gap-4">
          <div className="sm:col-span-2">
            <Input
              placeholder="Isim veya e-posta ara..."
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
            value={roleFilter}
            onChange={(e) => { setRoleFilter(e.target.value); setPage(1); }}
            options={[
              { value: '', label: 'Tum Roller' },
              { value: 'SUPER_ADMIN', label: 'Super Admin' },
              { value: 'TENANT_ADMIN', label: 'Tenant Admin' },
              { value: 'MODULE_MANAGER', label: 'Modul Yoneticisi' },
              { value: 'MODULE_USER', label: 'Kullanici' },
            ]}
          />
          <Select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            options={[
              { value: '', label: 'Tum Durumlar' },
              { value: 'active', label: 'Aktif' },
              { value: 'inactive', label: 'Pasif' },
            ]}
          />
          <Select
            value={tenantFilter}
            onChange={(e) => { setTenantFilter(e.target.value); setPage(1); }}
            options={[
              { value: '', label: 'Tum Tenantlar' },
              ...tenants.map((t) => ({ value: t.id, label: t.name })),
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
          data={users}
          columns={columns}
          keyExtractor={(user) => user.id}
          emptyMessage="Kullanici bulunamadi"
        />
      )}

      {/* Pagination */}
      {totalUsers > limit && (
        <div className="flex justify-center space-x-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
          >
            Onceki
          </Button>
          <span className="py-2 px-4 text-sm text-gray-600">
            Sayfa {page} / {Math.ceil(totalUsers / limit)}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= Math.ceil(totalUsers / limit)}
            onClick={() => setPage(page + 1)}
          >
            Sonraki
          </Button>
        </div>
      )}

      {/* Create/Edit Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={selectedUser ? 'Kullaniciyi Duzenle' : 'Yeni Kullanici'}
        size="md"
      >
        <div className="space-y-4">
          {formError && <Alert type="error">{formError}</Alert>}

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Ad"
              value={formData.firstName}
              onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
              required
            />
            <Input
              label="Soyad"
              value={formData.lastName}
              onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
              required
            />
          </div>

          <Input
            label="E-posta"
            type="email"
            value={formData.email}
            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
            disabled={!!selectedUser}
            required
          />

          {!selectedUser && (
            <Input
              label="Sifre"
              type="password"
              value={formData.password}
              onChange={(e) => setFormData({ ...formData, password: e.target.value })}
              required
            />
          )}

          <Select
            label="Rol"
            value={formData.role}
            onChange={(e) => setFormData({ ...formData, role: e.target.value })}
            options={[
              { value: 'SUPER_ADMIN', label: 'Super Admin' },
              { value: 'TENANT_ADMIN', label: 'Tenant Admin' },
              { value: 'MODULE_MANAGER', label: 'Modul Yoneticisi' },
              { value: 'MODULE_USER', label: 'Kullanici' },
            ]}
          />

          <Select
            label="Tenant"
            value={formData.tenantId}
            onChange={(e) => setFormData({ ...formData, tenantId: e.target.value })}
            options={[
              { value: '', label: 'Tenant Yok (Super Admin)' },
              ...tenants.map((t) => ({ value: t.id, label: t.name })),
            ]}
          />

          {selectedUser && (
            <div className="flex items-center space-x-2">
              <input
                type="checkbox"
                id="isActive"
                checked={formData.isActive}
                onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
                className="rounded border-gray-300"
              />
              <label htmlFor="isActive" className="text-sm text-gray-700">Aktif</label>
            </div>
          )}

          <div className="flex justify-end space-x-3 pt-4">
            <Button variant="outline" onClick={() => setIsModalOpen(false)}>
              Iptal
            </Button>
            <Button onClick={handleSaveUser} loading={saving}>
              {selectedUser ? 'Guncelle' : 'Olustur'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Detail Modal */}
      <Modal
        isOpen={isDetailModalOpen}
        onClose={() => setIsDetailModalOpen(false)}
        title="Kullanici Detayi"
        size="md"
      >
        {selectedUser && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-gray-500">Ad Soyad</p>
                <p className="font-medium">{selectedUser.firstName} {selectedUser.lastName}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">E-posta</p>
                <p className="font-medium">{selectedUser.email}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Rol</p>
                <Badge variant={getRoleVariant(selectedUser.role)}>{getRoleLabel(selectedUser.role)}</Badge>
              </div>
              <div>
                <p className="text-xs text-gray-500">Durum</p>
                <Badge variant={selectedUser.isActive ? 'success' : 'default'}>
                  {selectedUser.isActive ? 'Aktif' : 'Pasif'}
                </Badge>
              </div>
              <div>
                <p className="text-xs text-gray-500">Tenant</p>
                <p className="font-medium">{selectedUser.tenantName || '-'}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Son Giris</p>
                <p className="font-medium">
                  {selectedUser.lastLoginAt
                    ? formatDate(new Date(selectedUser.lastLoginAt), 'long')
                    : 'Hic giris yapmadi'}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Olusturulma</p>
                <p className="font-medium">{formatDate(new Date(selectedUser.createdAt), 'long')}</p>
              </div>
            </div>

            <div className="flex justify-end space-x-2 pt-4 border-t">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleToggleStatus(selectedUser)}
              >
                {selectedUser.isActive ? 'Pasif Yap' : 'Aktif Yap'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleForceLogout(selectedUser)}
              >
                Zorla Cikis Yaptir
              </Button>
              <Button variant="outline" onClick={() => setIsDetailModalOpen(false)}>
                Kapat
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Delete Confirm Modal */}
      <ConfirmModal
        isOpen={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        onConfirm={handleDeleteUser}
        title="Kullaniciyi Sil"
        message={`"${selectedUser?.email}" kullanicisini silmek istediginizden emin misiniz?`}
        confirmText="Sil"
        confirmVariant="danger"
      />

      {/* Invite User Modal */}
      <Modal
        isOpen={isInviteModalOpen}
        onClose={() => setIsInviteModalOpen(false)}
        title="Kullanici Davet Et"
        size="md"
      >
        <div className="space-y-4">
          {inviteError && <Alert type="error">{inviteError}</Alert>}
          {inviteSuccess && <Alert type="success">{inviteSuccess}</Alert>}

          <Select
            label="Tenant *"
            value={inviteFormData.tenantId}
            onChange={(e) => handleInviteTenantChange(e.target.value)}
            options={[
              { value: '', label: 'Tenant Secin' },
              ...tenants.map((t) => ({ value: t.id, label: t.name })),
            ]}
          />

          {/* User Limit Warning */}
          {userLimitCheck && (
            <div
              className={`p-3 rounded-lg text-sm ${
                userLimitCheck.canCreate
                  ? 'bg-green-50 text-green-700'
                  : 'bg-red-50 text-red-700'
              }`}
            >
              <div className="flex items-center justify-between">
                <span>{userLimitCheck.message}</span>
                {userLimitCheck.limit !== -1 && (
                  <span className="font-medium">
                    {userLimitCheck.currentCount} / {userLimitCheck.limit}
                  </span>
                )}
              </div>
              {userLimitCheck.limit !== -1 && (
                <div className="mt-2 bg-gray-200 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full ${
                      userLimitCheck.canCreate ? 'bg-green-500' : 'bg-red-500'
                    }`}
                    style={{
                      width: `${Math.min(100, (userLimitCheck.currentCount / userLimitCheck.limit) * 100)}%`,
                    }}
                  ></div>
                </div>
              )}
            </div>
          )}

          <Input
            label="E-posta *"
            type="email"
            value={inviteFormData.email}
            onChange={(e) =>
              setInviteFormData({ ...inviteFormData, email: e.target.value })
            }
            placeholder="ornek@sirket.com"
            required
          />

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Ad"
              value={inviteFormData.firstName}
              onChange={(e) =>
                setInviteFormData({ ...inviteFormData, firstName: e.target.value })
              }
            />
            <Input
              label="Soyad"
              value={inviteFormData.lastName}
              onChange={(e) =>
                setInviteFormData({ ...inviteFormData, lastName: e.target.value })
              }
            />
          </div>

          <Select
            label="Rol *"
            value={inviteFormData.role}
            onChange={(e) =>
              setInviteFormData({ ...inviteFormData, role: e.target.value })
            }
            options={
              roleTemplates.length > 0
                ? roleTemplates
                    .filter((r) => r.code !== 'SUPER_ADMIN') // Don't allow SUPER_ADMIN invitation
                    .map((r) => ({
                      value: r.code,
                      label: `${r.name} (Level ${r.level})`,
                    }))
                : [
                    { value: 'TENANT_ADMIN', label: 'Tenant Admin' },
                    { value: 'MODULE_MANAGER', label: 'Modul Yoneticisi' },
                    { value: 'MODULE_USER', label: 'Kullanici' },
                  ]
            }
          />

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Mesaj (Opsiyonel)
            </label>
            <textarea
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              rows={3}
              value={inviteFormData.message}
              onChange={(e) =>
                setInviteFormData({ ...inviteFormData, message: e.target.value })
              }
              placeholder="Davet mesaji..."
            />
          </div>

          <div className="bg-blue-50 rounded-lg p-3 text-sm text-blue-700">
            <strong>Bilgi:</strong> Davet edilen kullaniciya e-posta gonderilecek.
            Kullanici davet linkine tiklayarak sifresi olusturacak.
          </div>

          <div className="flex justify-end space-x-3 pt-4">
            <Button variant="outline" onClick={() => setIsInviteModalOpen(false)}>
              Iptal
            </Button>
            <Button
              onClick={handleInviteUser}
              loading={inviting}
              disabled={!userLimitCheck?.canCreate && !!inviteFormData.tenantId}
            >
              Davet Gonder
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default UserManagementPage;
