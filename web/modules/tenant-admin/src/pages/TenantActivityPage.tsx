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
 *
 * SUDERRA restyle — sd-page/sd-stat/sd-bar/sd-seg primitives; every query,
 * computed value, and label is unchanged.
 *
 * DATA SOURCES (all real backend — no mocked data on this page):
 * - useTenantActivity → auth-service `tenantActivity`: recentLogins (incl.
 *   IP + device from real login records), activeSessions (unexpired
 *   non-revoked refresh tokens — a session proxy, not live sockets),
 *   userActivitySummaries (real action/login counts), dailyActiveUsers
 *   (real per-day distinct actives).
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
import { formatRelativeTime } from '../utils/date-utils';
import { UserAvatar } from '../components/ui/UserAvatar';

// ============================================================================
// Utilities
// ============================================================================

function getDeviceIcon(deviceType: string | null): React.ReactNode {
  switch (deviceType?.toLowerCase()) {
    case 'mobile':
      return <Smartphone size={14} style={{ color: '#5c7783' }} />;
    case 'tablet':
      return <Tablet size={14} style={{ color: '#5c7783' }} />;
    case 'desktop':
      return <Monitor size={14} style={{ color: '#5c7783' }} />;
    default:
      return <Globe size={14} style={{ color: '#5c7783' }} />;
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
 * Period selector — SUDERRA segmented control
 */
const PeriodSelector: React.FC<{
  value: ActivityPeriod;
  onChange: (p: ActivityPeriod) => void;
}> = ({ value, onChange }) => (
  <div className="sd-seg" role="group" aria-label="Activity period">
    {(['7d', '30d'] as ActivityPeriod[]).map((p) => (
      <button
        key={p}
        onClick={() => onChange(p)}
        className={`sd-seg-btn${value === p ? ' sd-seg-btn--on' : ''}`}
        aria-pressed={value === p}
      >
        {p === '7d' ? 'Last 7 Days' : 'Last 30 Days'}
      </button>
    ))}
  </div>
);

/**
 * Simple bar chart for daily active users — mint bars, deep-teal today marker
 */
const DailyActiveUsersChart: React.FC<{ data: DailyActiveUsers[] }> = ({ data }) => {
  const maxCount = useMemo(() => Math.max(...data.map((d) => d.count), 1), [data]);

  if (data.length === 0) {
    return (
      <div className="sd-empty" style={{ padding: '40px 12px' }}>
        No activity data available
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 168, padding: '0 4px' }}>
      {data.map((day) => {
        const heightPercent = (day.count / maxCount) * 100;
        const date = new Date(day.date);
        const isToday =
          date.toDateString() === new Date().toDateString();

        return (
          <div
            key={day.date}
            title={`${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: ${day.count} active`}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, height: '100%' }}
          >
            {/* Bar grows within the remaining space; label sits under it */}
            <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', width: '100%' }}>
              <div
                className={`sd-bar${isToday ? ' sd-bar--today' : ''}`}
                style={{ height: `${Math.max(heightPercent, 2)}%` }}
              />
            </div>
            <span
              style={{
                fontSize: 9.5,
                color: isToday ? '#0b4f60' : '#8aa0aa',
                fontWeight: isToday ? 700 : 500,
                whiteSpace: 'nowrap',
                transform: 'rotate(-38deg)',
                transformOrigin: 'top left',
              }}
              className="hidden sm:block"
            >
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
  <div className="sd-page" aria-busy="true">
    <div style={{ height: 30, width: 260, borderRadius: 10, background: 'rgba(10,31,43,.06)' }} />
    <div className="sd-stat-grid">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="sd-card" style={{ height: 110 }} />
      ))}
    </div>
    <div className="sd-card" style={{ height: 240 }} />
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

  const stats = [
    {
      id: 'sessions',
      title: 'Active sessions',
      value: String(activeSessions),
      unit: 'now',
      // REAL field, PROXY semantics: activeSessions counts unexpired
      // non-revoked refresh tokens, not live sockets.
      change: 'Valid sessions (token-based)',
      dot: 'sd-dot--mint',
      icon: <Wifi size={17} style={{ color: '#166f5a' }} />,
    },
    {
      id: 'unique',
      title: 'Unique users',
      value: String(uniqueActiveUsers),
      unit: period === '7d' ? 'in 7 days' : 'in 30 days',
      change: 'Distinct users with a successful login',
      dot: 'sd-dot--cyan',
      icon: <Users size={17} style={{ color: '#0b4f60' }} />,
    },
    {
      id: 'logins',
      title: 'Total logins',
      value: String(recentLogins.filter((l) => l.success).length),
      unit: 'records',
      change: 'Successful login records in period',
      dot: 'sd-dot--cyan',
      icon: <Activity size={17} style={{ color: '#0b4f60' }} />,
    },
    {
      id: 'failed',
      title: 'Failed logins',
      value: String(failedLogins),
      unit: 'attempts',
      change: failedLogins > 0 ? 'Review recommended' : 'No issues',
      dot: failedLogins > 0 ? 'sd-dot--red' : 'sd-dot--faint',
      icon: <Shield size={17} style={{ color: failedLogins > 0 ? '#b04a28' : '#3d5c69' }} />,
    },
  ];

  return (
    <div className="sd-page">
      {/* Page header (mockup pattern: eyebrow + serif title + actions) */}
      <div className="sd-pagehead">
        <span className="sd-eyebrow">People &amp; access</span>
        <h1 className="sd-page-title">User Activity</h1>
        <span className="sd-page-sub">Monitor user logins, sessions, and activity trends</span>
      </div>

      {/* Actions row */}
      <div className="sd-actions">
        <PeriodSelector value={period} onChange={changePeriod} />
        <button
          onClick={() => refetch()}
          className="sd-iconbtn"
          title="Refresh"
          aria-label="Refresh"
        >
          <RefreshCw size={16} />
        </button>
      </div>

      {/* Error Message */}
      {error && (
        <div className="sd-banner sd-banner--error" role="alert">
          <AlertCircle size={19} style={{ color: '#b04a28', flexShrink: 0 }} />
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#8e3a1e' }}>Failed to load activity data</p>
          <p style={{ margin: 0, flex: 1, fontSize: 13.5, color: '#3d5c69' }}>{(error as Error).message}</p>
          <button onClick={() => refetch()} className="sd-btn-ghost" style={{ padding: '6px 13px', fontSize: 12.5, color: '#8e3a1e', borderColor: 'rgba(176,74,40,.35)' }}>
            Retry
          </button>
        </div>
      )}

      {/* Summary Cards */}
      <div className="sd-stat-grid">
        {stats.map((stat) => (
          <div key={stat.id} className="sd-card sd-card--dash sd-stat-card">
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
              <span className="sd-stat-title">{stat.title}</span>
              {stat.icon}
            </div>
            <div>
              <span className="sd-stat-value">{stat.value}</span>{' '}
              <span className="sd-stat-unit">{stat.unit}</span>
            </div>
            <div className="sd-stat-change">
              <span className={`sd-dot ${stat.dot}`} />
              {stat.change}
            </div>
          </div>
        ))}
      </div>

      {/* Daily Active Users Chart */}
      <div className="sd-card" style={{ padding: '17px 19px' }}>
        <div className="sd-card-head" style={{ marginBottom: 12 }}>
          <div>
            <span className="sd-card-label">Daily active users</span>
            <span className="sd-page-sub" style={{ display: 'block', marginTop: 2 }}>
              {period === '7d' ? 'Last 7 days' : 'Last 30 days'} trend
            </span>
          </div>
          <TrendingUp size={17} style={{ color: '#0b4f60' }} aria-hidden="true" />
        </div>
        <DailyActiveUsersChart data={dailyActiveUsers} />
      </div>

      {/* Recent Logins & User Summary - Two Column */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        {/* Recent Logins */}
        <div className="sd-card sd-card--flush" style={{ flex: '1 1 420px', minWidth: 0 }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(10,31,43,.09)' }}>
            <span className="sd-card-label">Recent logins</span>
          </div>
          {recentLogins.length > 0 ? (
            <div style={{ maxHeight: 400, overflowY: 'auto' }}>
              {recentLogins.slice(0, 20).map((login: RecentLogin) => (
                <div
                  key={login.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 16px', borderBottom: '1px solid rgba(10,31,43,.05)' }}
                >
                  <UserAvatar name={getUserName(login.firstName, login.lastName, login.email)} size="sm" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span className="sd-rowname" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {getUserName(login.firstName, login.lastName, login.email)}
                    </span>
                    <span className="sd-rowemail" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {login.email}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }} className="hidden sm:flex">
                    {getDeviceIcon(login.deviceType)}
                    <span className="sd-cellmono">{login.ipAddress || '--'}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {login.success ? (
                      <CheckCircle size={14} style={{ color: '#166f5a', flexShrink: 0 }} aria-label="Success" />
                    ) : (
                      <XCircle size={14} style={{ color: '#b04a28', flexShrink: 0 }} aria-label="Failed" />
                    )}
                    <span className="sd-celltime">{formatRelativeTime(login.loginAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="sd-empty" style={{ padding: '36px 14px' }}>
              <Activity size={26} style={{ color: '#8aa0aa', marginBottom: 8 }} aria-hidden="true" />
              No recent login data
            </div>
          )}
        </div>

        {/* User Activity Summary */}
        <div className="sd-card sd-card--flush" style={{ flex: '1 1 420px', minWidth: 0 }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(10,31,43,.09)' }}>
            <span className="sd-card-label">User activity summary</span>
          </div>
          {userSummaries.length > 0 ? (
            <div style={{ maxHeight: 400, overflowY: 'auto' }}>
              {userSummaries.map((summary: UserActivitySummary) => (
                <div
                  key={summary.userId}
                  style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 16px', borderBottom: '1px solid rgba(10,31,43,.05)' }}
                >
                  <UserAvatar
                    name={getUserName(summary.firstName, summary.lastName, summary.email)}
                    size="sm"
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span className="sd-rowname" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {getUserName(summary.firstName, summary.lastName, summary.email)}
                    </span>
                    <span className="sd-rowemail" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {summary.email}
                    </span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span className="sd-rowname" style={{ display: 'block' }}>
                      {summary.totalActions} actions
                    </span>
                    <span className="sd-rowemail" style={{ display: 'block' }}>
                      {summary.loginCount} logins
                    </span>
                  </div>
                  <div className="sd-celltime hidden sm:flex" style={{ alignItems: 'center', gap: 4 }}>
                    <Clock size={12} aria-hidden="true" />
                    {formatRelativeTime(summary.lastActiveAt)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="sd-empty" style={{ padding: '36px 14px' }}>
              <Users size={26} style={{ color: '#8aa0aa', marginBottom: 8 }} aria-hidden="true" />
              No user activity data
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TenantActivityPage;
