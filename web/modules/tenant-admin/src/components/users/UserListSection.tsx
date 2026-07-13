import React from 'react';
import { Users, Edit, Trash2, UserCheck, LockOpen, ShieldCheck } from 'lucide-react';
import { UserAvatar } from '../ui/UserAvatar';
import { RoleBadge } from '../ui/RoleBadge';
import { StatusBadge } from '../ui/StatusBadge';

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
  onSelectUser: (userId: string) => void;
  selectedUsers: string[];
  onToggleAll: () => void;
  onEditUser: (user: DisplayUser) => void;
  onDeleteUser: (user: DisplayUser) => void;
  onActivateUser: (user: DisplayUser) => void;
  onUnlockUser: (user: DisplayUser) => void;
  onViewPermissions: (user: DisplayUser) => void;
  canManageUsers: boolean;
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
  onSelectUser,
  selectedUsers,
  onToggleAll,
  onEditUser,
  onDeleteUser,
  onActivateUser,
  onUnlockUser,
  onViewPermissions,
  canManageUsers,
  totalUsersInPage,
}) => {
  return (
    <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-100">
              <th className="px-6 py-3 text-left">
                <input
                  type="checkbox"
                  checked={selectedUsers.length === users.length && users.length > 0}
                  onChange={onToggleAll}
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
            {users.map((user) => (
              <tr key={user.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-6 py-4">
                  <input
                    type="checkbox"
                    checked={selectedUsers.includes(user.id)}
                    onChange={() => onSelectUser(user.id)}
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
                    {canManageUsers ? (
                      <>
                        <button
                          onClick={() => onEditUser(user)}
                          className="p-1.5 rounded-lg text-gray-500 hover:text-tenant-600 hover:bg-tenant-50 transition-colors"
                          title="Edit user"
                        >
                          <Edit className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => onDeleteUser(user)}
                          className="p-1.5 rounded-lg text-gray-500 hover:text-red-600 hover:bg-red-50 transition-colors"
                          title="Delete user"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                        {user.status === 'inactive' && (
                          <button
                            onClick={() => onActivateUser(user)}
                            className="p-1.5 rounded-lg text-gray-500 hover:text-green-600 hover:bg-green-50 transition-colors"
                            title="Activate user"
                          >
                            <UserCheck className="w-4 h-4" />
                          </button>
                        )}
                        {user.isLocked && (
                          <button
                            onClick={() => onUnlockUser(user)}
                            className="p-1.5 rounded-lg text-gray-500 hover:text-amber-600 hover:bg-amber-50 transition-colors"
                            title="Unlock user"
                          >
                            <LockOpen className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          onClick={() => onViewPermissions(user)}
                          className="p-1.5 rounded-lg text-gray-500 hover:text-tenant-600 hover:bg-tenant-50 transition-colors"
                          title="Effective permissions"
                        >
                          <ShieldCheck className="w-4 h-4" />
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
      {users.length === 0 && !isLoading && (
        <div className="py-12 text-center">
          <Users className="w-12 h-12 text-gray-500 mx-auto" />
          <h3 className="mt-4 text-sm font-medium text-gray-900">
            {totalUsersInPage === 0 ? 'No users yet' : 'No users found'}
          </h3>
          <p className="mt-1 text-sm text-gray-500">
            {totalUsersInPage === 0
              ? 'Add users to your tenant to get started.'
              : 'Try adjusting your search or filter criteria.'}
          </p>
        </div>
      )}

      {/* Pagination -- FIX (MED-07): next disabled when rawPageCount < pageSize */}
      <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Showing {users.length} users (page {pagination.page + 1})
        </p>
        <div className="flex items-center gap-2">
          <button
            className="px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
            disabled={pagination.page === 0}
            onClick={() => onPageChange(pagination.page - 1)}
          >
            Previous
          </button>
          <button
            className="px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
            disabled={pagination.rawPageCount < pagination.pageSize}
            onClick={() => onPageChange(pagination.page + 1)}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
};
