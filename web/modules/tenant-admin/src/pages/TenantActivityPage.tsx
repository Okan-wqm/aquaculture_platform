/**
 * TenantActivityPage
 *
 * Displays user activity dashboard for the current tenant:
 * - Recent logins (user, time, IP, device)
 * - Active sessions count
 * - Per-user activity summary (7d/30d)
 * - Daily active user trend chart
 *
 * SEC-007: Protected by RequireTenantAdmin guard in Module.tsx.
 * Read-only page -- no mutations.
 */

import React, { useMemo } from 'react';
import {
  Activity,
  Users,
  Monitor,
  Smartphone,
  Tablet,
  Globe,
  RefreshCw,
  AlertCircle,
  CheckCircle,
  XCircle,
  Clock,
  TrendingUp,
  Shield,
  Wifi,
} from 'lucide-react';
import {
  useTenantActivity,
  type RecentLogin,
  type UserActivitySummary,
  type DailyActiveUsers,
  type ActivityPeriod,
} from '../hooks/useTenantActivity';

// ============================================================================
// Utilities
// ============================================================================

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 5) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function getDeviceIcon(deviceType: string | null): React.ReactNode {
  switch (deviceType?.toLowerCase()) {
    case 'mobile':
      return <Smartphone className="w-4 h-4 text-gray-400" />;
    case 'tablet':
      return <Tablet className="w-4 h-4 text-gray-400" />;
    case 'desktop':
      return <Monitor className="w-4 h-4 text-gray-400" />;
    default:
      return <Globe className="w-4 h-4 text-gray-400" />;
  }
}

function getUserName(
  firstName: string | null,
  lastName: string | null,
  email: string,
): string {
  const name = `${firstName || ''} ${lastName || ''}`.trim();
  return name || email.split('@')[0];
}

// ============================================================================
// Sub-Components
// ============================================================================

/**
 * Stat card with icon and optional trend
 */
const StatCard: React.FC<{
  label: string;
  value: string | number;
  icon: React.ReactNode;
  color: string;
  subtext?: string;
}> = ({ label, value, icon, color, subtext }) => (
  <div className="bg-white rounded-xl border border-gray-100 p-5">
    <div className="flex items-center gap-4">
      <div className={`p-3 rounded-xl ${color}`}>{icon}</div>
      <div>
        <p className="text-xs font-medium text-gray-500 uppercase">{label}</p>
        <p className="text-2xl font-bold text-gray-900">{value}</p>
        {subtext && <p className="text-xs text-gray-500">{subtext}</p>}
      </div>
    </div>
  </div>
);

/**
 * User avatar component
 */
const UserAvatar: React.FC<{ name: string }> = ({ name }) => {
  const initials = name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className="w-9 h-9 rounded-full bg-gradient-to-br from-tenant-500 to-tenant-700 flex items-center justify-center text-white text-xs font-medium">
      {initials || '??'}
    </div>
  );
};

/**
 * Period selector
 */
