import React from 'react';
import { Select } from '@aquaculture/shared-ui';
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
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-700 p-4">
      <div className="flex flex-col md:flex-row md:items-center gap-4">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 dark:text-gray-400" />
          <input
            type="text"
            placeholder="Search users by name or email..."
            value={currentFilters.search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full pl-10 pr-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm focus:outline-hidden focus:ring-2 focus:ring-green-500 focus:border-transparent"
          />
        </div>
        <Select options={[{ value: 'all', label: 'All Roles' }, { value: 'TENANT_ADMIN', label: 'Tenant Admin' }, { value: 'MODULE_MANAGER', label: 'Module Manager' }, { value: 'MODULE_USER', label: 'Module User' }]} value={currentFilters.role} onChange={(e) => onRoleChange(e.target.value)} />
        <Select options={[{ value: 'all', label: 'All Status' }, { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'pending', label: 'Pending' }]} value={currentFilters.status} onChange={(e) => onStatusChange(e.target.value)} />
      </div>
    </div>
  );
};
