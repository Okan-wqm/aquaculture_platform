import React, { useState, useEffect, useRef, useCallback } from 'react';
import { UserPlus, Download, RefreshCw, AlertCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthContext, useToast } from '@aquaculture/shared-ui';
import { AddEditUserModal, type UserFormData } from '../components/users/AddEditUserModal';
import { UserFilters } from '../components/users/UserFilters';
import { BulkActions } from '../components/users/BulkActions';
import { UserListSection, type DisplayUser } from '../components/users/UserListSection';
import { EffectivePermissionsModal } from '../components/users/EffectivePermissionsModal';
import { useTenantRoles } from '../hooks/useTenantRoles';
import {
  useTenantUsersRaw,
  useCreateTenantUser,
  useUpdateTenantUser,
  useDeleteTenantUser,
  useDeactivateTenantUser,
  useActivateTenantUser,
  useUnlockTenantUser,
  useBulkAssignUserRole,
  tenantKeys,
  type BulkAssignRoleResult,
} from '../hooks/useTenantData';
import { logError, createErrorToastOptions } from '../utils/error-handling';
import { formatRelativeTime } from '../utils/date-utils';
import { DeleteConfirmModal } from '../components/common';

// ---------------------------------------------------------------------------
// Types & helpers
// ---------------------------------------------------------------------------

interface ApiUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
  isActive?: boolean;
  isEmailVerified?: boolean;
  lastLoginAt?: string;
  lockedUntil?: string | null;
  createdAt: string;
}

