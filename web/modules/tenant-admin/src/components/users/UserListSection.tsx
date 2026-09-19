import React from 'react';
import { Users, Edit, Trash2, MapPin, UserCheck, LockOpen, ShieldCheck } from 'lucide-react';
import { UserAvatar } from '../ui/UserAvatar';
import { RoleBadge } from '../ui/RoleBadge';
import { StatusBadge } from '../ui/StatusBadge';
import { DataTable, type DataTableColumn, Button } from '@aquaculture/shared-ui';

export interface DisplayUser {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  /** True while the user's failed-login lockout (lockedUntil) is in the future. */
  isLocked: boolean;
  lastLogin: string;
}

export interface PaginationState {
  page: number;
  pageSize: number;
  /** Total items returned in the current (unfiltered) page from the API */
  rawPageCount: number;
}

export interface UserListSectionProps {
  users: DisplayUser[];
  isLoading: boolean;
  pagination: PaginationState;
  onPageChange: (page: number) => void;
  selectedUsers: string[];
  /** Full selection after a row or the header checkbox toggles. */
  onSelectionChange: (userIds: string[]) => void;
  onEditUser: (user: DisplayUser) => void;
  onDeleteUser: (user: DisplayUser) => void;
  onManageSiteAccess: (user: DisplayUser) => void;
  /** ADMIN-HIGH-012: the return leg of deactivation. */
  onActivateUser: (user: DisplayUser) => void;
  /** ADMIN-HIGH-012: clear a failed-login lockout. */
  onUnlockUser: (user: DisplayUser) => void;
  /** ADMIN-MEDIUM-016: show the user's resolved permissions. */
  onViewPermissions: (user: DisplayUser) => void;
  // RBAC-HIGH-004: per-action capability gating matching the backend
  // (users:edit_permissions for edit, users:deactivate for delete).
  canEditUsers: boolean;
  canDeactivateUsers: boolean;
  canManageSiteAccess: boolean;
  totalUsersInPage: number;
}

/**
 * User table with pagination, selection, and action buttons.
 * FIX (MED-07): pagination next button disabled when rawPageCount < pageSize.
 */
export const UserListSection: React.FC<UserListSectionProps> = ({
  users,
  isLoading,
  pagination,
  onPageChange,
  selectedUsers,
  onSelectionChange,
  onEditUser,
  onDeleteUser,
  onManageSiteAccess,
  onActivateUser,
  onUnlockUser,
  onViewPermissions,
  canEditUsers,
  canDeactivateUsers,
  canManageSiteAccess,
  totalUsersInPage,
}) => {
  const displayUserColumns: DataTableColumn<DisplayUser>[] = [
    {
      key: 'user',
      header: 'User',
      render: (_value, user) => (
        <div className="flex items-center gap-3">
          <UserAvatar name={user.name} />
          <div>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{user.name}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">{user.email}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      render: (_value, user) => (
        <RoleBadge role={user.role} />
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (_value, user) => (
        <StatusBadge status={user.status} />
      ),
    },
    {
      key: 'lastLogin',
      header: 'Last Login',
      render: (_value, user) => (
        <span className="text-sm text-gray-500 dark:text-gray-400">{user.lastLogin}</span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (_value, user) => (
        <div className="flex items-center justify-end gap-2">
          {canEditUsers && (
            <Button variant="ghost" size="sm" iconOnly type="button" onClick={() => onEditUser(user)} aria-label={`Edit ${user.name}`} title="Edit user"><Edit className="w-4 h-4" aria-hidden="true" /></Button>
          )}
          {canManageSiteAccess && user.role === 'MODULE_USER' && (
            <Button variant="ghost" size="sm" iconOnly type="button" onClick={() => onManageSiteAccess(user)} aria-label={`Manage site access for ${user.name}`} title="Manage site access"><MapPin className="w-4 h-4" aria-hidden="true" /></Button>
          )}
          {canDeactivateUsers && user.status !== 'inactive' && (
            <Button variant="ghost" size="sm" iconOnly type="button" onClick={() => onDeleteUser(user)} aria-label={`Delete ${user.name}`} title="Delete user"><Trash2 className="w-4 h-4" aria-hidden="true" /></Button>
          )}
          {/* ADMIN-HIGH-012: deactivation used to be a one-way
              trapdoor here — the guarded resolvers existed but no UI
              called them, so restoring access needed a platform
              admin. The reactivate and unlock actions are gated by
              the SAME capability that allowed the deactivation. */}
          {canDeactivateUsers && user.status === 'inactive' && (
            <Button variant="ghost" size="sm" iconOnly type="button" onClick={() => onActivateUser(user)} aria-label={`Activate ${user.name}`} title="Activate user"><UserCheck className="w-4 h-4" aria-hidden="true" /></Button>
          )}
          {canDeactivateUsers && user.isLocked && (
            <Button variant="ghost" size="sm" iconOnly type="button" onClick={() => onUnlockUser(user)} aria-label={`Unlock ${user.name}`} title="Unlock user"><LockOpen className="w-4 h-4" aria-hidden="true" /></Button>
          )}
          {canEditUsers && (
            <Button variant="ghost" size="sm" iconOnly type="button" onClick={() => onViewPermissions(user)} aria-label={`Effective permissions for ${user.name}`} title="Effective permissions"><ShieldCheck className="w-4 h-4" aria-hidden="true" /></Button>
          )}
          {!canEditUsers &&
          !canDeactivateUsers &&
          !(canManageSiteAccess && user.role === 'MODULE_USER') ? (
            <span className="text-xs text-gray-500 dark:text-gray-400">View only</span>
          ) : null}
        </div>
      ),
    }
  ];

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-700 overflow-hidden">
      <DataTable<DisplayUser>
        data={users}
        columns={displayUserColumns}
        keyExtractor={(user) => user.id}
        loading={isLoading}
        selectable
        selectedRows={selectedUsers}
        onSelectionChange={onSelectionChange}
        emptyIcon={<Users className="w-12 h-12" />}
        emptyMessage={
          <>
            <h3 className="font-medium text-gray-900 dark:text-gray-100">
              {totalUsersInPage === 0 ? 'No users yet' : 'No users found'}
            </h3>
            <p className="mt-1 text-gray-500 dark:text-gray-400">
              {totalUsersInPage === 0
                ? 'Add users to your tenant to get started.'
                : 'Try adjusting your search or filter criteria.'}
            </p>
          </>
        }
        searchable={false}
        sortable={false}
        stickyHeader={false}
      />

      {/* Pagination -- FIX (MED-07): next disabled when rawPageCount < pageSize */}
      <div className="px-6 py-4 border-t border-gray-100 dark:border-gray-700 flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Showing {users.length} users (page {pagination.page + 1})
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" disabled={pagination.page === 0} onClick={() => onPageChange(pagination.page - 1)}>Previous</Button>
          <Button variant="ghost" size="sm" disabled={pagination.rawPageCount < pagination.pageSize} onClick={() => onPageChange(pagination.page + 1)}>Next</Button>
        </div>
      </div>
    </div>
  );
};
