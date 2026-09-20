import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createTenantQueryKey,
  createTenantInvalidationKey,
  getTenantId,
  parseMoney,
  PageHeader,
  Button,
  useI18n,
} from '@aquaculture/shared-ui';
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
  farm: '🐟',
  sensor: '📊',
  hr: '👥',
};

/**
 * Color mapping for stat cards
 */
const colorClasses = {
  green: {
    bg: 'bg-success-50 dark:bg-success-900/20',
    icon: 'bg-success-100 dark:bg-success-900/40 text-success-600 dark:text-success-400',
    text: 'text-success-600 dark:text-success-400',
  },
  blue: {
    bg: 'bg-info-50 dark:bg-info-900/20',
    icon: 'bg-info-100 dark:bg-info-900/40 text-info-600 dark:text-info-400',
    text: 'text-info-600 dark:text-info-400',
  },
  yellow: {
    bg: 'bg-warning-50 dark:bg-warning-900/20',
    icon: 'bg-warning-100 dark:bg-warning-900/40 text-warning-600 dark:text-warning-400',
    text: 'text-warning-600 dark:text-warning-400',
  },
  purple: {
    bg: 'bg-accent-50 dark:bg-accent-900/20',
    icon: 'bg-accent-100 dark:bg-accent-900/40 text-accent-600 dark:text-accent-400',
    text: 'text-accent-600 dark:text-accent-400',
  },
};

/**
 * Status badge component
 */
