import React, { useState, useEffect, useRef, useCallback } from 'react';
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
import { useAuthContext } from '@aquaculture/shared-ui';
import { AddEditUserModal, type UserFormData } from '../components/users/AddEditUserModal';
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
    role: apiUser.role as User['role'],
    status,
    modules: [],
    lastLogin: formatRelativeTime(apiUser.lastLoginAt || null),
    createdAt: apiUser.createdAt,
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
  // SEC-007: Check if current user has TENANT_ADMIN privileges for action visibility
  const { hasRoleOrHigher } = useAuthContext();
  const canManageUsers = hasRoleOrHigher('TENANT_ADMIN');

  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Server-side pagination
  const [page, setPage] = useState(0);
  const pageSize = 20;

  // Add User Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Edit state
  const [editingUser, setEditingUser] = useState<User | null>(null);

  // Delete state
  const [deletingUser, setDeletingUser] = useState<User | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // SEC-011: Bulk deactivation state
  const [isDeactivating, setIsDeactivating] = useState(false);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);

  // Roles for the modal
  const { data: roles = [], isLoading: rolesLoading } = useTenantRoles();

  // Debounce search query (PERF-003)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
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

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  // Handle save from AddEditUserModal (create or edit)
  const handleSaveUser = async (data: UserFormData) => {
    setIsSaving(true);
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
      // Refresh user list to avoid stale data (BUG-020)
      await loadUsers();
    } catch (err) {
      logError('TenantUsers.handleSaveUser', err);
      setSaveError((err as Error).message);
      throw err;
    } finally {
      setIsSaving(false);
    }
  };

  // Confirm and execute delete (BUG-003/BUG-004)
  const handleConfirmDelete = async () => {
    if (!deletingUser) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await deleteTenantUser(deletingUser.id);
      setDeletingUser(null);
      await loadUsers();
    } catch (err) {
      logError('TenantUsers.handleDelete', err);
      setDeleteError((err as Error).message);
    } finally {
      setIsDeleting(false);
    }
  };

  // SEC-011: Handle bulk deactivation of selected users
  const handleBulkDeactivate = async () => {
    if (selectedUsers.length === 0 || !canManageUsers) return;
    setIsDeactivating(true);
    setDeactivateError(null);
    try {
      await Promise.all(
        selectedUsers.map((userId) =>
          deactivateTenantUser(userId)
        )
      );
      setSelectedUsers([]);
      await loadUsers();
    } catch (err) {
      logError('TenantUsers.handleBulkDeactivate', err);
      setDeactivateError((err as Error).message);
    } finally {
      setIsDeactivating(false);
    }
  };

  // Filter users based on search and filters
  const filteredUsers = users.filter((user) => {
    const matchesSearch =
      user.name.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
      user.email.toLowerCase().includes(debouncedSearch.toLowerCase());
    const matchesRole = roleFilter === 'all' || user.role === roleFilter;
    const matchesStatus = statusFilter === 'all' || user.status === statusFilter;
    return matchesSearch && matchesRole && matchesStatus;
  });

  const toggleUserSelection = (userId: string) => {
    setSelectedUsers((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  };

  const toggleAllSelection = () => {
    if (selectedUsers.length === filteredUsers.length) {
      setSelectedUsers([]);
    } else {
      setSelectedUsers(filteredUsers.map((u) => u.id));
    }
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
            onClick={loadUsers}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-5 h-5 text-gray-500" />
          </button>
          <button className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
            <Download className="w-4 h-4" />
            Export
          </button>
          {/* SEC-007: Only TENANT_ADMIN+ can add users */}
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

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-800">Failed to load users</p>
            <p className="text-sm text-red-600">{error}</p>
          </div>
          <button onClick={loadUsers} className="ml-auto px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-100 rounded-lg transition-colors">
            Retry
          </button>
        </div>
      )}

      {/* Filters and Search */}
      <div className="bg-white rounded-xl border border-gray-100 p-4">
        <div className="flex flex-col md:flex-row md:items-center gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="text"
              placeholder="Search users by name or email..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500 focus:border-transparent"
            />
          </div>
          <select
            value={roleFilter}
            onChange={(e) => { setRoleFilter(e.target.value); setPage(0); }}
            className="px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500"
          >
            <option value="all">All Roles</option>
            <option value="TENANT_ADMIN">Tenant Admin</option>
            <option value="MODULE_MANAGER">Module Manager</option>
            <option value="MODULE_USER">Module User</option>
          </select>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }}
            className="px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500"
          >
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="pending">Pending</option>
          </select>
        </div>
      </div>

      {/* Bulk Actions (SEC-011: bulk deactivate enabled for TENANT_ADMIN+) */}
      {selectedUsers.length > 0 && canManageUsers && (
        <div className="bg-tenant-50 rounded-xl p-4 flex items-center justify-between">
          <span className="text-sm text-tenant-700">{selectedUsers.length} user(s) selected</span>
          <div className="flex items-center gap-2">
            {deactivateError && (
              <span className="text-sm text-red-600 mr-2">{deactivateError}</span>
            )}
            <button
              onClick={handleBulkDeactivate}
              disabled={isDeactivating}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-red-700 bg-red-100 rounded-lg hover:bg-red-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isDeactivating ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  Deactivating...
                </>
              ) : (
                <>
                  <UserMinus className="w-3.5 h-3.5" />
                  Deactivate
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Users Table */}
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                <th className="px-6 py-3 text-left">
                  <input
                    type="checkbox"
                    checked={selectedUsers.length === filteredUsers.length && filteredUsers.length > 0}
                    onChange={toggleAllSelection}
                    className="rounded border-gray-300 text-tenant-600 focus:ring-tenant-500"
                  />
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">User</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Role</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Last Login</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredUsers.map((user) => (
                <tr key={user.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4">
                    <input
                      type="checkbox"
                      checked={selectedUsers.includes(user.id)}
                      onChange={() => toggleUserSelection(user.id)}
                      className="rounded border-gray-300 text-tenant-600 focus:ring-tenant-500"
                    />
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <UserAvatar name={user.name} />
                      <div>
                        <p className="text-sm font-medium text-gray-900">{user.name}</p>
                        <p className="text-xs text-gray-500">{user.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <RoleBadge role={user.role} />
                  </td>
                  <td className="px-6 py-4">
                    <StatusBadge status={user.status} />
                  </td>
                  <td className="px-6 py-4">
                    <span className="text-sm text-gray-500">{user.lastLogin}</span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {/* SEC-007: Only TENANT_ADMIN+ can edit/delete users */}
                      {canManageUsers ? (
                        <>
                          <button
                            onClick={() => { setEditingUser(user); setSaveError(null); setIsModalOpen(true); }}
                            className="p-1.5 rounded-lg text-gray-500 hover:text-tenant-600 hover:bg-tenant-50 transition-colors"
                            title="Edit user"
                          >
                            <Edit className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => { setDeletingUser(user); setDeleteError(null); }}
                            className="p-1.5 rounded-lg text-gray-500 hover:text-red-600 hover:bg-red-50 transition-colors"
                            title="Delete user"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                          <button
                            className="p-1.5 rounded-lg text-gray-500 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                            title="More options"
                          >
                            <MoreVertical className="w-4 h-4" />
                          </button>
                        </>
                      ) : (
                        <span className="text-xs text-gray-500">View only</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Empty State */}
        {filteredUsers.length === 0 && !loading && (
          <div className="py-12 text-center">
            <Users className="w-12 h-12 text-gray-500 mx-auto" />
            <h3 className="mt-4 text-sm font-medium text-gray-900">
              {users.length === 0 ? 'No users yet' : 'No users found'}
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              {users.length === 0
                ? 'Add users to your tenant to get started.'
                : 'Try adjusting your search or filter criteria.'}
            </p>
          </div>
        )}

        {/* Pagination */}
        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between">
          <p className="text-sm text-gray-500">
            Showing {filteredUsers.length} users (page {page + 1})
          </p>
          <div className="flex items-center gap-2">
            <button
              className="px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </button>
            <button
              className="px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
              disabled={users.length < pageSize}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {/* Add/Edit User Modal */}
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

      {/* Delete Confirmation Modal (BUG-004) */}
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
