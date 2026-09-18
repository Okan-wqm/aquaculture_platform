import React from 'react';
import { Search } from 'lucide-react';

export interface UserFiltersProps {
  onSearchChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  onRoleChange: (value: string) => void;
  currentFilters: {
    search: string;
    status: string;
    role: string;
  };
}

/**
 * Filter bar for user list: search input, role dropdown, status dropdown.
 * SUDERRA restyle — sd-toolbar/sd-search/sd-select primitives from the shell
 * stylesheet; behavior (props, values, option keys) unchanged.
 *
 * MOCK-ADJACENT: the role dropdown lists only the three SYSTEM roles
 * (TENANT_ADMIN / MODULE_MANAGER / MODULE_USER) because the users query
 * filters by that enum — tenant CUSTOM roles are not filterable server-side
 * yet. Wire the dropdown to useTenantRoles() when the backend accepts a
 * custom roleId filter.
 */
export const UserFilters: React.FC<UserFiltersProps> = ({
  onSearchChange,
  onStatusChange,
  onRoleChange,
  currentFilters,
}) => {
  return (
    <div className="sd-card" style={{ padding: '13px 15px' }}>
      <div className="sd-toolbar">
        <div className="sd-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="text"
            className="sd-input"
            placeholder="Search users by name or email…"
            value={currentFilters.search}
            onChange={(e) => onSearchChange(e.target.value)}
            aria-label="Search users"
          />
        </div>
        <select
          className="sd-select"
          style={{ flex: '0 1 170px' }}
          value={currentFilters.role}
          onChange={(e) => onRoleChange(e.target.value)}
          aria-label="Filter by role"
        >
          <option value="all">All Roles</option>
          <option value="TENANT_ADMIN">Tenant Admin</option>
          <option value="MODULE_MANAGER">Module Manager</option>
          <option value="MODULE_USER">Module User</option>
        </select>
        <select
          className="sd-select"
          style={{ flex: '0 1 160px' }}
          value={currentFilters.status}
          onChange={(e) => onStatusChange(e.target.value)}
          aria-label="Filter by status"
        >
          <option value="all">All Status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="pending">Pending</option>
        </select>
      </div>
    </div>
  );
};
