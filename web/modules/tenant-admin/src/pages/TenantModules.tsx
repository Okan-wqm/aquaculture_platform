import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Package,
  Users,
  CheckCircle,
  XCircle,
  Clock,
  Search,
  UserPlus,
  Shield,
  MoreVertical,
  ExternalLink,
  BarChart3,
  Calendar,
  RefreshCw,
} from 'lucide-react';
import { useAuthContext } from '@aquaculture/shared-ui';

// Note: TenantModule interface removed - now using AuthContext UserModule type

/**
 * Module for display
 */
interface DisplayModule {
  id: string;
  code: string;
  name: string;
  description: string;
  status: 'active' | 'inactive' | 'pending';
  assignedUsers: number;
  manager?: {
    id: string;
    name: string;
    email: string;
  };
  lastActivity: string;
  features: string[];
  icon: string;
  route?: string;
  activatedAt: string;
}

/**
 * Module route mapping - correct dashboard routes
 */
const moduleRouteMap: Record<string, string> = {
  'farm': '/farm/dashboard',
  'sensor': '/sensor/dashboard',
  'hr': '/hr/dashboard',
};

/**
 * Module icon mapping
 */
const moduleIconMap: Record<string, string> = {
  'farm': '🐟',
  'sensor': '📊',
  'hr': '👥',
};

/**
 * Module features mapping
 */
const moduleFeaturesMap: Record<string, string[]> = {
  'farm': ['Site Management', 'Tank Tracking', 'Batch Management', 'Feeding', 'Growth Monitoring'],
  'sensor': ['Real-time Data', 'Alerts', 'Historical Trends', 'Device Management'],
  'hr': ['Employee Records', 'Attendance', 'Payroll', 'Leave Management'],
};

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

// Note: fetchTenantModules and formatDate removed - now using AuthContext modules

/**
 * Status badge component
 */
