import React, { useState, useEffect } from 'react';
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
} from 'lucide-react';

// GraphQL Configuration - Gateway API
const GRAPHQL_URL = '/graphql';

/**
 * Get auth token from localStorage
 */
const getAuthToken = (): string | null => {
  return localStorage.getItem('access_token');
};

/**
 * GraphQL query executor
 */
const executeGraphQL = async <T,>(query: string, variables?: Record<string, unknown>): Promise<T> => {
  const token = getAuthToken();

  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();

  if (result.errors) {
    throw new Error(result.errors[0]?.message || 'GraphQL error');
  }

  return result.data;
};

/**
 * Format relative time
 */
function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 5) return 'Just now';
  if (diffMins < 60) return `${diffMins} minutes ago`;
  if (diffHours < 24) return `${diffHours} hours ago`;
  if (diffDays < 30) return `${diffDays} days ago`;
  return date.toLocaleDateString('tr-TR');
}

/**
 * API User type
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
    SUPER_ADMIN: {
      bg: 'bg-red-100',
      text: 'text-red-700',
      label: 'Super Admin',
    },
    TENANT_ADMIN: {
      bg: 'bg-purple-100',
      text: 'text-purple-700',
      label: 'Tenant Admin',
    },
    MODULE_MANAGER: {
      bg: 'bg-blue-100',
      text: 'text-blue-700',
      label: 'Module Manager',
    },
    MODULE_USER: {
      bg: 'bg-gray-100',
      text: 'text-gray-700',
      label: 'Module User',
    },
  };

  const config = roleConfig[role] || roleConfig.MODULE_USER;

  return (
    <span
      className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${config.bg} ${config.text}`}
    >
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
    active: {
      bg: 'bg-green-100',
      text: 'text-green-700',
      icon: <CheckCircle className="w-3 h-3" />,
    },
    inactive: {
      bg: 'bg-gray-100',
      text: 'text-gray-700',
      icon: <XCircle className="w-3 h-3" />,
    },
    pending: {
      bg: 'bg-yellow-100',
      text: 'text-yellow-700',
      icon: <Clock className="w-3 h-3" />,
    },
  };

  const config = statusConfig[status];

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${config.bg} ${config.text}`}
    >
      {config.icon}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
};

/**
 * User avatar component
 */
const UserAvatar: React.FC<{ name: string; size?: 'sm' | 'md' | 'lg' }> = ({
  name,
  size = 'md',
}) => {
  const initials = name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const sizeClasses = {
    sm: 'w-8 h-8 text-xs',
    md: 'w-10 h-10 text-sm',
    lg: 'w-12 h-12 text-base',
  };

  return (
    <div
      className={`${sizeClasses[size]} rounded-full bg-gradient-to-br from-tenant-500 to-tenant-700 flex items-center justify-center text-white font-medium`}
    >
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
    modules: [], // Would need separate API call to get module assignments
    lastLogin: formatRelativeTime(apiUser.lastLoginAt || null),
    createdAt: apiUser.createdAt,
  };
}

/**
 * TenantUsers Page
 */
const TenantUsers: React.FC = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    setLoading(true);
    setError(null);

    const token = getAuthToken();

    if (!token) {
      setError('Authentication required');
      setLoading(false);
      return;
    }

    try {
      const TENANT_USERS_QUERY = `
        query TenantUsers {
          tenantUsers {
            id
            email
            firstName
            lastName
            role
            isActive
            isEmailVerified
            lastLoginAt
            createdAt
          }
        }
      `;

      const data = await executeGraphQL<{ tenantUsers: ApiUser[] }>(TENANT_USERS_QUERY);
      const apiUsers = data.tenantUsers || [];
      const transformedUsers = apiUsers.map(transformUser);
      setUsers(transformedUsers);
    } catch (err) {
      console.error('Failed to load users:', err);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Filter users based on search and filters
  const filteredUsers = users.filter((user) => {
    const matchesSearch =
      user.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      user.email.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesRole = roleFilter === 'all' || user.role === roleFilter;
    const matchesStatus = statusFilter === 'all' || user.status === statusFilter;
    return matchesSearch && matchesRole && matchesStatus;
  });

  // Toggle user selection
  const toggleUserSelection = (userId: string) => {
    setSelectedUsers((prev) =>
      prev.includes(userId)
        ? prev.filter((id) => id !== userId)
        : [...prev, userId]
    );
  };

  // Toggle all users selection
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
          <p className="text-sm text-gray-500 mt-1">
            Manage users and their access to modules
          </p>
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
          <button className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-tenant-600 rounded-lg hover:bg-tenant-700 transition-colors">
            <UserPlus className="w-4 h-4" />
            Add User
          </button>
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
          <button
            onClick={loadUsers}
            className="ml-auto px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-100 rounded-lg transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Filters and Search */}
      <div className="bg-white rounded-xl border border-gray-100 p-4">
        <div className="flex flex-col md:flex-row md:items-center gap-4">
          {/* Search */}
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search users by name or email..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500 focus:border-transparent"
            />
          </div>

          {/* Role Filter */}
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            className="px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500"
          >
            <option value="all">All Roles</option>
            <option value="TENANT_ADMIN">Tenant Admin</option>
            <option value="MODULE_MANAGER">Module Manager</option>
            <option value="MODULE_USER">Module User</option>
          </select>

          {/* Status Filter */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500"
          >
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="pending">Pending</option>
          </select>
        </div>
      </div>

      {/* Bulk Actions */}
      {selectedUsers.length > 0 && (
        <div className="bg-tenant-50 rounded-xl p-4 flex items-center justify-between">
          <span className="text-sm text-tenant-700">
            {selectedUsers.length} user(s) selected
          </span>
          <div className="flex items-center gap-2">
            <button className="px-3 py-1.5 text-sm text-tenant-700 hover:bg-tenant-100 rounded-lg transition-colors">
              Deactivate
            </button>
            <button className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors">
              Delete
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
                    checked={
                      selectedUsers.length === filteredUsers.length &&
                      filteredUsers.length > 0
                    }
                    onChange={toggleAllSelection}
                    className="rounded border-gray-300 text-tenant-600 focus:ring-tenant-500"
                  />
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  User
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Role
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Last Login
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredUsers.map((user) => (
                <tr
                  key={user.id}
                  className="hover:bg-gray-50 transition-colors"
                >
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
                        <p className="text-sm font-medium text-gray-900">
                          {user.name}
                        </p>
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
                      <button
                        className="p-1.5 rounded-lg text-gray-400 hover:text-tenant-600 hover:bg-tenant-50 transition-colors"
                        title="Edit user"
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      <button
                        className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                        title="Delete user"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                      <button
                        className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                        title="More options"
                      >
                        <MoreVertical className="w-4 h-4" />
                      </button>
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
            <Users className="w-12 h-12 text-gray-300 mx-auto" />
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
            Showing {filteredUsers.length} of {users.length} users
          </p>
          <div className="flex items-center gap-2">
            <button className="px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50" disabled>
              Previous
            </button>
            <button className="px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50" disabled>
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TenantUsers;