function transformUser(apiUser: ApiUser): DisplayUser {
  let status: 'active' | 'inactive' | 'pending' = 'active';
  if (apiUser.isActive === false) {
    status = 'inactive';
  } else if (!apiUser.isEmailVerified && !apiUser.lastLoginAt) {
    status = 'pending';
  }

  return {
    id: apiUser.id,
    name: `${apiUser.firstName || ''} ${apiUser.lastName || ''}`.trim() || apiUser.email.split('@')[0],
    email: apiUser.email,
    role: apiUser.role,
    status,
    // Locked = lockedUntil in the future (mirrors User.isLocked on the server).
    isLocked: !!apiUser.lockedUntil && new Date(apiUser.lockedUntil) > new Date(),
    lastLogin: formatRelativeTime(apiUser.lastLoginAt || null),
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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
  const { toast } = useToast();

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Pagination
  const [page, setPage] = useState(0);
  const pageSize = 20;

  // Selection
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);

  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editingUser, setEditingUser] = useState<DisplayUser | null>(null);
  const [deletingUser, setDeletingUser] = useState<DisplayUser | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [activatingUser, setActivatingUser] = useState<DisplayUser | null>(null);
  const [unlockingUser, setUnlockingUser] = useState<DisplayUser | null>(null);
  const [permissionsUser, setPermissionsUser] = useState<DisplayUser | null>(null);

  // Roles
  const { data: roles = [], isLoading: rolesLoading } = useTenantRoles();

  // Debounce search (PERF-003)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchQuery]);

  // Data
  const {
    data: rawUsers = [],
    isLoading: loading,
    error: queryError,
  } = useTenantUsersRaw({
    limit: pageSize,
    offset: page * pageSize,
    status: statusFilter !== 'all' ? statusFilter : undefined,
    role: roleFilter !== 'all' ? roleFilter : undefined,
  });

  const error = queryError ? (queryError as Error).message : null;
  const users = rawUsers.map(transformUser);

  // Client-side search filter
  const filteredUsers = users.filter((user) => {
    const q = debouncedSearch.toLowerCase();
    return user.name.toLowerCase().includes(q) || user.email.toLowerCase().includes(q);
  });

  // Mutations
  const createUserMutation = useCreateTenantUser();
  const updateUserMutation = useUpdateTenantUser();
  const deleteUserMutation = useDeleteTenantUser();
  const deactivateUserMutation = useDeactivateTenantUser();
  const activateUserMutation = useActivateTenantUser();
  const unlockUserMutation = useUnlockTenantUser();
  const bulkAssignRoleMutation = useBulkAssignUserRole();

  const isSaving = createUserMutation.isPending || updateUserMutation.isPending;
  const isDeleting = deleteUserMutation.isPending;

  // Handlers
  const handleSaveUser = async (data: UserFormData) => {
    setSaveError(null);
    try {
      if (editingUser) {
        await updateUserMutation.mutateAsync({
          userId: editingUser.id,
          input: { firstName: data.firstName, lastName: data.lastName, roleId: data.roleId },
        });
      } else {
        await createUserMutation.mutateAsync({
          firstName: data.firstName,
          lastName: data.lastName,
          email: data.email,
          roleId: data.roleId || '',
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
      await deleteUserMutation.mutateAsync(deletingUser.id);
      setDeletingUser(null);
    } catch (err) {
      logError('TenantUsers.handleDelete', err);
      setDeleteError((err as Error).message);
    }
  };

  const handleDeactivateUser = useCallback(
    async (userId: string): Promise<void> => {
      await deactivateUserMutation.mutateAsync(userId);
    },
    [deactivateUserMutation],
  );

  const handleConfirmActivate = useCallback(async () => {
    if (!activatingUser) return;
    try {
      await activateUserMutation.mutateAsync(activatingUser.id);
      toast({
        variant: 'success',
        title: 'User activated',
        description: `${activatingUser.name} can now sign in again.`,
      });
    } catch (err) {
      logError('TenantUsers.handleActivate', err);
      toast(createErrorToastOptions(err));
    } finally {
      setActivatingUser(null);
    }
  }, [activatingUser, activateUserMutation, toast]);

  const handleConfirmUnlock = useCallback(async () => {
    if (!unlockingUser) return;
    try {
      await unlockUserMutation.mutateAsync(unlockingUser.id);
      toast({
        variant: 'success',
        title: 'User unlocked',
        description: `The login lockout for ${unlockingUser.name} has been cleared.`,
      });
    } catch (err) {
      logError('TenantUsers.handleUnlock', err);
      toast(createErrorToastOptions(err));
    } finally {
      setUnlockingUser(null);
    }
  }, [unlockingUser, unlockUserMutation, toast]);

  const handleBulkAssignRole = useCallback(
    async (roleId: string): Promise<BulkAssignRoleResult> => {
      try {
        const result = await bulkAssignRoleMutation.mutateAsync({
          userIds: selectedUsers,
          roleId,
        });
        if (result.failed.length === 0) {
          toast({
            variant: 'success',
            title: 'Role assigned',
            description: `Role assigned to ${result.success.length} user(s).`,
          });
        } else {
          toast({
            variant: 'warning',
            title: 'Role assignment partially failed',
            description: `${result.success.length} user(s) updated, ${result.failed.length} failed.`,
          });
        }
        return result;
      } catch (err) {
        logError('TenantUsers.handleBulkAssignRole', err);
        toast(createErrorToastOptions(err));
        throw err;
      }
    },
    [bulkAssignRoleMutation, selectedUsers, toast],
  );

  const handleRefresh = () => queryClient.invalidateQueries({ queryKey: tenantKeys.users() });

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
          <button onClick={handleRefresh} className="p-2 rounded-lg hover:bg-gray-100 transition-colors" title="Refresh">
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
        onAssignRole={handleBulkAssignRole}
        onClearSelection={() => setSelectedUsers([])}
        isDeactivating={deactivateUserMutation.isPending}
        isAssigningRole={bulkAssignRoleMutation.isPending}
        roles={roles}
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
        onActivateUser={setActivatingUser}
        onUnlockUser={setUnlockingUser}
        onViewPermissions={setPermissionsUser}
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

      {activatingUser && (
        <DeleteConfirmModal
          isOpen={!!activatingUser}
          onClose={() => setActivatingUser(null)}
          onConfirm={handleConfirmActivate}
          title="Activate User"
          message={`Are you sure you want to activate "${activatingUser.name}"? The user will be able to sign in again.`}
          confirmLabel="Activate"
          cancelLabel="Cancel"
          variant="warning"
          isLoading={activateUserMutation.isPending}
        />
      )}

      {unlockingUser && (
        <DeleteConfirmModal
          isOpen={!!unlockingUser}
          onClose={() => setUnlockingUser(null)}
          onConfirm={handleConfirmUnlock}
          title="Unlock User"
          message={`Are you sure you want to unlock "${unlockingUser.name}"? This clears the failed-login lockout so the user can sign in immediately.`}
          confirmLabel="Unlock"
          cancelLabel="Cancel"
          variant="warning"
          isLoading={unlockUserMutation.isPending}
        />
      )}

      <EffectivePermissionsModal
        isOpen={!!permissionsUser}
        onClose={() => setPermissionsUser(null)}
        user={permissionsUser}
      />
    </div>
  );
};

export default TenantUsers;
