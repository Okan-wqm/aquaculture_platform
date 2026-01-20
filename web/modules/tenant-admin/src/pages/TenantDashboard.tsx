import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Users,
  Package,
  Activity,
  TrendingUp,
  AlertCircle,
  CheckCircle,
  Clock,
  ArrowUpRight,
  MoreVertical,
  RefreshCw,
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
 * Stat card data type
 */
interface StatCard {
  id: string;
  title: string;
  value: string | number;
  change?: number;
  changeLabel?: string;
  icon: React.ReactNode;
  color: 'green' | 'blue' | 'yellow' | 'purple';
}

/**
 * Module status type
 */
interface ModuleStatus {
  id: string;
  name: string;
  code: string;
  status: 'active' | 'inactive' | 'pending';
  users: number;
  lastActivity: string;
  icon: string;
}

/**
 * Recent activity type
 */
interface RecentActivity {
  id: string;
  type: 'user_added' | 'module_assigned' | 'setting_changed' | 'login';
  description: string;
  timestamp: string;
  user: string;
}

/**
 * API Response types
 */
interface User {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
  isActive: boolean;
  lastLoginAt?: string;
}

/**
 * Subscription info from GraphQL
 */
interface SubscriptionInfo {
  id: string;
  status: 'trial' | 'active' | 'past_due' | 'cancelled' | 'suspended' | 'expired';
  planTier: string;
  planName: string;
  billingCycle: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEndDate?: string;
  pricing: {
    basePrice: number;
    currency: string;
  };
  moduleItems?: Array<{
    moduleId: string;
    moduleCode: string;
    moduleName: string;
    monthlyPrice: number;
  }>;
}

/**
 * Module icon mapping
 */
const moduleIconMap: Record<string, string> = {
  'farm': '🐟',
  'sensor': '📊',
  'hr': '👥',
};

/**
 * Color mapping for stat cards
 */
const colorClasses = {
  green: {
    bg: 'bg-tenant-50',
    icon: 'bg-tenant-100 text-tenant-600',
    text: 'text-tenant-600',
  },
  blue: {
    bg: 'bg-blue-50',
    icon: 'bg-blue-100 text-blue-600',
    text: 'text-blue-600',
  },
  yellow: {
    bg: 'bg-amber-50',
    icon: 'bg-amber-100 text-amber-600',
    text: 'text-amber-600',
  },
  purple: {
    bg: 'bg-purple-50',
    icon: 'bg-purple-100 text-purple-600',
    text: 'text-purple-600',
  },
};

/**
 * Format date to relative time
 */
function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 5) return 'Just now';
  if (diffMins < 60) return `${diffMins} minutes ago`;
  if (diffHours < 24) return `${diffHours} hours ago`;
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString('tr-TR');
}

/**
 * Status badge component
 */
