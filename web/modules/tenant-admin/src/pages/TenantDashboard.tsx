import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createTenantQueryKey, createTenantInvalidationKey, getTenantId } from '@aquaculture/shared-ui';
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
import { getMyModules, getTenantUsers, getMySubscription } from '../lib/api';
import type { User, MyModule } from '../lib/types';
import { useTenantStats } from '../hooks/useTenantData';
import { formatRelativeTime, formatDate } from '../utils/date-utils';

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

// User and SubscriptionInfo types imported from lib/types

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
 *
 * All data fetching uses TanStack Query for caching, deduplication, and
 * automatic background refetching. No manual useState/useEffect/fetch.
 */
const TenantDashboard: React.FC = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Use TanStack Query for stats (PERF-001)
  const { data: tenantStats } = useTenantStats();

  // Modules query
  const modulesQuery = useQuery({
    queryKey: createTenantQueryKey(getTenantId(), 'dashboard', 'modules'),
    queryFn: async () => {
      const modules = await getMyModules();
      return (modules || []).map((m: MyModule): ModuleStatus => {
        const code = m.name?.toLowerCase().includes('farm') ? 'farm'
          : m.name?.toLowerCase().includes('hr') || m.name?.toLowerCase().includes('insan') ? 'hr'
          : m.name?.toLowerCase().includes('sensor') || m.name?.toLowerCase().includes('sens') ? 'sensor'
          : 'default';
        return {
          id: m.id,
          name: m.name,
          code,
          status: m.isEnabled ? 'active' : 'inactive',
          users: 0,
          lastActivity: 'Active',
          icon: moduleIconMap[code] || m.icon || '📦',
        };
      });
    },
    staleTime: 2 * 60 * 1000,
  });

  // Users query
  const usersQuery = useQuery({
    queryKey: createTenantQueryKey(getTenantId(), 'dashboard', 'users'),
    queryFn: async () => {
      const users = await getTenantUsers();
      return users || [];
    },
    staleTime: 2 * 60 * 1000,
  });

  // Subscription query
  const subscriptionQuery = useQuery({
    queryKey: createTenantQueryKey(getTenantId(), 'dashboard', 'subscription'),
    queryFn: async () => {
      return getMySubscription();
    },
    staleTime: 5 * 60 * 1000,
  });

  const modules = modulesQuery.data ?? [];
  const users = usersQuery.data ?? [];
  const subscription = subscriptionQuery.data ?? null;
  const loading = modulesQuery.isLoading || usersQuery.isLoading;
  const error = modulesQuery.error ?? usersQuery.error;

  // Generate recent activity from users
  const activities = useMemo((): RecentActivity[] =>
    users
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
      })),
    [users],
  );

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(getTenantId(), 'dashboard') });
  };

  // Calculate stats -- prefer TanStack Query stats if available (PERF-001)
  const activeUsers = tenantStats?.activeUsers ?? users.filter(u => u.isActive).length;
  const totalUsers = tenantStats?.totalUsers ?? users.length;
  const activeModules = tenantStats?.activeModules ?? modules.filter(m => m.status === 'active').length;
  const totalModules = tenantStats?.totalModules ?? modules.length;

  // MED-06: Fix "This Month" card — use monthlyGrowthPercent instead of totalUsers
  // Also memoize statsData to avoid recreating on every render
  const monthlyGrowth = tenantStats?.monthlyGrowthPercent ?? 0;

  const statsData: StatCard[] = useMemo(() => [
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
      value: tenantStats?.activeSessions ?? activeUsers,
      changeLabel: 'users online',
      icon: <Activity className="w-6 h-6" />,
      color: 'yellow',
    },
    {
      id: 'growth',
      title: 'This Month',
      value: monthlyGrowth > 0 ? `+${monthlyGrowth}%` : '0%',
      change: monthlyGrowth,
      changeLabel: 'user growth',
      icon: <TrendingUp className="w-6 h-6" />,
      color: 'purple',
    },
  ], [totalUsers, activeUsers, activeModules, totalModules, tenantStats?.activeSessions, monthlyGrowth]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64" role="status" aria-live="polite">
        <RefreshCw className="w-8 h-8 animate-spin text-tenant-600" aria-hidden="true" />
        <span className="sr-only">Dashboard loading...</span>
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
            onClick={handleRefresh}
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
            <p className="text-sm text-red-600">{(error as Error).message}</p>
          </div>
          <button
            onClick={handleRefresh}
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
                  Next billing: {formatDate(subscription.currentPeriodEnd)}
                </p>
              </div>
              {subscription.status === 'trial' && subscription.trialEndDate && (
                <div className="px-4 py-2 bg-blue-100 rounded-lg">
                  <p className="text-xs font-medium text-blue-700">Trial ends</p>
                  <p className="text-sm font-semibold text-blue-800">
                    {formatDate(subscription.trialEndDate)}
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
                  <p className="text-xs text-gray-500 mt-1">
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
              <Package className="w-12 h-12 text-gray-500 mx-auto" />
              <p className="text-sm text-gray-500 mt-3">No modules assigned yet</p>
              <p className="text-xs text-gray-500 mt-1">Contact your administrator to get modules assigned</p>
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
                        <MoreVertical className="w-4 h-4 text-gray-500" />
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
              <Activity className="w-12 h-12 text-gray-500 mx-auto" />
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
                    <p className="text-xs text-gray-500 mt-1">
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
