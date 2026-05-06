import React, { useState, useEffect, useRef } from 'react';
import {
  Users,
  Search,
  MoreVertical,
  Shield,
  CheckCircle,
  XCircle,
  Clock,
  Edit,
  Trash2,
  UserPlus,
  Download,
  RefreshCw,
  AlertCircle,
  UserMinus,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthContext } from '@aquaculture/shared-ui';
import { AddEditUserModal, type UserFormData } from '../components/users/AddEditUserModal';
import { UserFilters } from '../components/users/UserFilters';
import { BulkActions } from '../components/users/BulkActions';
import { UserListSection, type DisplayUser } from '../components/users/UserListSection';
import { useTenantRoles } from '../hooks/useTenantRoles';
import {
  getTenantUsers as fetchUsers,
  updateTenantUser,
  createTenantUser,
  deleteTenantUser,
  deactivateTenantUser,
} from '../lib/api';
import type { User as ApiUserType } from '../lib/types';
import { logError } from '../utils/error-handling';
import { formatRelativeTime } from '../utils/date-utils';
import { DeleteConfirmModal } from '../components/common';

// ApiUser = the User type returned by the GraphQL endpoint
type ApiUser = ApiUserType;

/**
 * User type for display
 */
interface User {
  id: string;
  name: string;
  email: string;
  role: 'TENANT_ADMIN' | 'MODULE_MANAGER' | 'MODULE_USER' | 'SUPER_ADMIN';
  status: 'active' | 'inactive' | 'pending';
  modules: string[];
  lastLogin: string;
  createdAt: string;
}

/**
 * Role badge component
 */
const RoleBadge: React.FC<{ role: User['role'] }> = ({ role }) => {
  const roleConfig: Record<string, { bg: string; text: string; label: string }> = {
    SUPER_ADMIN: { bg: 'bg-red-100', text: 'text-red-700', label: 'Super Admin' },
    TENANT_ADMIN: { bg: 'bg-purple-100', text: 'text-purple-700', label: 'Tenant Admin' },
    MODULE_MANAGER: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'Module Manager' },
    MODULE_USER: { bg: 'bg-gray-100', text: 'text-gray-700', label: 'Module User' },
  };

  const config = roleConfig[role] || roleConfig.MODULE_USER;

  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${config.bg} ${config.text}`}>
      <Shield className="w-3 h-3 mr-1" />
      {config.label}
    </span>
  );
};

/**
 * Status badge component
 */
const StatusBadge: React.FC<{ status: User['status'] }> = ({ status }) => {
  const statusConfig = {
    active: { bg: 'bg-green-100', text: 'text-green-700', icon: <CheckCircle className="w-3 h-3" /> },
    inactive: { bg: 'bg-gray-100', text: 'text-gray-700', icon: <XCircle className="w-3 h-3" /> },
    pending: { bg: 'bg-yellow-100', text: 'text-yellow-700', icon: <Clock className="w-3 h-3" /> },
  };

  const config = statusConfig[status];

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${config.bg} ${config.text}`}>
      {config.icon}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
};

/**
 * User avatar component
 */
const UserAvatar: React.FC<{ name: string; size?: 'sm' | 'md' | 'lg' }> = ({ name, size = 'md' }) => {
  const initials = name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2);
  const sizeClasses = { sm: 'w-8 h-8 text-xs', md: 'w-10 h-10 text-sm', lg: 'w-12 h-12 text-base' };

  return (
    <div className={`${sizeClasses[size]} rounded-full bg-gradient-to-br from-tenant-500 to-tenant-700 flex items-center justify-center text-white font-medium`}>
      {initials || '??'}
    </div>
  );
};

/**
 * Transform API user to display user
 */
interface ApiUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
  isActive: boolean;
  isEmailVerified?: boolean;
  lastLoginAt?: string;
  createdAt: string;
}