const StatusBadge: React.FC<{ status: ModuleStatus['status'] }> = ({
  status,
}) => {
  const statusConfig = {
    active: {
      bg: 'bg-green-100',
      text: 'text-green-700',
      icon: <CheckCircle className="w-3 h-3" />,
    },
    inactive: {
      bg: 'bg-gray-100',
      text: 'text-gray-700',
      icon: <Clock className="w-3 h-3" />,
    },
    pending: {
      bg: 'bg-yellow-100',
      text: 'text-yellow-700',
      icon: <AlertCircle className="w-3 h-3" />,
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
 * TenantDashboard Page
 */
const TenantDashboard: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modules, setModules] = useState<ModuleStatus[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [activities, setActivities] = useState<RecentActivity[]>([]);
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);

  useEffect(() => {
    loadDashboardData();
  }, []);

  const loadDashboardData = async () => {
    setLoading(true);
    setError(null);

    const token = getAuthToken();

    if (!token) {
      setError('Authentication required');
      setLoading(false);
      return;
    }

    try {
      // GraphQL queries for tenant admin
      const MY_MODULES_QUERY = `
        query MyModules {
          myModules {
            id
            moduleId
            name
            description
            icon
            color
            isEnabled
            defaultRoute
          }
        }
      `;

      const TENANT_USERS_QUERY = `
        query TenantUsers {
          tenantUsers {
            id
            email
            firstName
            lastName
            role
            isActive
            lastLoginAt
            createdAt
          }
        }
      `;

      // Query for subscription info
      const MY_SUBSCRIPTION_QUERY = `
        query MySubscription {
          subscription {
            id
            status
            planTier
            planName
            billingCycle
            currentPeriodStart
            currentPeriodEnd
            trialEndDate
            pricing {
              basePrice
              currency
            }
            moduleItems {
              moduleId
              moduleCode
              moduleName
              monthlyPrice
            }
          }
        }
      `;

      // Fetch modules, users, and subscription in parallel via GraphQL
      const [modulesData, usersData, subscriptionData] = await Promise.all([
        executeGraphQL<{ myModules: Array<{
          id: string;
          moduleId: string;
          name: string;
          description?: string;
          icon?: string;
          color?: string;
          isEnabled: boolean;
          defaultRoute?: string;
        }> }>(MY_MODULES_QUERY),
        executeGraphQL<{ tenantUsers: User[] }>(TENANT_USERS_QUERY),
        executeGraphQL<{ subscription: SubscriptionInfo | null }>(MY_SUBSCRIPTION_QUERY).catch(() => ({ subscription: null })),
      ]);

      // Process modules
      const modulesList = (modulesData.myModules || []).map((m) => {
        const code = m.name?.toLowerCase().includes('farm') ? 'farm'
          : m.name?.toLowerCase().includes('hr') || m.name?.toLowerCase().includes('insan') ? 'hr'
          : m.name?.toLowerCase().includes('sensor') || m.name?.toLowerCase().includes('sens') ? 'sensor'
          : 'default';
        return {
          id: m.id,
          name: m.name,
          code: code,
          status: m.isEnabled ? 'active' : 'inactive',
          users: 0,
          lastActivity: 'Active',
          icon: moduleIconMap[code] || m.icon || '📦',
        } as ModuleStatus;
      });
      setModules(modulesList);

      // Process users
      const usersList = usersData.tenantUsers || [];
      setUsers(usersList);

      // Generate recent activity from users
      const recentActivities: RecentActivity[] = usersList
        .filter((u: User) => u.lastLoginAt)
        .sort((a: User, b: User) =>
          new Date(b.lastLoginAt || 0).getTime() - new Date(a.lastLoginAt || 0).getTime()
        )
        .slice(0, 5)
        .map((u: User, idx: number) => ({
          id: `activity-${idx}`,
          type: 'login' as const,
          description: `${u.firstName || ''} ${u.lastName || ''} (${u.email}) logged in`,
          timestamp: u.lastLoginAt ? formatRelativeTime(u.lastLoginAt) : 'Unknown',
          user: u.email,
        }));
      setActivities(recentActivities);

      // Set subscription data
      setSubscription(subscriptionData.subscription);

    } catch (err) {
      console.error('Failed to load dashboard data:', err);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Calculate stats
  const activeUsers = users.filter(u => u.isActive).length;
  const totalUsers = users.length;
  const activeModules = modules.filter(m => m.status === 'active').length;
  const totalModules = modules.length;

  const statsData: StatCard[] = [
    {
      id: 'users',
      title: 'Total Users',
      value: totalUsers,
      changeLabel: `${activeUsers} active`,
      icon: <Users className="w-6 h-6" />,
      color: 'green',
    },
    {
      id: 'modules',
      title: 'Active Modules',
      value: activeModules,
      changeLabel: `of ${totalModules} assigned`,
      icon: <Package className="w-6 h-6" />,
      color: 'blue',
    },
    {
      id: 'activity',
      title: 'Active Sessions',
      value: activeUsers,
      changeLabel: 'users online',
      icon: <Activity className="w-6 h-6" />,
      color: 'yellow',
    },
    {
      id: 'growth',
      title: 'This Month',
      value: totalUsers > 0 ? '+' + totalUsers : '0',
      change: totalUsers > 0 ? 100 : 0,
      changeLabel: 'new users',
      icon: <TrendingUp className="w-6 h-6" />,
      color: 'purple',
    },
  ];

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
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">
            Welcome back! Here's what's happening with your tenant.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={loadDashboardData}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-5 h-5 text-gray-500" />
          </button>
          <button
            onClick={() => navigate('/tenant/users')}
            className="px-4 py-2 text-sm font-medium text-white bg-tenant-600 rounded-lg hover:bg-tenant-700 transition-colors"
          >
            Add User
          </button>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-800">Failed to load data</p>
            <p className="text-sm text-red-600">{error}</p>
          </div>
          <button
            onClick={loadDashboardData}
            className="ml-auto px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-100 rounded-lg transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Subscription Banner */}
      {subscription && (
        <div className="bg-gradient-to-r from-tenant-50 via-blue-50 to-purple-50 rounded-xl border border-tenant-200 p-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl bg-tenant-100">
                <Package className="w-6 h-6 text-tenant-600" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-semibold text-gray-900">{subscription.planName}</h3>
                  <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                    subscription.status === 'active' ? 'bg-green-100 text-green-700' :
                    subscription.status === 'trial' ? 'bg-blue-100 text-blue-700' :
                    subscription.status === 'past_due' ? 'bg-red-100 text-red-700' :
                    'bg-gray-100 text-gray-700'
                  }`}>
                    {subscription.status === 'trial' ? 'Trial' :
                     subscription.status === 'active' ? 'Active' :
                     subscription.status === 'past_due' ? 'Past Due' :
                     subscription.status.charAt(0).toUpperCase() + subscription.status.slice(1)}
                  </span>
                </div>
                <p className="text-sm text-gray-500 mt-0.5">
                  {subscription.billingCycle === 'monthly' ? 'Monthly' :
                   subscription.billingCycle === 'quarterly' ? 'Quarterly' :
                   subscription.billingCycle === 'annual' ? 'Annual' : subscription.billingCycle} billing
                </p>
              </div>
            </div>
            <div className="flex items-center gap-6">
              <div className="text-right">
                <p className="text-2xl font-bold text-tenant-600">
                  ${subscription.pricing.basePrice}
                  <span className="text-sm font-normal text-gray-500">/mo</span>
                </p>
                <p className="text-xs text-gray-500">
                  Next billing: {new Date(subscription.currentPeriodEnd).toLocaleDateString('tr-TR')}
                </p>
              </div>
              {subscription.status === 'trial' && subscription.trialEndDate && (
                <div className="px-4 py-2 bg-blue-100 rounded-lg">
                  <p className="text-xs font-medium text-blue-700">Trial ends</p>
                  <p className="text-sm font-semibold text-blue-800">
                    {new Date(subscription.trialEndDate).toLocaleDateString('tr-TR')}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statsData.map((stat) => {
          const colors = colorClasses[stat.color];
          return (
            <div
              key={stat.id}
              className="bg-white rounded-xl border border-gray-100 p-6 hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between">
                <div className={`p-3 rounded-xl ${colors.icon}`}>
                  {stat.icon}
                </div>
                {stat.change !== undefined && stat.change > 0 && (
                  <div className="flex items-center gap-1 text-sm font-medium text-green-600">
                    <ArrowUpRight className="w-4 h-4" />
                    {stat.change}%
                  </div>
                )}
              </div>
              <div className="mt-4">
                <h3 className="text-sm font-medium text-gray-500">
                  {stat.title}
                </h3>
                <p className="text-2xl font-bold text-gray-900 mt-1">
                  {stat.value}
                </p>
                {stat.changeLabel && (
                  <p className="text-xs text-gray-400 mt-1">
                    {stat.changeLabel}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Modules Status - Takes 2 columns */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-gray-100">
          <div className="p-6 border-b border-gray-100">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">
                Module Status
              </h2>
              <button
                onClick={() => navigate('/tenant/modules')}
                className="text-sm text-tenant-600 hover:text-tenant-700 font-medium"
              >
                View All
              </button>
            </div>
          </div>
          {modules.length === 0 ? (
            <div className="p-8 text-center">
              <Package className="w-12 h-12 text-gray-300 mx-auto" />
              <p className="text-sm text-gray-500 mt-3">No modules assigned yet</p>
              <p className="text-xs text-gray-400 mt-1">Contact your administrator to get modules assigned</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {modules.map((module) => (
                <div
                  key={module.id}
                  className="p-4 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-lg bg-tenant-100 flex items-center justify-center text-xl">
                        {module.icon}
                      </div>
                      <div>
                        <h3 className="text-sm font-medium text-gray-900">
                          {module.name}
                        </h3>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {module.users} users • Activated: {module.lastActivity}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <StatusBadge status={module.status} />
                      <button className="p-1 rounded hover:bg-gray-100 transition-colors">
                        <MoreVertical className="w-4 h-4 text-gray-400" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Activity - Takes 1 column */}
        <div className="bg-white rounded-xl border border-gray-100">
          <div className="p-6 border-b border-gray-100">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">
                Recent Activity
              </h2>
            </div>
          </div>
          {activities.length === 0 ? (
            <div className="p-8 text-center">
              <Activity className="w-12 h-12 text-gray-300 mx-auto" />
              <p className="text-sm text-gray-500 mt-3">No recent activity</p>
            </div>
          ) : (
            <div className="p-4 space-y-4 max-h-[400px] overflow-y-auto">
              {activities.map((activity) => (
                <div key={activity.id} className="flex gap-3">
                  <div
                    className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
                      activity.type === 'user_added'
                        ? 'bg-green-100 text-green-600'
                        : activity.type === 'module_assigned'
                        ? 'bg-blue-100 text-blue-600'
                        : activity.type === 'login'
                        ? 'bg-purple-100 text-purple-600'
                        : 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {activity.type === 'user_added' ? (
                      <Users className="w-4 h-4" />
                    ) : activity.type === 'module_assigned' ? (
                      <Package className="w-4 h-4" />
                    ) : (
                      <Activity className="w-4 h-4" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900 line-clamp-2">
                      {activity.description}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">
                      {activity.timestamp}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="bg-gradient-to-r from-tenant-600 to-tenant-700 rounded-xl p-6 text-white">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold">Need to add more users?</h3>
            <p className="text-tenant-100 text-sm mt-1">
              Invite team members to collaborate on your aquaculture operations.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/tenant/modules')}
              className="px-4 py-2 text-sm font-medium text-tenant-600 bg-white rounded-lg hover:bg-tenant-50 transition-colors"
            >
              View Modules
            </button>
            <button
              onClick={() => navigate('/tenant/users')}
              className="px-4 py-2 text-sm font-medium text-white bg-tenant-800 rounded-lg hover:bg-tenant-900 transition-colors"
            >
              Invite Users
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TenantDashboard;
