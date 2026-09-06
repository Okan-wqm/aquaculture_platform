import React, { useState, useEffect, useRef, useCallback } from 'react';
import { UserPlus, RefreshCw, AlertCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@aquaculture/shared-ui';
import { AddEditUserModal, type UserFormData } from '../components/users/AddEditUserModal';
import { UserFilters } from '../components/users/UserFilters';
import { BulkActions } from '../components/users/BulkActions';
import { UserListSection, type DisplayUser } from '../components/users/UserListSection';
import { SiteAccessModal } from '../components/users/SiteAccessModal';
import { EffectivePermissionsModal } from '../components/users/EffectivePermissionsModal';
import { useTenantRoles } from '../hooks/useTenantRoles';
import { canManageUserSiteAccess } from '../hooks/useUserSiteAccess';
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
import { logError, sanitizeErrorMessage } from '../utils/error-handling';
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
    name:
      `${apiUser.firstName || ''} ${apiUser.lastName || ''}`.trim() || apiUser.email.split('@')[0],
    email: apiUser.email,
    role: apiUser.role,
    status,
    // Locked ⟺ lockedUntil is in the future — the same predicate User.isLocked
    // uses server-side, so the row action appears exactly when the lockout is
    // real rather than whenever the column is merely non-null.
    isLocked: Boolean(apiUser.lockedUntil) && new Date(apiUser.lockedUntil ?? 0) > new Date(),
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
  // RBAC-HIGH-004 (FE-HIGH-001): gate each control on the SAME granular capability
  // the backend enforces, not the coarse TENANT_ADMIN role. Admins bypass inside
  // hasResourcePermission, so this is a superset that additionally honours a
  // delegate holding the specific users:* capability (previously blocked).
  const { hasPermission, user: currentUser } = useAuth();
  const canInviteUsers = hasPermission('users:invite');
  const canEditUsers = hasPermission('users:edit_permissions');
  const canDeactivateUsers = hasPermission('users:deactivate');
  const canManageSiteAccess = canManageUserSiteAccess(currentUser?.role);
  const queryClient = useQueryClient();

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
  const [siteAccessUser, setSiteAccessUser] = useState<DisplayUser | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [activatingUser, setActivatingUser] = useState<DisplayUser | null>(null);
  const [unlockingUser, setUnlockingUser] = useState<DisplayUser | null>(null);
  const [permissionsUser, setPermissionsUser] = useState<DisplayUser | null>(null);
  // Two distinct surfaces: an open confirm modal owns its own failure text,
  // while the page banner reports outcomes of operations that have no modal
  // left open. Rendering one message in both places was just duplication.
  const [lifecycleModalError, setLifecycleModalError] = useState<string | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [lifecycleNotice, setLifecycleNotice] = useState<string | null>(null);

  // Roles
  const { data: roles = [], isLoading: rolesLoading } = useTenantRoles();

  // Debounce search (PERF-003)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
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
    setLifecycleModalError(null);
    try {
      await activateUserMutation.mutateAsync(activatingUser.id);
      setLifecycleNotice(`${activatingUser.name} can sign in again.`);
      setActivatingUser(null);
    } catch (err) {
      logError('TenantUsers.handleActivate', err);
      // Keep the modal open carrying the reason — the operation did not happen.
      setLifecycleModalError(sanitizeErrorMessage(err));
    }
  }, [activatingUser, activateUserMutation]);

  const handleConfirmUnlock = useCallback(async () => {
    if (!unlockingUser) return;
    setLifecycleModalError(null);
    try {
      await unlockUserMutation.mutateAsync(unlockingUser.id);
      setLifecycleNotice(`The login lockout for ${unlockingUser.name} has been cleared.`);
      setUnlockingUser(null);
    } catch (err) {
      logError('TenantUsers.handleUnlock', err);
      setLifecycleModalError(sanitizeErrorMessage(err));
    }
  }, [unlockingUser, unlockUserMutation]);

  const handleBulkAssignRole = useCallback(
    async (roleId: string): Promise<BulkAssignRoleResult> => {
      setLifecycleError(null);
      try {
        const result = await bulkAssignRoleMutation.mutateAsync({
          userIds: selectedUsers,
          roleId,
        });
        // Partial success is a REAL outcome of this mutation, so report both
        // halves rather than declaring a blanket success.
        if (result.failed.length === 0) {
          setLifecycleNotice(`Role assigned to ${result.success.length} user(s).`);
        } else {
          setLifecycleNotice(null);
          setLifecycleError(
            `${result.success.length} user(s) updated, ${result.failed.length} failed.`,
          );
        }
        return result;
      } catch (err) {
        logError('TenantUsers.handleBulkAssignRole', err);
        setLifecycleError(sanitizeErrorMessage(err));
        throw err;
      }
    },
    [bulkAssignRoleMutation, selectedUsers],
  );

  const handleRefresh = () =>
    queryClient.invalidateQueries({ queryKey: tenantKeys.invalidateUsers() });

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

  const handleRoleChange = (value: string) => {
    setRoleFilter(value);
    setPage(0);
  };
  const handleStatusChange = (value: string) => {
    setStatusFilter(value);
    setPage(0);
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
          <p className="text-sm text-gray-500 mt-1">
            Manage users and their access to modules and farm sites
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleRefresh}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-5 h-5 text-gray-500" />
          </button>
          {/* RBAC-L6: the previous "Export" button was UNWIRED (no onClick, no
              export backend) yet rendered ungated to every users:view delegate —
              a false affordance. Removed; reintroduce only together with a real
              export path AND a capability gate. */}
          {canInviteUsers && (
            <button
              onClick={() => {
                setSaveError(null);
                setEditingUser(null);
                setIsModalOpen(true);
              }}
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
          <button
            onClick={handleRefresh}
            className="ml-auto px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-100 rounded-lg transition-colors"
          >
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

      {(lifecycleNotice || lifecycleError) && (
        <div
          role="status"
          className={
            lifecycleError
              ? 'rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700'
              : 'rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700'
          }
        >
          {lifecycleError ?? lifecycleNotice}
        </div>
      )}

      <BulkActions
        selectedUsers={selectedUsers}
        onDeactivate={handleDeactivateUser}
        onAssignRole={handleBulkAssignRole}
        onClearSelection={() => setSelectedUsers([])}
        isDeactivating={deactivateUserMutation.isPending}
        isAssigningRole={bulkAssignRoleMutation.isPending}
        roles={roles}
        canDeactivateUsers={canDeactivateUsers}
        canAssignRoles={canEditUsers}
      />

      <UserListSection
        users={filteredUsers}
        isLoading={loading}
        pagination={{ page, pageSize, rawPageCount: users.length }}
        onPageChange={setPage}
        onSelectUser={toggleUserSelection}
        selectedUsers={selectedUsers}
        onToggleAll={toggleAllSelection}
        onEditUser={(user) => {
          setEditingUser(user);
          setSaveError(null);
          setIsModalOpen(true);
        }}
        onDeleteUser={(user) => {
          setDeletingUser(user);
          setDeleteError(null);
        }}
        onManageSiteAccess={setSiteAccessUser}
        onActivateUser={(user) => {
          setLifecycleModalError(null);
          setLifecycleError(null);
          setLifecycleNotice(null);
          setActivatingUser(user);
        }}
        onUnlockUser={(user) => {
          setLifecycleModalError(null);
          setLifecycleError(null);
          setLifecycleNotice(null);
          setUnlockingUser(user);
        }}
        onViewPermissions={setPermissionsUser}
        canEditUsers={canEditUsers}
        canDeactivateUsers={canDeactivateUsers}
        canManageSiteAccess={canManageSiteAccess}
        totalUsersInPage={users.length}
      />

      <AddEditUserModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingUser(null);
        }}
        user={editingUser}
        roles={roles}
        rolesLoading={rolesLoading}
        onSave={handleSaveUser}
        isLoading={isSaving}
        error={saveError}
      />

      <SiteAccessModal
        isOpen={siteAccessUser !== null}
        onClose={() => setSiteAccessUser(null)}
        user={siteAccessUser}
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
          isOpen={activatingUser !== null}
          onClose={() => setActivatingUser(null)}
          onConfirm={handleConfirmActivate}
          title="Activate User"
          message={`Activate "${activatingUser.name}"? The user will be able to sign in again.`}
          warningMessage={lifecycleModalError ?? undefined}
          confirmLabel="Activate"
          cancelLabel="Cancel"
          variant="warning"
          isLoading={activateUserMutation.isPending}
        />
      )}

      {unlockingUser && (
        <DeleteConfirmModal
          isOpen={unlockingUser !== null}
          onClose={() => setUnlockingUser(null)}
          onConfirm={handleConfirmUnlock}
          title="Unlock User"
          message={`Unlock "${unlockingUser.name}"? This clears the failed-login lockout so the user can sign in immediately.`}
          warningMessage={lifecycleModalError ?? undefined}
          confirmLabel="Unlock"
          cancelLabel="Cancel"
          variant="warning"
          isLoading={unlockUserMutation.isPending}
        />
      )}

      <EffectivePermissionsModal
        isOpen={permissionsUser !== null}
        onClose={() => setPermissionsUser(null)}
        user={permissionsUser}
      />
    </div>
  );
};

export default TenantUsers;
