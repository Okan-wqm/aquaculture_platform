import React from 'react';
import { Users, Edit, Trash2, MapPin } from 'lucide-react';
import { UserAvatar } from '../ui/UserAvatar';
import { RoleBadge } from '../ui/RoleBadge';
import { StatusBadge } from '../ui/StatusBadge';

export interface DisplayUser {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
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
  onManageSiteAccess: (user: DisplayUser) => void;
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
 * SUDERRA restyle — sd-table primitives from the shell stylesheet; markup
 * stays a real <table> and every label/aria/handler is unchanged.
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
  onManageSiteAccess,
  canEditUsers,
  canDeactivateUsers,
  canManageSiteAccess,
  totalUsersInPage,
}) => {
  return (
    <div className="sd-card sd-card--flush">
      <div className="overflow-x-auto">
        <table className="sd-table">
          <thead>
            <tr>
              <th style={{ width: 40 }}>
                <input
                  type="checkbox"
                  checked={selectedUsers.length === users.length && users.length > 0}
                  onChange={onToggleAll}
                  aria-label="Select all users"
                />
              </th>
              <th>User</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last Login</th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={selectedUsers.includes(user.id)}
                    onChange={() => onSelectUser(user.id)}
                    aria-label={`Select ${user.name}`}
                  />
                </td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                    <UserAvatar name={user.name} size="sm" />
                    <div style={{ minWidth: 0 }}>
                      <span className="sd-rowname" style={{ display: 'block' }}>{user.name}</span>
                      <span className="sd-rowemail" style={{ display: 'block' }}>{user.email}</span>
                    </div>
                  </div>
                </td>
                <td>
                  <RoleBadge role={user.role} />
                </td>
                <td>
                  <StatusBadge status={user.status} />
                </td>
                <td>
                  <span className="sd-celltime">{user.lastLogin}</span>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                    {canEditUsers && (
                      <button
                        type="button"
                        onClick={() => onEditUser(user)}
                        aria-label={`Edit ${user.name}`}
                        className="sd-iconbtn"
                        title="Edit user"
                      >
                        <Edit size={15} aria-hidden="true" />
                      </button>
                    )}
                    {canManageSiteAccess && user.role === 'MODULE_USER' && (
                      <button
                        type="button"
                        onClick={() => onManageSiteAccess(user)}
                        aria-label={`Manage site access for ${user.name}`}
                        className="sd-iconbtn"
                        title="Manage site access"
                      >
                        <MapPin size={15} aria-hidden="true" />
                      </button>
                    )}
                    {canDeactivateUsers && (
                      <button
                        type="button"
                        onClick={() => onDeleteUser(user)}
                        aria-label={`Delete ${user.name}`}
                        className="sd-iconbtn sd-iconbtn--danger"
                        title="Delete user"
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    )}
                    {!canEditUsers &&
                    !canDeactivateUsers &&
                    !(canManageSiteAccess && user.role === 'MODULE_USER') ? (
                      <span className="sd-celltime">View only</span>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Empty State */}
      {users.length === 0 && !isLoading && (
        <div className="sd-empty" style={{ padding: '44px 18px' }}>
          <Users size={30} style={{ color: '#8aa0aa', marginBottom: 10 }} aria-hidden="true" />
          <strong style={{ display: 'block', marginBottom: 4 }}>
            {totalUsersInPage === 0 ? 'No users yet' : 'No users found'}
          </strong>
          {totalUsersInPage === 0
            ? 'Add users to your tenant to get started.'
            : 'Try adjusting your search or filter criteria.'}
        </div>
      )}

      {/* Pagination -- FIX (MED-07): next disabled when rawPageCount < pageSize */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          padding: '12px 16px',
          borderTop: '1px solid rgba(10,31,43,.09)',
        }}
      >
        <p style={{ margin: 0, fontSize: 12.5, color: '#5c7783' }}>
          Showing {users.length} users (page {pagination.page + 1})
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            className="sd-pagebtn"
            disabled={pagination.page === 0}
            onClick={() => onPageChange(pagination.page - 1)}
          >
            Previous
          </button>
          <button
            className="sd-pagebtn"
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