const PeriodSelector: React.FC<{
  value: ActivityPeriod;
  onChange: (p: ActivityPeriod) => void;
}> = ({ value, onChange }) => (
  <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5">
    {(['7d', '30d'] as ActivityPeriod[]).map((p) => (
      <button
        key={p}
        onClick={() => onChange(p)}
        className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
          value === p
            ? 'bg-white text-tenant-700 shadow-sm'
            : 'text-gray-500 hover:text-gray-700'
        }`}
      >
        {p === '7d' ? 'Last 7 Days' : 'Last 30 Days'}
      </button>
    ))}
  </div>
);

/**
 * Simple bar chart for daily active users
 */
const DailyActiveUsersChart: React.FC<{ data: DailyActiveUsers[] }> = ({ data }) => {
  const maxCount = useMemo(() => Math.max(...data.map((d) => d.count), 1), [data]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-sm text-gray-400">
        No activity data available
      </div>
    );
  }

  return (
    <div className="flex items-end gap-1 h-40 px-2">
      {data.map((day) => {
        const heightPercent = (day.count / maxCount) * 100;
        const date = new Date(day.date);
        const isToday =
          date.toDateString() === new Date().toDateString();

        return (
          <div key={day.date} className="flex-1 flex flex-col items-center gap-1 group">
            {/* Tooltip */}
            <div className="opacity-0 group-hover:opacity-100 transition-opacity text-xs text-gray-600 whitespace-nowrap">
              {day.count}
            </div>
            {/* Bar */}
            <div
              className={`w-full rounded-t transition-all duration-200 ${
                isToday ? 'bg-tenant-500' : 'bg-tenant-300 group-hover:bg-tenant-400'
              }`}
              style={{ height: `${Math.max(heightPercent, 2)}%`, minHeight: '2px' }}
            />
            {/* Label */}
            <span className="text-[10px] text-gray-400 transform -rotate-45 origin-top-left whitespace-nowrap hidden sm:block">
              {date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </span>
          </div>
        );
      })}
    </div>
  );
};

// ============================================================================
// Skeleton Loading
// ============================================================================

const ActivitySkeleton: React.FC = () => (
  <div className="space-y-6 animate-pulse">
    <div className="flex justify-between">
      <div>
        <div className="w-48 h-7 bg-gray-200 rounded" />
        <div className="w-64 h-4 bg-gray-200 rounded mt-2" />
      </div>
    </div>
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {[1, 2, 3].map((i) => (
        <div key={i} className="bg-white rounded-xl border border-gray-100 p-5 h-24" />
      ))}
    </div>
    <div className="bg-white rounded-xl border border-gray-100 p-6 h-60" />
  </div>
);

// ============================================================================
// Main Component
// ============================================================================

const TenantActivityPage: React.FC = () => {
  const {
    recentLogins,
    activeSessions,
    userSummaries,
    dailyActiveUsers,
    period,
    changePeriod,
    isLoading,
    error,
    refetch,
  } = useTenantActivity();

  // Computed stats
  const uniqueActiveUsers = useMemo(() => {
    const uniqueEmails = new Set(
      recentLogins.filter((l) => l.success).map((l) => l.email),
    );
    return uniqueEmails.size;
  }, [recentLogins]);

  const failedLogins = useMemo(
    () => recentLogins.filter((l) => !l.success).length,
    [recentLogins],
  );

  if (isLoading) {
    return <ActivitySkeleton />;
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">User Activity</h1>
          <p className="text-sm text-gray-500 mt-1">
            Monitor user logins, sessions, and activity trends
          </p>
        </div>
        <div className="flex items-center gap-3">
          <PeriodSelector value={period} onChange={changePeriod} />
          <button
            onClick={() => refetch()}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-5 h-5 text-gray-500" />
          </button>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-800">Failed to load activity data</p>
            <p className="text-sm text-red-600">{(error as Error).message}</p>
          </div>
          <button
            onClick={() => refetch()}
            className="ml-auto px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-100 rounded-lg transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Active Sessions"
          value={activeSessions}
          icon={<Wifi className="w-5 h-5 text-green-600" />}
          color="bg-green-50"
          subtext="Currently online"
        />
        <StatCard
          label="Unique Users"
          value={uniqueActiveUsers}
          icon={<Users className="w-5 h-5 text-tenant-600" />}
          color="bg-tenant-50"
          subtext={`${period === '7d' ? 'Last 7 days' : 'Last 30 days'}`}
        />
        <StatCard
          label="Total Logins"
          value={recentLogins.filter((l) => l.success).length}
          icon={<Activity className="w-5 h-5 text-blue-600" />}
          color="bg-blue-50"
        />
        <StatCard
          label="Failed Logins"
          value={failedLogins}
          icon={<Shield className="w-5 h-5 text-red-600" />}
          color="bg-red-50"
          subtext={failedLogins > 0 ? 'Review recommended' : 'No issues'}
        />
      </div>

      {/* Daily Active Users Chart */}
      <div className="bg-white rounded-xl border border-gray-100 p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Daily Active Users</h2>
            <p className="text-sm text-gray-500">
              {period === '7d' ? 'Last 7 days' : 'Last 30 days'} trend
            </p>
          </div>
          <TrendingUp className="w-5 h-5 text-gray-400" />
        </div>
        <DailyActiveUsersChart data={dailyActiveUsers} />
      </div>

      {/* Recent Logins & User Summary - Two Column */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Logins */}
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="text-lg font-semibold text-gray-900">Recent Logins</h2>
          </div>
          {recentLogins.length > 0 ? (
            <div className="divide-y divide-gray-50 max-h-[400px] overflow-y-auto">
              {recentLogins.slice(0, 20).map((login: RecentLogin) => (
                <div key={login.id} className="px-6 py-3 flex items-center gap-3 hover:bg-gray-50 transition-colors">
                  <UserAvatar name={getUserName(login.firstName, login.lastName, login.email)} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {getUserName(login.firstName, login.lastName, login.email)}
                    </p>
                    <p className="text-xs text-gray-500 truncate">{login.email}</p>
                  </div>
                  <div className="hidden sm:flex items-center gap-3">
                    {getDeviceIcon(login.deviceType)}
                    <span className="text-xs text-gray-500 font-mono">{login.ipAddress || '--'}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {login.success ? (
                      <CheckCircle className="w-4 h-4 text-green-500" />
                    ) : (
                      <XCircle className="w-4 h-4 text-red-500" />
                    )}
                    <span className="text-xs text-gray-400 whitespace-nowrap">
                      {formatRelativeTime(login.loginAt)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-12 text-center">
              <Activity className="w-10 h-10 text-gray-300 mx-auto" />
              <p className="mt-3 text-sm text-gray-500">No recent login data</p>
            </div>
          )}
        </div>

        {/* User Activity Summary */}
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="text-lg font-semibold text-gray-900">User Activity Summary</h2>
          </div>
          {userSummaries.length > 0 ? (
            <div className="divide-y divide-gray-50 max-h-[400px] overflow-y-auto">
              {userSummaries.map((summary: UserActivitySummary) => (
                <div
                  key={summary.userId}
                  className="px-6 py-3 flex items-center gap-3 hover:bg-gray-50 transition-colors"
                >
                  <UserAvatar
                    name={getUserName(summary.firstName, summary.lastName, summary.email)}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {getUserName(summary.firstName, summary.lastName, summary.email)}
                    </p>
                    <p className="text-xs text-gray-500 truncate">{summary.email}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium text-gray-900">
                      {summary.totalActions} actions
                    </p>
                    <p className="text-xs text-gray-500">
                      {summary.loginCount} logins
                    </p>
                  </div>
                  <div className="hidden sm:flex items-center gap-1 text-xs text-gray-400">
                    <Clock className="w-3 h-3" />
                    {formatRelativeTime(summary.lastActiveAt)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-12 text-center">
              <Users className="w-10 h-10 text-gray-300 mx-auto" />
              <p className="mt-3 text-sm text-gray-500">No user activity data</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TenantActivityPage;
