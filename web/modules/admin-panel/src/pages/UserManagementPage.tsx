/**
 * User Management Page
 * Tum kullanicilari yonetme - SUPER_ADMIN icin
 */

import React, { useEffect, useState } from 'react';
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
import { expectedTotalPages } from '@platform/pagination-contracts';
import { adminKeys, useAdminMutation, useAdminQuery } from '../hooks';
import { QueryFailureNotice } from '../components/QueryFailureNotice';
import { isPlatformRole, type PlatformRole } from '../services/types/users';

const PAGE_SIZE = 20;
const TENANT_OPTION_LIMIT = 100;

/**
 * The role a new user or invitation starts at. Typed, so a role the server
 * would reject cannot be the default (ADMIN-CRITICAL-133).
 */
const DEFAULT_ROLE: PlatformRole = 'MODULE_USER';

// ============================================================================
// User Management Page
// ============================================================================

const UserManagementPage: React.FC = () => {
  const [page, setPage] = useState(1);

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

  // Form
  const [formData, setFormData] = useState<{
    email: string;
    firstName: string;
    lastName: string;
    password: string;
    role: PlatformRole;
    tenantId: string;
    isActive: boolean;
  }>({
    email: '',
    firstName: '',
    lastName: '',
    password: '',
    role: DEFAULT_ROLE,
    tenantId: '',
    isActive: true,
  });
  const [formError, setFormError] = useState<string | null>(null);

  // Invite form
  const [inviteFormData, setInviteFormData] = useState<{
    email: string;
    firstName: string;
    lastName: string;
    role: PlatformRole;
    tenantId: string;
    message: string;
  }>({
    email: '',
    firstName: '',
    lastName: '',
    role: DEFAULT_ROLE,
    tenantId: '',
    message: '',
  });
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // ==========================================================================
  // Reads (ADMIN-HIGH-121)
  // ==========================================================================

  const listFilters = {
    search: searchTerm || undefined,
    role: roleFilter || undefined,
    status: statusFilter || undefined,
    tenantId: tenantFilter || undefined,
    page,
    limit: PAGE_SIZE,
  };

  const usersQuery = useAdminQuery(adminKeys.users.list(listFilters), ({ signal }) =>
    usersApi.list(listFilters, signal),
  );

  const statsQuery = useAdminQuery(adminKeys.users.stats(), ({ signal }) =>
    usersApi.getStats(signal),
  );

  const rolesQuery = useAdminQuery(adminKeys.users.roleTemplates(), ({ signal }) =>
    usersApi.getRoleTemplates(signal),
  );

  // The tenant options behind the filter and both forms. This lived in a
  // `useRef` under a five-minute TTL — a cache outside the shell's
  // `QueryClient`, so `logoutCleanup()` could not reach it and no tenant write
  // could invalidate it. Keyed the same way TenantManagementPage keys its list,
  // so the two pages share one entry instead of each fetching a hundred rows.
  const tenantOptionFilters = { limit: TENANT_OPTION_LIMIT };

  const tenantsQuery = useAdminQuery(adminKeys.tenants.list(tenantOptionFilters), ({ signal }) =>
    tenantsApi.list(tenantOptionFilters, signal),
  );

  const users = usersQuery.data?.data ?? [];
  const matchingUsers = usersQuery.data?.total ?? 0;
  const stats = statsQuery.data;
  const roleTemplates = rolesQuery.data ?? [];
  const tenants = tenantsQuery.data?.data ?? [];

  // The invite form's seat check is a READ keyed on the tenant, not a value a
  // change handler drops into state: picking the same tenant twice no longer
  // re-requests it, and switching away cancels the outstanding request rather
  // than letting a late answer overwrite a newer one.
  const limitQuery = useAdminQuery(
    adminKeys.tenants.detail(`${inviteFormData.tenantId || 'none'}:user-limit`),
    () => usersApi.checkTenantLimit(inviteFormData.tenantId),
    { enabled: isInviteModalOpen && inviteFormData.tenantId !== '' },
  );

  const userLimitCheck: UserLimitCheckResult | null =
    inviteFormData.tenantId === '' ? null : (limitQuery.data ?? null);

  const reload = (): void => {
    void usersQuery.refetch();
    void statsQuery.refetch();
    void rolesQuery.refetch();
    void tenantsQuery.refetch();
  };

  // ==========================================================================
  // Writes (ADMIN-HIGH-121)
  // ==========================================================================

  // Every user write changes both the list and the counts above it. Five
  // handlers called `fetchUsers()` AND `fetchInitialData()`; one —
  // `handleToggleStatus` — called only `fetchUsers()`, so activating or
  // deactivating a user refreshed the table and left "Active Users" showing the
  // figure from before the change. That asymmetry is why the pairing belongs to
  // the mutation rather than to each handler's tail.
  const userWriteKeys = [adminKeys.users.all()];

  const saveUser = useAdminMutation<User, void>(
    async () => {
      if (selectedUser) {
        return usersApi.update(selectedUser.id, {
          firstName: formData.firstName,
          lastName: formData.lastName,
          role: formData.role,
          tenantId: formData.tenantId || undefined,
          isActive: formData.isActive,
        });
      }
      return usersApi.create({
        email: formData.email,
        firstName: formData.firstName,
        lastName: formData.lastName,
        password: formData.password,
        role: formData.role,
        tenantId: formData.tenantId || undefined,
      });
    },
    { invalidateKeys: userWriteKeys },
  );

  const deleteUser = useAdminMutation<void, { id: string }>(({ id }) => usersApi.delete(id), {
    invalidateKeys: userWriteKeys,
  });

  const toggleUserStatus = useAdminMutation<User, { id: string; isActive: boolean }>(
    ({ id, isActive }) => (isActive ? usersApi.deactivate(id) : usersApi.activate(id)),
    { invalidateKeys: userWriteKeys },
  );

  // `force-logout` answers `{ success, count }`. The page announced "User has
  // been logged out of all sessions." on any 200 and discarded both fields — so
  // a refusal, or a user who had no sessions to end, read as a completed
  // security action. It throws on a refusal now and says how many sessions
  // actually ended.
  const forceLogout = useAdminMutation<{ success: boolean; count: number }, { id: string }>(
    async ({ id }) => {
      const result = await usersApi.forceLogout(id);
      if (!result.success) {
        throw new Error('The server did not end this user\'s sessions.');
      }
      return result;
    },
    { invalidateKeys: userWriteKeys },
  );

  const inviteUser = useAdminMutation<
    { success: boolean; userId: string; invitationId: string },
    void
  >(
    () =>
      usersApi.invite({
        tenantId: inviteFormData.tenantId,
        email: inviteFormData.email,
        firstName: inviteFormData.firstName || undefined,
        lastName: inviteFormData.lastName || undefined,
        role: inviteFormData.role,
        message: inviteFormData.message || undefined,
      }),
    { invalidateKeys: userWriteKeys },
  );

  const saving = saveUser.isPending;
  const inviting = inviteUser.isPending;

  const queryErrors = [
    usersQuery.error,
    statsQuery.error,
    rolesQuery.error,
    tenantsQuery.error,
    deleteUser.error,
    toggleUserStatus.error,
    forceLogout.error,
  ];

  useEffect(() => {
    setPage(1);
  }, [searchTerm, roleFilter, statusFilter, tenantFilter]);

  // Handle create/update user
  const handleSaveUser = (): void => {
    setFormError(null);
    if (!selectedUser && !formData.password) {
      setFormError('Password is required');
      return;
    }
    saveUser.mutate(undefined, {
      onSuccess: () => setIsModalOpen(false),
      onError: (err) => setFormError(err.message),
    });
  };

  // Handle delete user
  const handleDeleteUser = (): void => {
    if (!selectedUser) return;
    deleteUser.mutate(
      { id: selectedUser.id },
      {
        onSuccess: () => {
          setDeleteModalOpen(false);
          setSelectedUser(null);
        },
      },
    );
  };

  // Handle activate/deactivate
  const handleToggleStatus = (user: User): void => {
    toggleUserStatus.mutate({ id: user.id, isActive: user.isActive });
  };

  // Handle force logout
  const handleForceLogout = (user: User): void => {
    forceLogout.mutate(
      { id: user.id },
      {
        onSuccess: (result) =>
          setSuccessMessage(
            `Ended ${result.count} session${result.count === 1 ? '' : 's'} for this user.`,
          ),
      },
    );
  };

  // Handle invite user
  const handleInviteUser = (): void => {
    setInviteError(null);
    setInviteSuccess(null);

    if (!inviteFormData.email) {
      setInviteError('Email address is required');
      return;
    }
    if (!inviteFormData.tenantId) {
      setInviteError('Tenant selection is required');
      return;
    }
    // The seat check is already on screen as `userLimitCheck`; refusing from
    // the value the operator can see beats issuing a second request whose
    // answer they cannot.
    if (userLimitCheck && !userLimitCheck.canCreate) {
      setInviteError(userLimitCheck.message || 'User limit reached');
      return;
    }

    inviteUser.mutate(undefined, {
      onSuccess: () => {
        setInviteSuccess(`Invitation sent: ${inviteFormData.email}`);
        setInviteFormData({
          email: '',
          firstName: '',
          lastName: '',
          role: DEFAULT_ROLE,
          tenantId: '',
          message: '',
        });
      },
      onError: (err) => setInviteError(err.message),
    });
  };

  // Open invite modal
  const openInviteModal = (): void => {
    setInviteError(null);
    setInviteSuccess(null);
    setInviteFormData({
      email: '',
      firstName: '',
      lastName: '',
      role: DEFAULT_ROLE,
      tenantId: '',
      message: '',
    });
    setIsInviteModalOpen(true);
  };

  const handleInviteTenantChange = (tenantId: string): void => {
    setInviteFormData({ ...inviteFormData, tenantId });
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
      MODULE_MANAGER: 'Module Manager',
      MODULE_USER: 'User',
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
      header: 'User',
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
      header: 'Role',
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
      header: 'Status',
      sortable: true,
      render: (user) => (
        <Badge variant={user.isActive ? 'success' : 'default'}>
          {user.isActive ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
    {
      key: 'lastLoginAt',
      header: 'Last Login',
      sortable: true,
      render: (user) => (
        <span className="text-sm text-gray-500">
          {user.lastLoginAt ? formatDate(new Date(user.lastLoginAt), 'short') : 'Never logged in'}
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
            Details
          </Button>
          <Button variant="ghost" size="sm" onClick={() => openEditModal(user)}>
            Edit
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
          <h1 className="text-2xl font-bold text-gray-900">User Management</h1>
          {/* The FILTERED result total, labelled as one — the "Total" card
              below holds the platform figure, and with a filter applied the
              two disagree by design. */}
          <p className="mt-1 text-sm text-gray-500">
            {matchingUsers.toLocaleString()} user{matchingUsers === 1 ? '' : 's'} match
          </p>
        </div>
        <div className="mt-4 sm:mt-0 flex space-x-2">
          <Button variant="outline" onClick={reload} disabled={usersQuery.isFetching}>
            Refresh
          </Button>
          <Button variant="outline" onClick={openInviteModal}>
            <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            Send Invite
          </Button>
          <Button onClick={() => openEditModal(null)}>
            <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New User
          </Button>
        </div>
      </div>

      <QueryFailureNotice
        errors={queryErrors}
        hasContent={users.length > 0}
        onRetry={reload}
      />

      {successMessage && (
        <Alert type="success" dismissible onDismiss={() => setSuccessMessage(null)}>
          {successMessage}
        </Alert>
      )}

      {/* Stats */}
      {/* Platform-wide counts from the server's aggregate — an em dash when it
          has not loaded, never a zero. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card className="p-4">
          <p className="text-sm text-gray-500">Total</p>
          <p className="text-2xl font-bold text-gray-900">
            {stats ? stats.totalUsers.toLocaleString() : '—'}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-gray-500">Active</p>
          <p className="text-2xl font-bold text-green-600">
            {stats ? stats.activeUsers.toLocaleString() : '—'}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-gray-500">Logins (Last 24h)</p>
          <p className="text-2xl font-bold text-blue-600">
            {stats ? stats.loginsLast24Hours.toLocaleString() : '—'}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-gray-500">New (Last 30 Days)</p>
          <p className="text-2xl font-bold text-purple-600">
            {stats ? stats.newUsersLast30Days.toLocaleString() : '—'}
          </p>
        </Card>
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-5 gap-4">
          <div className="sm:col-span-2">
            <Input
              placeholder="Search by name or email..."
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
            value={roleFilter}
            onChange={(e) => { setRoleFilter(e.target.value); setPage(1); }}
            options={[
              { value: '', label: 'All Roles' },
              { value: 'SUPER_ADMIN', label: 'Super Admin' },
              { value: 'TENANT_ADMIN', label: 'Tenant Admin' },
              { value: 'MODULE_MANAGER', label: 'Module Manager' },
              { value: 'MODULE_USER', label: 'User' },
            ]}
          />
          <Select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            options={[
              { value: '', label: 'All Statuses' },
              { value: 'active', label: 'Active' },
              { value: 'inactive', label: 'Inactive' },
            ]}
          />
          <Select
            value={tenantFilter}
            onChange={(e) => { setTenantFilter(e.target.value); setPage(1); }}
            options={[
              { value: '', label: 'All Tenants' },
              ...tenants.map((t) => ({ value: t.id, label: t.name })),
            ]}
          />
        </div>
      </Card>

      {/* Table */}
      {usersQuery.isPending ? (
        <div className="text-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto"></div>
          <p className="mt-2 text-gray-500">Loading...</p>
        </div>
      ) : (
        <Table
          data={users}
          columns={columns}
          keyExtractor={(user) => user.id}
          emptyMessage="No users found"
        />
      )}

      {/* Pagination */}
      {matchingUsers > PAGE_SIZE && (
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
            Page {page} / {expectedTotalPages(matchingUsers, PAGE_SIZE)}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= expectedTotalPages(matchingUsers, PAGE_SIZE)}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      )}

      {/* Create/Edit Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={selectedUser ? 'Edit User' : 'New User'}
        size="md"
      >
        <div className="space-y-4">
          {formError && <Alert type="error">{formError}</Alert>}

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="First Name"
              value={formData.firstName}
              onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
              required
            />
            <Input
              label="Last Name"
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
              label="Password"
              type="password"
              value={formData.password}
              onChange={(e) => setFormData({ ...formData, password: e.target.value })}
              required
            />
          )}

          <Select
            label="Role"
            value={formData.role}
            onChange={(e) => {
              // A `<select>` hands back a string. Narrowing rather than
              // asserting means an option list that ever carries a role the
              // server does not accept is ignored here instead of producing a
              // 400 the operator cannot explain (ADMIN-CRITICAL-133).
              if (isPlatformRole(e.target.value)) {
                setFormData({ ...formData, role: e.target.value });
              }
            }}
            options={[
              { value: 'TENANT_ADMIN', label: 'Tenant Admin' },
              { value: 'MODULE_MANAGER', label: 'Module Manager' },
              { value: 'MODULE_USER', label: 'Module User' },
            ]}
          />

          <Select
            label="Tenant"
            value={formData.tenantId}
            onChange={(e) => setFormData({ ...formData, tenantId: e.target.value })}
            options={[
              { value: '', label: 'No Tenant (Super Admin)' },
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
              <label htmlFor="isActive" className="text-sm text-gray-700">Active</label>
            </div>
          )}

          <div className="flex justify-end space-x-3 pt-4">
            <Button variant="outline" onClick={() => setIsModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveUser} loading={saving}>
              {selectedUser ? 'Update' : 'Create'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Detail Modal */}
      <Modal
        isOpen={isDetailModalOpen}
        onClose={() => setIsDetailModalOpen(false)}
        title="User Details"
        size="md"
      >
        {selectedUser && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-gray-500">Full Name</p>
                <p className="font-medium">{selectedUser.firstName} {selectedUser.lastName}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">E-posta</p>
                <p className="font-medium">{selectedUser.email}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Role</p>
                <Badge variant={getRoleVariant(selectedUser.role)}>{getRoleLabel(selectedUser.role)}</Badge>
              </div>
              <div>
                <p className="text-xs text-gray-500">Status</p>
                <Badge variant={selectedUser.isActive ? 'success' : 'default'}>
                  {selectedUser.isActive ? 'Active' : 'Inactive'}
                </Badge>
              </div>
              <div>
                <p className="text-xs text-gray-500">Tenant</p>
                <p className="font-medium">{selectedUser.tenantName || '-'}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Last Login</p>
                <p className="font-medium">
                  {selectedUser.lastLoginAt
                    ? formatDate(new Date(selectedUser.lastLoginAt), 'long')
                    : 'Never logged in'}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Created</p>
                <p className="font-medium">{formatDate(new Date(selectedUser.createdAt), 'long')}</p>
              </div>
            </div>

            <div className="flex justify-end space-x-2 pt-4 border-t">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleToggleStatus(selectedUser)}
              >
                {selectedUser.isActive ? 'Deactivate' : 'Activate'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleForceLogout(selectedUser)}
              >
                Force Logout
              </Button>
              <Button variant="outline" onClick={() => setIsDetailModalOpen(false)}>
                Close
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
        title="Delete User"
        message={`Are you sure you want to delete user "${selectedUser?.email}"?`}
        confirmText="Delete"
        confirmVariant="danger"
      />

      {/* Invite User Modal */}
      <Modal
        isOpen={isInviteModalOpen}
        onClose={() => setIsInviteModalOpen(false)}
        title="Invite User"
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
              { value: '', label: 'Select Tenant' },
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
            placeholder="example@company.com"
            required
          />

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="First Name"
              value={inviteFormData.firstName}
              onChange={(e) =>
                setInviteFormData({ ...inviteFormData, firstName: e.target.value })
              }
            />
            <Input
              label="Last Name"
              value={inviteFormData.lastName}
              onChange={(e) =>
                setInviteFormData({ ...inviteFormData, lastName: e.target.value })
              }
            />
          </div>

          <Select
            label="Role *"
            value={inviteFormData.role}
            onChange={(e) => {
              if (isPlatformRole(e.target.value)) {
                setInviteFormData({ ...inviteFormData, role: e.target.value });
              }
            }}
            options={
              roleTemplates.length > 0
                ? roleTemplates
                    .filter((r) => r.code !== 'SUPER_ADMIN') // Don't allow SUPER_ADMIN invitation
                    .map((r) => ({
                      value: r.code,
                      label: `${r.name} (Level ${r.level})`,
                    }))
                : // Only reached when the catalogue read failed. These are the
                  // roles an invitation may grant — every platform role except
                  // SUPER_ADMIN — and they must stay in step with
                  // `INVITABLE_ROLES` on the server, which is what the invite
                  // DTO validates against.
                  [
                    { value: 'TENANT_ADMIN', label: 'Tenant Admin' },
                    { value: 'MODULE_MANAGER', label: 'Module Manager' },
                    { value: 'MODULE_USER', label: 'User' },
                  ]
            }
          />

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Message (Optional)
            </label>
            <textarea
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              rows={3}
              value={inviteFormData.message}
              onChange={(e) =>
                setInviteFormData({ ...inviteFormData, message: e.target.value })
              }
              placeholder="Invitation message..."
            />
          </div>

          <div className="bg-blue-50 rounded-lg p-3 text-sm text-blue-700">
            <strong>Note:</strong> An email will be sent to the invited user.
            The user will create their password by clicking the invite link.
          </div>

          <div className="flex justify-end space-x-3 pt-4">
            <Button variant="outline" onClick={() => setIsInviteModalOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleInviteUser}
              loading={inviting}
              disabled={!userLimitCheck?.canCreate && !!inviteFormData.tenantId}
            >
              Send Invite
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default UserManagementPage;