const StatusBadge: React.FC<{ status: DisplayModule['status'] }> = ({ status }) => {
  const statusConfig = {
    active: {
      bg: 'bg-green-100',
      text: 'text-green-700',
      icon: <CheckCircle className="w-3 h-3" />,
      label: 'Active',
    },
    inactive: {
      bg: 'bg-gray-100',
      text: 'text-gray-700',
      icon: <XCircle className="w-3 h-3" />,
      label: 'Inactive',
    },
    pending: {
      bg: 'bg-yellow-100',
      text: 'text-yellow-700',
      icon: <Clock className="w-3 h-3" />,
      label: 'Pending Setup',
    },
  };

  const config = statusConfig[status];

  return (
    <span
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${config.bg} ${config.text}`}
    >
      {config.icon}
      {config.label}
    </span>
  );
};

/**
 * Assign Manager Modal Component
 */
const AssignManagerModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  module: DisplayModule | null;
}> = ({ isOpen, onClose, module }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [users, setUsers] = useState<Array<{ id: string; name: string; email: string }>>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadUsers();
    }
  }, [isOpen]);

  const loadUsers = async () => {
    setLoading(true);
    try {
      const TENANT_USERS_QUERY = `
        query TenantUsers {
          tenantUsers {
            id
            email
            firstName
            lastName
          }
        }
      `;

      const data = await executeGraphQL<{ tenantUsers: Array<{
        id: string;
        email: string;
        firstName?: string;
        lastName?: string;
      }> }>(TENANT_USERS_QUERY);

      const userList = (data.tenantUsers || []).map((u) => ({
        id: u.id,
        name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email,
        email: u.email,
      }));
      setUsers(userList);
    } catch (err) {
      console.error('Failed to load users:', err);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen || !module) return null;

  const filteredUsers = users.filter(
    (user) =>
      user.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      user.email.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative min-h-screen flex items-center justify-center p-4">
        <div className="relative w-full max-w-md bg-white rounded-xl shadow-xl">
          <div className="px-6 py-4 border-b border-gray-100">
            <h3 className="text-lg font-semibold text-gray-900">
              Assign Module Manager
            </h3>
            <p className="text-sm text-gray-500 mt-1">
              Select a user to manage "{module.name}"
            </p>
          </div>

          <div className="px-6 py-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search users..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500 focus:border-transparent"
              />
            </div>
          </div>

          <div className="px-6 pb-4 max-h-64 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <RefreshCw className="w-6 h-6 animate-spin text-gray-400" />
              </div>
            ) : (
              <div className="space-y-2">
                {filteredUsers.map((user) => (
                  <button
                    key={user.id}
                    className="w-full flex items-center gap-3 p-3 rounded-lg hover:bg-tenant-50 transition-colors text-left"
                  >
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-tenant-500 to-tenant-700 flex items-center justify-center text-white text-sm font-medium">
                      {user.name
                        .split(' ')
                        .map((n) => n[0])
                        .join('')
                        .substring(0, 2)
                        .toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {user.name}
                      </p>
                      <p className="text-xs text-gray-500 truncate">{user.email}</p>
                    </div>
                    <Shield className="w-4 h-4 text-gray-400" />
                  </button>
                ))}
                {filteredUsers.length === 0 && !loading && (
                  <p className="text-center text-sm text-gray-500 py-4">
                    No users found
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Module Details Modal Component
 */
const ModuleDetailsModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  module: DisplayModule | null;
}> = ({ isOpen, onClose, module }) => {
  if (!isOpen || !module) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative min-h-screen flex items-center justify-center p-4">
        <div className="relative w-full max-w-lg bg-white rounded-xl shadow-xl">
          {/* Header */}
          <div className="px-6 py-4 border-b border-gray-100">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-tenant-50 flex items-center justify-center text-2xl">
                {module.icon}
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">
                  {module.name}
                </h3>
                <span className="text-sm text-gray-500">{module.code}</span>
              </div>
            </div>
          </div>

          {/* Content */}
          <div className="px-6 py-4 space-y-4">
            {/* Description */}
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-1">Description</h4>
              <p className="text-sm text-gray-600">{module.description}</p>
            </div>

            {/* Status */}
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-1">Status</h4>
              <div className="flex items-center gap-2">
                {module.status === 'active' ? (
                  <CheckCircle className="w-4 h-4 text-green-500" />
                ) : (
                  <XCircle className="w-4 h-4 text-gray-400" />
                )}
                <span className={`text-sm ${module.status === 'active' ? 'text-green-600' : 'text-gray-500'}`}>
                  {module.status === 'active' ? 'Active' : 'Inactive'}
                </span>
              </div>
            </div>

            {/* Features */}
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-2">Features</h4>
              <div className="grid grid-cols-2 gap-2">
                {module.features.map((feature, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-2 p-2 rounded-lg bg-gray-50"
                  >
                    <CheckCircle className="w-4 h-4 text-tenant-500" />
                    <span className="text-sm text-gray-700">{feature}</span>
                  </div>
                ))}
              </div>
              {module.features.length === 0 && (
                <p className="text-sm text-gray-400 italic">No features listed</p>
              )}
            </div>

            {/* Route Info */}
            {module.route && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-1">Dashboard Route</h4>
                <code className="text-sm bg-gray-100 px-2 py-1 rounded text-gray-600">
                  {module.route}
                </code>
              </div>
            )}

            {/* Manager Info */}
            {module.manager && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-1">Module Manager</h4>
                <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-tenant-500 to-tenant-700 flex items-center justify-center text-white text-sm font-medium">
                    {module.manager.name
                      .split(' ')
                      .map((n) => n[0])
                      .join('')
                      .substring(0, 2)
                      .toUpperCase()}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{module.manager.name}</p>
                    <p className="text-xs text-gray-500">{module.manager.email}</p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-gray-100 flex justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * TenantModules Page
 *
 * Uses AuthContext modules (from login) as the source of truth.
 * This is more reliable than myModules GraphQL query.
 */
const TenantModules: React.FC = () => {
  const navigate = useNavigate();
  const { modules: authModules, isLoading: authLoading, refreshAuth } = useAuthContext();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [detailsModalOpen, setDetailsModalOpen] = useState(false);
  const [selectedModule, setSelectedModule] = useState<DisplayModule | null>(null);

  // Transform AuthContext modules to DisplayModule format
  const modules = useMemo<DisplayModule[]>(() => {
    console.log('[TenantModules] AuthContext modules:', authModules);

    if (!authModules || authModules.length === 0) {
      console.log('[TenantModules] No modules from AuthContext');
      return [];
    }

    const displayModules = authModules.map((m) => {
      const code = m.code || '';
      return {
        id: `module-${code}`,
        code: code,
        name: m.name || code.charAt(0).toUpperCase() + code.slice(1),
        description: `${m.name || code} module for your tenant`,
        status: 'active' as const, // AuthContext only returns enabled modules
        assignedUsers: 0,
        manager: undefined,
        lastActivity: 'Recently',
        features: moduleFeaturesMap[code] || [],
        icon: moduleIconMap[code] || '📦',
        route: m.defaultRoute || moduleRouteMap[code],
        activatedAt: new Date().toISOString(),
      };
    });

    console.log('[TenantModules] Transformed displayModules:', displayModules);
    return displayModules;
  }, [authModules]);

  const loading = authLoading;

  // Filter modules
  const filteredModules = modules.filter((module) => {
    const matchesSearch = module.name
      .toLowerCase()
      .includes(searchQuery.toLowerCase());
    const matchesStatus =
      statusFilter === 'all' || module.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const handleAssignManager = (module: DisplayModule) => {
    setSelectedModule(module);
    setAssignModalOpen(true);
  };

  const handleViewDetails = (module: DisplayModule) => {
    setSelectedModule(module);
    setDetailsModalOpen(true);
  };

  const handleOpenModule = (module: DisplayModule) => {
    const route = module.route || moduleRouteMap[module.code];
    if (route && module.status === 'active') {
      navigate(route);
    }
  };

  const getModuleRoute = (module: DisplayModule): string | undefined => {
    return module.route || moduleRouteMap[module.code];
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
          <h1 className="text-2xl font-bold text-gray-900">Modules</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage your tenant's modules and assign managers
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => refreshAuth()}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-5 h-5 text-gray-500" />
          </button>
          <span className="px-3 py-1.5 rounded-lg bg-tenant-50 text-tenant-700 text-sm font-medium">
            {modules.filter((m) => m.status === 'active').length} Active
          </span>
        </div>
      </div>

      {/* Note: Error handling now via AuthContext */}

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-100 p-4">
        <div className="flex flex-col md:flex-row md:items-center gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search modules..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500 focus:border-transparent"
            />
          </div>

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

      {/* Modules Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {filteredModules.map((module) => (
          <div
            key={module.id}
            className="bg-white rounded-xl border border-gray-100 overflow-hidden hover:shadow-lg transition-shadow"
          >
            {/* Module Header */}
            <div className="p-6 border-b border-gray-100">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-tenant-50 flex items-center justify-center text-2xl">
                    {module.icon}
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900">{module.name}</h3>
                    <StatusBadge status={module.status} />
                  </div>
                </div>
                <button className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
                  <MoreVertical className="w-4 h-4" />
                </button>
              </div>
              <p className="text-sm text-gray-500 mt-3 line-clamp-2">
                {module.description}
              </p>
            </div>

            {/* Module Stats */}
            <div className="px-6 py-4 bg-gray-50 grid grid-cols-2 gap-4">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-gray-400" />
                <span className="text-sm text-gray-600">
                  {module.assignedUsers} users
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-gray-400" />
                <span className="text-sm text-gray-500 truncate">
                  {module.lastActivity}
                </span>
              </div>
            </div>

            {/* Manager Section */}
            <div className="p-4 border-t border-gray-100">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Shield className="w-4 h-4 text-gray-400" />
                  <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Module Manager
                  </span>
                </div>
              </div>

              {module.manager ? (
                <div className="flex items-center justify-between mt-3">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-tenant-500 to-tenant-700 flex items-center justify-center text-white text-xs font-medium">
                      {module.manager.name
                        .split(' ')
                        .map((n) => n[0])
                        .join('')
                        .substring(0, 2)
                        .toUpperCase()}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {module.manager.name}
                      </p>
                      <p className="text-xs text-gray-500">
                        {module.manager.email}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleAssignManager(module)}
                    className="text-xs text-tenant-600 hover:text-tenant-700 font-medium"
                  >
                    Change
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => handleAssignManager(module)}
                  className="mt-3 w-full flex items-center justify-center gap-2 py-2 rounded-lg border-2 border-dashed border-gray-200 text-sm text-gray-500 hover:border-tenant-300 hover:text-tenant-600 transition-colors"
                >
                  <UserPlus className="w-4 h-4" />
                  Assign Manager
                </button>
              )}
            </div>

            {/* Features */}
            <div className="px-4 pb-4">
              <div className="flex flex-wrap gap-1">
                {module.features.slice(0, 3).map((feature, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600"
                  >
                    {feature}
                  </span>
                ))}
                {module.features.length > 3 && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-500">
                    +{module.features.length - 3}
                  </span>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="px-4 pb-4 flex items-center gap-2">
              <button
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-tenant-600 bg-tenant-50 rounded-lg hover:bg-tenant-100 transition-colors"
                onClick={() => handleViewDetails(module)}
              >
                <BarChart3 className="w-4 h-4" />
                View Details
              </button>
              {getModuleRoute(module) && module.status === 'active' && (
                <button
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-tenant-600 rounded-lg hover:bg-tenant-700 transition-colors"
                  onClick={() => handleOpenModule(module)}
                  title={`${module.name} Dashboard'a git`}
                >
                  <ExternalLink className="w-4 h-4" />
                </button>
              )}
              {(!getModuleRoute(module) || module.status !== 'active') && (
                <button
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-gray-400 bg-gray-100 rounded-lg cursor-not-allowed"
                  disabled
                  title={module.status !== 'active' ? 'Module is not active' : 'Dashboard not available'}
                >
                  <ExternalLink className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Empty State */}
      {filteredModules.length === 0 && !loading && (
        <div className="bg-white rounded-xl border border-gray-100 py-12 text-center">
          <Package className="w-12 h-12 text-gray-300 mx-auto" />
          <h3 className="mt-4 text-sm font-medium text-gray-900">
            {modules.length === 0 ? 'No modules assigned' : 'No modules found'}
          </h3>
          <p className="mt-1 text-sm text-gray-500">
            {modules.length === 0
              ? 'Contact your administrator to get modules assigned to your tenant.'
              : 'Try adjusting your search or filter criteria.'}
          </p>
        </div>
      )}

      {/* Assign Manager Modal */}
      <AssignManagerModal
        isOpen={assignModalOpen}
        onClose={() => setAssignModalOpen(false)}
        module={selectedModule}
      />

      {/* Module Details Modal */}
      <ModuleDetailsModal
        isOpen={detailsModalOpen}
        onClose={() => setDetailsModalOpen(false)}
        module={selectedModule}
      />
    </div>
  );
};

export default TenantModules;
