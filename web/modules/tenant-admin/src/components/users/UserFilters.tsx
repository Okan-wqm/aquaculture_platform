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
 */
export const UserFilters: React.FC<UserFiltersProps> = ({
  onSearchChange,
  onStatusChange,
  onRoleChange,
  currentFilters,
}) => {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4">
      <div className="flex flex-col md:flex-row md:items-center gap-4">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            placeholder="Search users by name or email..."
            value={currentFilters.search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full pl-10 pr-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-hidden focus:ring-2 focus:ring-tenant-500 focus:border-transparent"
          />
        </div>
        <select
          value={currentFilters.role}
          onChange={(e) => onRoleChange(e.target.value)}
          className="px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-hidden focus:ring-2 focus:ring-tenant-500"
        >
          <option value="all">All Roles</option>
          <option value="TENANT_ADMIN">Tenant Admin</option>
          <option value="MODULE_MANAGER">Module Manager</option>
          <option value="MODULE_USER">Module User</option>
        </select>
        <select
          value={currentFilters.status}
          onChange={(e) => onStatusChange(e.target.value)}
          className="px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-hidden focus:ring-2 focus:ring-tenant-500"
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