function transformUser(apiUser: ApiUser): User {
  let status: User['status'] = 'active';
  if (!apiUser.isActive) {
    status = 'inactive';
  } else if (!apiUser.isEmailVerified && !apiUser.lastLoginAt) {
    status = 'pending';
  }

  return {
    id: apiUser.id,
    name: `${apiUser.firstName || ''} ${apiUser.lastName || ''}`.trim() || apiUser.email.split('@')[0],
    email: apiUser.email,
    role: apiUser.role,
    // WHY: Carry accessType through to DisplayUser so both the table badge
    // and the edit modal can read it without a separate API call.
    accessType: apiUser.accessType || 'BOTH',
    status,
    lastLogin: formatRelativeTime(apiUser.lastLoginAt || null),
  };
}

// Query strings removed -- now using typed API functions from lib/api

/**
 * TenantUsers Page
 *
 * SEC-007: Permission-based UI filtering.
 * - Only TENANT_ADMIN (or higher) can see Add User, Edit, Delete, and Deactivate buttons.
 * - The route-level guard in Module.tsx already blocks unauthorized access, but
 *   this page-level filtering provides defense-in-depth for individual actions.
 */
const TenantUsers: React.FC = () => {
  const { hasRoleOrHigher } = useAuthContext();
  const canManageUsers = hasRoleOrHigher('TENANT_ADMIN');
  const queryClient = useQueryClient();

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);

  // Pagination
  const [page, setPage] = useState(0);
  const pageSize = 20;

  // Selection
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);

  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Edit state
  const [editingUser, setEditingUser] = useState<User | null>(null);

  // Delete state
  const [deletingUser, setDeletingUser] = useState<User | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // SEC-011: Bulk deactivation state
  const [deactivateError, setDeactivateError] = useState<string | null>(null);

  // Roles for the modal
  const { data: roles = [], isLoading: rolesLoading } = useTenantRoles();

  // Debounce search (PERF-003)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchQuery]);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const options: { limit: number; offset: number; status?: string; role?: string } = {
        limit: pageSize,
        offset: page * pageSize,
      };
      if (statusFilter !== 'all') options.status = statusFilter;
      if (roleFilter !== 'all') options.role = roleFilter;

      const apiUsers = await fetchUsers(options);
      setUsers((apiUsers || []).map(transformUser));
    } catch (err) {
      logError('TenantUsers.loadUsers', err);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, statusFilter, roleFilter]);

  // Mutations
  const createUserMutation = useCreateTenantUser();
  const updateUserMutation = useUpdateTenantUser();
  const deleteUserMutation = useDeleteTenantUser();
  const deactivateUserMutation = useDeactivateTenantUser();

  // Mutations
  const createUserMutation = useCreateTenantUser();
  const updateUserMutation = useUpdateTenantUser();
  const deleteUserMutation = useDeleteTenantUser();
  const deactivateUserMutation = useDeactivateTenantUser();

  const isSaving = createUserMutation.isPending || updateUserMutation.isPending;
  const isDeleting = deleteUserMutation.isPending;

  // Handlers
  const handleSaveUser = async (data: UserFormData) => {
    setSaveError(null);
    try {
      if (editingUser) {
        // Update existing user
        await updateTenantUser(editingUser.id, {
          firstName: data.firstName,
          lastName: data.lastName,
          roleId: data.roleId,
        });
      } else {
        // Create new user
        await createTenantUser({
          firstName: data.firstName,
          lastName: data.lastName,
          email: data.email,
          roleId: data.roleId,
          sendInvitation: data.sendInvitation ?? true,
        });
      }
      setIsModalOpen(false);
      setEditingUser(null);
    } catch (err) {
      logError('TenantUsers.handleSaveUser', err);
      setSaveError((err as Error).message);
      throw err;
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingUser) return;
    setDeleteError(null);
    try {
      await deleteTenantUser(deletingUser.id);
      setDeletingUser(null);
    } catch (err) {
      logError('TenantUsers.handleDelete', err);
      setDeleteError((err as Error).message);
    }
  };

  // SEC-011: Handle bulk deactivation of selected users
  const handleBulkDeactivate = async () => {
    if (selectedUsers.length === 0 || !canManageUsers) return;
    setDeactivateError(null);
    try {
      await Promise.all(
        selectedUsers.map((userId) =>
          deactivateTenantUser(userId)
        )
      );
      setSelectedUsers([]);
    } catch (err) {
      logError('TenantUsers.handleBulkDeactivate', err);
      setDeactivateError((err as Error).message);
    }
  };

  const isDeactivating = deactivateUserMutation.isPending;
  const isSaving = createUserMutation.isPending || updateUserMutation.isPending;
  const isDeleting = deleteUserMutation.isPending;

  // Filter users based on search and filters
  const filteredUsers = users.filter((user) => {
    const matchesSearch =
      user.name.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
      user.email.toLowerCase().includes(debouncedSearch.toLowerCase());
    const matchesRole = roleFilter === 'all' || user.role === roleFilter;
    const matchesStatus = statusFilter === 'all' || user.status === statusFilter;
    return matchesSearch && matchesRole && matchesStatus;
  });

  const toggleUserSelection = useCallback((userId: string) => {
    setSelectedUsers((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  }, []);

  const toggleAllSelection = useCallback(() => {
    setSelectedUsers((prev) =>
      prev.length === filteredUsers.length ? [] : filteredUsers.map((u) => u.id),
    );
  }, [filteredUsers]);

  const handleRoleChange = (value: string) => { setRoleFilter(value); setPage(0); };
  const handleStatusChange = (value: string) => { setStatusFilter(value); setPage(0); };

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: tenantKeys.users() });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 animate-spin text-tenant-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Users</h1>
          <p className="text-sm text-gray-500 mt-1">Manage users and their access to modules</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleRefresh}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-5 h-5 text-gray-500" />
          </button>
          <button className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
            <Download className="w-4 h-4" />
            Export
          </button>
          {canManageUsers && (
            <button
              onClick={() => { setSaveError(null); setEditingUser(null); setIsModalOpen(true); }}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-tenant-600 rounded-lg hover:bg-tenant-700 transition-colors"
            >
              <UserPlus className="w-4 h-4" />
              Add User
            </button>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-800">Failed to load users</p>
            <p className="text-sm text-red-600">{error}</p>
          </div>
          <button onClick={handleRefresh} className="ml-auto px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-100 rounded-lg transition-colors">
            Retry
          </button>
        </div>
      )}

      <UserFilters
        onSearchChange={setSearchQuery}
        onStatusChange={handleStatusChange}
        onRoleChange={handleRoleChange}
        currentFilters={{ search: searchQuery, status: statusFilter, role: roleFilter }}
      />

      <BulkActions
        selectedUsers={selectedUsers}
        onDeactivate={handleDeactivateUser}
        onClearSelection={() => setSelectedUsers([])}
        isDeactivating={deactivateUserMutation.isPending}
        canManageUsers={canManageUsers}
      />

      <UserListSection
        users={filteredUsers}
        isLoading={loading}
        pagination={{ page, pageSize, rawPageCount: users.length }}
        onPageChange={setPage}
        onSelectUser={toggleUserSelection}
        selectedUsers={selectedUsers}
        onToggleAll={toggleAllSelection}
        onEditUser={(user) => { setEditingUser(user); setSaveError(null); setIsModalOpen(true); }}
        onDeleteUser={(user) => { setDeletingUser(user); setDeleteError(null); }}
        canManageUsers={canManageUsers}
        totalUsersInPage={users.length}
      />

      <AddEditUserModal
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setEditingUser(null); }}
        user={editingUser}
        roles={roles}
        rolesLoading={rolesLoading}
        onSave={handleSaveUser}
        isLoading={isSaving}
        error={saveError}
      />

      {deletingUser && (
        <DeleteConfirmModal
          isOpen={!!deletingUser}
          onClose={() => setDeletingUser(null)}
          onConfirm={handleConfirmDelete}
          title="Delete User"
          message={`Are you sure you want to delete "${deletingUser.name}"? This action cannot be undone.`}
          warningMessage={deleteError ?? undefined}
          isLoading={isDeleting}
        />
      )}
    </div>
  );
};

export default TenantUsers;