const StatusBadge: React.FC<{ status: ModuleStatus['status'] }> = ({ status }) => {
  const statusConfig = {
    active: {
      bg: 'bg-success-100 dark:bg-success-900/40',
      text: 'text-success-700 dark:text-success-300',
      icon: <CheckCircle className="w-3 h-3" />,
    },
    inactive: {
      bg: 'bg-gray-100 dark:bg-gray-800',
      text: 'text-gray-700 dark:text-gray-300',
      icon: <Clock className="w-3 h-3" />,
    },
    pending: {
      bg: 'bg-warning-100 dark:bg-warning-900/40',
      text: 'text-warning-700 dark:text-warning-300',
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
  const { t } = useI18n();
  const queryClient = useQueryClient();

  // Use TanStack Query for stats (PERF-001)
  const { data: tenantStats } = useTenantStats();

  // Modules query
  const modulesQuery = useQuery({
    queryKey: createTenantQueryKey(getTenantId(), 'dashboard', 'modules'),
    queryFn: async () => {
      const modules = await getMyModules();
      return (modules || []).map((m: MyModule): ModuleStatus => {
        const code = m.name?.toLowerCase().includes('farm')
          ? 'farm'
          : m.name?.toLowerCase().includes('hr') || m.name?.toLowerCase().includes('insan')
            ? 'hr'
            : m.name?.toLowerCase().includes('sensor') || m.name?.toLowerCase().includes('sens')
              ? 'sensor'
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
  const activities = useMemo(
    (): RecentActivity[] =>
      users
        .filter((u: User) => u.lastLoginAt)
        .sort(
          (a: User, b: User) =>
            new Date(b.lastLoginAt || 0).getTime() - new Date(a.lastLoginAt || 0).getTime(),
        )
        .slice(0, 5)
        .map((u: User, idx: number) => ({
          id: `activity-${idx}`,
          type: 'login' as const,
          description: `${u.firstName || ''} ${u.lastName || ''} (${u.email}) logged in`,
          timestamp: u.lastLoginAt ? formatRelativeTime(u.lastLoginAt) : t('common.unknown'),
          user: u.email,
        })),
    [users],
  );

  const handleRefresh = () => {
    queryClient.invalidateQueries({
      queryKey: createTenantInvalidationKey(getTenantId(), 'dashboard'),
    });
  };

  // Calculate stats -- prefer TanStack Query stats if available (PERF-001)
  const activeUsers = tenantStats?.activeUsers ?? users.filter((u) => u.isActive).length;
  const totalUsers = tenantStats?.totalUsers ?? users.length;
  const activeModules =
    tenantStats?.activeModules ?? modules.filter((m) => m.status === 'active').length;
  const totalModules = tenantStats?.totalModules ?? modules.length;

  // MED-06: Fix "This Month" card — use monthlyGrowthPercent instead of totalUsers
  // Also memoize statsData to avoid recreating on every render
  const monthlyGrowth = tenantStats?.monthlyGrowthPercent ?? 0;

  const statsData: StatCard[] = useMemo(
    () => [
      {
        id: 'users',
        title: t('tenantDashboard.totalUsers'),
        value: totalUsers,
        changeLabel: t('tenantDashboard.nActive', { count: activeUsers }),
        icon: <Users className="w-6 h-6" />,
        color: 'green',
      },
      {
        id: 'modules',
        title: t('tenantDashboard.activeModules'),
        value: activeModules,
        changeLabel: t('tenantDashboard.ofAssigned', { total: totalModules }),
        icon: <Package className="w-6 h-6" />,
        color: 'blue',
      },
      {
        id: 'activity',
        title: t('tenantDashboard.activeSessions'),
        value: tenantStats?.activeSessions ?? activeUsers,
        changeLabel: t('tenantDashboard.usersOnline'),
        icon: <Activity className="w-6 h-6" />,
        color: 'yellow',
      },
      {
        id: 'growth',
        title: t('tenantDashboard.thisMonth'),
        value: monthlyGrowth > 0 ? `+${monthlyGrowth}%` : '0%',
        change: monthlyGrowth,
        changeLabel: t('tenantDashboard.userGrowth'),
        icon: <TrendingUp className="w-6 h-6" />,
        color: 'purple',
      },
    ],
    [
      totalUsers,
      activeUsers,
      activeModules,
      totalModules,
      tenantStats?.activeSessions,
      monthlyGrowth,
    ],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64" role="status" aria-live="polite">
        <RefreshCw
          className="w-8 h-8 animate-spin text-success-600 dark:text-success-400"
          aria-hidden="true"
        />
        <span className="sr-only">{t('tenantDashboard.loading')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        title="Dashboard"
        description="Welcome back! Here's what's happening with your tenant."
        actions={
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              iconOnly
              aria-label="Refresh"
              onClick={handleRefresh}
              title="Refresh"
            >
              <RefreshCw className="w-5 h-5 text-gray-500 dark:text-gray-400" />
            </Button>
            <Button variant="primary" onClick={() => navigate('/tenant/users')}>
              {t('tenantDashboard.addUser')}
            </Button>
          </div>
        }
      />

      {/* Error Message */}
      {error && (
        <div className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-error-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-error-800 dark:text-error-200">
              {t('tenantDashboard.loadFailed')}
            </p>
            <p className="text-sm text-error-600 dark:text-error-400">{(error as Error).message}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={handleRefresh}>
            Retry
          </Button>
        </div>
      )}

      {/* Subscription Banner */}
      {subscription && (
        <div className="bg-gradient-to-r from-success-50 via-info-50 to-accent-50 rounded-xl border border-success-200 dark:border-success-800 p-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl bg-success-100 dark:bg-success-900/40">
                <Package className="w-6 h-6 text-success-600 dark:text-success-400" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    {subscription.planName}
                  </h3>
                  <span
                    className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                      subscription.status === 'active'
                        ? 'bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300'
                        : subscription.status === 'trial'
                          ? 'bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300'
                          : subscription.status === 'past_due'
                            ? 'bg-error-100 dark:bg-error-900/40 text-error-700 dark:text-error-300'
                            : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    {subscription.status === 'trial'
                      ? t('billing.status.trial')
                      : subscription.status === 'active'
                        ? 'Active'
                        : subscription.status === 'past_due'
                          ? t('billing.status.pastDue')
                          : subscription.status.charAt(0).toUpperCase() +
                            subscription.status.slice(1)}
                  </span>
                </div>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                  {subscription.billingCycle === 'monthly'
                    ? t('billing.cycle.monthly')
                    : subscription.billingCycle === 'quarterly'
                      ? t('billing.cycle.quarterly')
                      : subscription.billingCycle === 'annual'
                        ? t('billing.cycle.annual')
                        : subscription.billingCycle}{' '}
                  billing
                </p>
              </div>
            </div>
            <div className="flex items-center gap-6">
              <div className="text-right">
                <p className="text-2xl font-bold text-success-600 dark:text-success-400">
                  ${parseMoney(subscription.pricing.basePriceDecimal)}
                  <span className="text-sm font-normal text-gray-500 dark:text-gray-400">/mo</span>
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('tenantDashboard.nextBilling')}: {formatDate(subscription.currentPeriodEnd)}
                </p>
              </div>
              {subscription.status === 'trial' && subscription.trialEndDate && (
                <div className="px-4 py-2 bg-info-100 dark:bg-info-900/40 rounded-lg">
                  <p className="text-xs font-medium text-info-700 dark:text-info-300">
                    {t('tenantDashboard.trialEnds')}
                  </p>
                  <p className="text-sm font-semibold text-info-800 dark:text-info-200">
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
              className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-700 p-6 hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between">
                <div className={`p-3 rounded-xl ${colors.icon}`}>{stat.icon}</div>
                {stat.change !== undefined && stat.change > 0 && (
                  <div className="flex items-center gap-1 text-sm font-medium text-success-600 dark:text-success-400">
                    <ArrowUpRight className="w-4 h-4" />
                    {stat.change}%
                  </div>
                )}
              </div>
              <div className="mt-4">
                <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">
                  {stat.title}
                </h3>
                <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-1">
                  {stat.value}
                </p>
                {stat.changeLabel && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
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
        <div className="lg:col-span-2 bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-700">
          <div className="p-6 border-b border-gray-100 dark:border-gray-700">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {t('tenantDashboard.moduleStatus')}
              </h2>
              <Button variant="ghost" onClick={() => navigate('/tenant/modules')}>
                {t('tenantDashboard.viewAll')}
              </Button>
            </div>
          </div>
          {modules.length === 0 ? (
            <div className="p-8 text-center">
              <Package className="w-12 h-12 text-gray-500 dark:text-gray-400 mx-auto" />
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-3">
                {t('tenantDashboard.noModules')}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t('tenantDashboard.noModulesHint')}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-700">
              {modules.map((module) => (
                <div
                  key={module.id}
                  className="p-4 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-lg bg-success-100 dark:bg-success-900/40 flex items-center justify-center text-xl">
                        {module.icon}
                      </div>
                      <div>
                        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          {module.name}
                        </h3>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          {module.users} users • Activated: {module.lastActivity}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <StatusBadge status={module.status} />
                      <Button variant="ghost" size="sm" iconOnly aria-label="More actions">
                        <MoreVertical className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Activity - Takes 1 column */}
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-700">
          <div className="p-6 border-b border-gray-100 dark:border-gray-700">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {t('tenantDashboard.recentActivity')}
              </h2>
            </div>
          </div>
          {activities.length === 0 ? (
            <div className="p-8 text-center">
              <Activity className="w-12 h-12 text-gray-500 dark:text-gray-400 mx-auto" />
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-3">
                {t('tenantDashboard.noActivity')}
              </p>
            </div>
          ) : (
            <div className="p-4 space-y-4 max-h-[400px] overflow-y-auto">
              {activities.map((activity) => (
                <div key={activity.id} className="flex gap-3">
                  <div
                    className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
                      activity.type === 'user_added'
                        ? 'bg-success-100 dark:bg-success-900/40 text-success-600 dark:text-success-400'
                        : activity.type === 'module_assigned'
                          ? 'bg-info-100 dark:bg-info-900/40 text-info-600 dark:text-info-400'
                          : activity.type === 'login'
                            ? 'bg-accent-100 dark:bg-accent-900/40 text-accent-600 dark:text-accent-400'
                            : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
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
                    <p className="text-sm text-gray-900 dark:text-gray-100 line-clamp-2">
                      {activity.description}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
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
      <div className="bg-gradient-to-r from-success-600 to-success-700 rounded-xl p-6 text-white">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold">{t('tenantDashboard.needMoreUsers')}</h3>
            <p className="text-success-100 text-sm mt-1">
              Invite team members to collaborate on your aquaculture operations.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/tenant/modules')}
              className="px-4 py-2 text-sm font-medium text-success-600 bg-white dark:bg-gray-900 rounded-lg hover:bg-success-50 transition-colors"
            >
              {t('tenantDashboard.viewModules')}
            </button>
            <button
              onClick={() => navigate('/tenant/users')}
              className="px-4 py-2 text-sm font-medium text-white bg-success-800 rounded-lg hover:bg-success-900 transition-colors"
            >
              {t('tenantDashboard.inviteUsers')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TenantDashboard;
