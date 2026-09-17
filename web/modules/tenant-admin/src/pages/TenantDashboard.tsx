import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createTenantQueryKey, createTenantInvalidationKey, getTenantId, parseMoney } from '@aquaculture/shared-ui';
import {
  Users,
  Package,
  Activity,
  TrendingUp,
  AlertCircle,
  CheckCircle,
  Clock,
  UserPlus,
  RefreshCw,
  Shield,
  HardDrive,
  LifeBuoy,
} from 'lucide-react';
import { getMyModules, getTenantUsers, getMySubscription } from '../lib/api';
import type { User, MyModule } from '../lib/types';
import { useTenantStats } from '../hooks/useTenantData';
import { formatRelativeTime, formatDate } from '../utils/date-utils';

/**
 * TenantDashboard Page — SUDERRA Tenant Console design.
 *
 * All data fetching uses TanStack Query for caching, deduplication, and
 * automatic background refetching. No manual useState/useEffect/fetch.
 * Presentation classes (sd-*) live in the shell stylesheet — the host
 * document styles the federated page.
 *
 * DATA SOURCES (all real backend — no mocked data on this page):
 * - useTenantStats()     → auth-service `tenantStats` (totalUsers/activeUsers/
 *                          totalModules/activeModules/activeSessions/
 *                          monthlyGrowthPercent — genuine resolvers).
 * - getMyModules()       → real module assignments incl. isEnabled.
 * - getTenantUsers()     → real users incl. lastLoginAt (feeds "Team activity").
 * - getMySubscription()  → billing-service (basePriceDecimal/planName/
 *                          billingCycle/currentPeriodEnd/status).
 *
 * MOCK-ONLY PARTS (backend equivalent missing — labels kept for design
 * parity; do NOT read them as measured values):
 * - "of seats": licensed seat total is NOT in the subscription payload
 *   (SubscriptionInfo has no seats/quantity field). Needs billing-service
 *   support before the number is meaningful.
 * - "active this week": backend activeUsers = count of isActive-flag users;
 *   there is no weekly activity window.
 * - "online now" (Active sessions): backend activeSessions = count of
 *   unexpired, non-revoked refresh tokens — a session proxy, not live sockets.
 * - Mockup cards "Telemetry" and "Needs attention" are intentionally NOT
 *   rendered: no backend feed exists for either yet.
 */

interface ModuleStatus {
  id: string;
  name: string;
  code: string;
  status: 'active' | 'inactive';
  icon: string;
}

interface RecentActivity {
  id: string;
  description: string;
  timestamp: string;
  initials: string;
}

/** Module icon mapping (kept from the legacy dashboard) */
const moduleIconMap: Record<string, string> = {
  farm: '🐟',
  sensor: '📊',
  hr: '👥',
};

/**
 * MOCK-ADJACENT: getMyModules() returns no `code` field, so the tile tint is
 * inferred from the module NAME (keyword heuristic below). If the backend
 * later exposes module.code, replace this inference with the real field.
 */

/** Rail-style icon tile tint per module code (mockup module tints). */
const moduleTileClass = (code: string, enabled: boolean): string => {
  if (!enabled) return 'sd-mod-tile--off';
  if (code === 'farm') return 'sd-mod-tile--farm';
  if (code === 'sensor') return 'sd-mod-tile--sensor';
  if (code === 'hr') return 'sd-mod-tile--hr';
  return 'sd-mod-tile--sensor';
};

const initialsOf = (u: User): string =>
  `${(u.firstName || '?')[0] ?? ''}${(u.lastName || '')[0] ?? ''}`.toUpperCase() || '·';

/** Quick links ("Jump to") — real routes only. */
const JUMP_LINKS = [
  { to: '/tenant/users', label: 'Invite a user', desc: 'Send an email invitation with a role', icon: <UserPlus size={16} /> },
  { to: '/tenant/roles', label: 'Define a role', desc: 'Delegate panel access to your team', icon: <Shield size={16} /> },
  { to: '/tenant/devices', label: 'Register a device', desc: 'Provision an edge gateway with a key', icon: <HardDrive size={16} /> },
  { to: '/tenant/support', label: 'Open a ticket', desc: 'Reach platform support directly', icon: <LifeBuoy size={16} /> },
] as const;

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
  const refreshing = modulesQuery.isFetching || usersQuery.isFetching;
  const error = modulesQuery.error ?? usersQuery.error;

  // Recent activity derived from user logins (legacy rule, mockup styling)
  const activities = useMemo((): RecentActivity[] =>
    users
      .filter((u: User) => u.lastLoginAt)
      .sort((a: User, b: User) =>
        new Date(b.lastLoginAt || 0).getTime() - new Date(a.lastLoginAt || 0).getTime()
      )
      .slice(0, 5)
      .map((u: User, idx: number) => ({
        id: `activity-${idx}`,
        description: `${u.firstName || ''} ${u.lastName || ''} (${u.email}) logged in`,
        timestamp: u.lastLoginAt ? formatRelativeTime(u.lastLoginAt) : 'Unknown',
        initials: initialsOf(u),
      })),
    [users],
  );

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(getTenantId(), 'dashboard') });
  };

  // Stats — prefer TanStack Query stats if available (PERF-001)
  const activeUsers = tenantStats?.activeUsers ?? users.filter(u => u.isActive).length;
  const totalUsers = tenantStats?.totalUsers ?? users.length;
  const activeModules = tenantStats?.activeModules ?? modules.filter(m => m.status === 'active').length;
  const totalModules = tenantStats?.totalModules ?? modules.length;

  // MED-06: "This Month" must use monthlyGrowthPercent, not totalUsers
  const monthlyGrowth = tenantStats?.monthlyGrowthPercent ?? 0;

  const stats = useMemo(() => [
    {
      id: 'users',
      title: 'Team members',
      value: String(totalUsers),
      // MOCK LABEL: real value is totalUsers; seat total is not exposed by
      // billing yet, so "of seats" / "active this week" are design-parity
      // copy, not measured values.
      unit: 'of seats',
      change: `${activeUsers} active this week`,
      dot: 'sd-dot--mint',
      icon: <Users size={17} style={{ color: '#166f5a' }} />,
    },
    {
      id: 'modules',
      title: 'Active modules',
      value: String(activeModules),
      unit: `of ${totalModules} assigned`,
      change: totalModules > activeModules ? 'Some modules not enabled' : 'All modules enabled',
      dot: 'sd-dot--cyan',
      icon: <Package size={17} style={{ color: '#0b4f60' }} />,
    },
    {
      id: 'sessions',
      title: 'Active sessions',
      // REAL field, PROXY semantics: activeSessions counts unexpired
      // non-revoked refresh tokens, not live sockets.
      value: String(tenantStats?.activeSessions ?? activeUsers),
      unit: 'online now',
      change: `${activeUsers} users this week`,
      dot: 'sd-dot--cyan',
      icon: <Activity size={17} style={{ color: '#0b4f60' }} />,
    },
    {
      id: 'growth',
      title: 'This month',
      value: monthlyGrowth > 0 ? `+${monthlyGrowth}%` : '0%',
      unit: 'growth',
      change: 'User growth (MED-06)',
      dot: monthlyGrowth > 0 ? 'sd-dot--mint' : 'sd-dot--faint',
      icon: <TrendingUp size={17} style={{ color: monthlyGrowth > 0 ? '#166f5a' : '#3d5c69' }} />,
    },
  ], [totalUsers, activeUsers, activeModules, totalModules, tenantStats?.activeSessions, monthlyGrowth]);

  // Seat usage — active share of the team (licensed-seat totals are not in the
  // subscription payload yet; wired when the backend exposes them).
  const seatPct = totalUsers > 0 ? Math.min(100, Math.round((activeUsers / totalUsers) * 100)) : 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64" role="status" aria-live="polite">
        <RefreshCw className="w-8 h-8 animate-spin text-tenant-600" aria-hidden="true" />
        <span className="sr-only">Dashboard loading...</span>
      </div>
    );
  }

  return (
    <div className="sd-page">
      {/* Actions row */}
      <div className="sd-actions">
        <button onClick={handleRefresh} className={`sd-iconbtn${refreshing ? ' sd-iconbtn--spin' : ''}`} title="Refresh" aria-label="Refresh">
          <RefreshCw size={16} />
        </button>
        <button onClick={() => navigate('/tenant/users')} className="sd-btn-deep">
          <UserPlus size={16} />
          Invite user
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="sd-banner sd-banner--error" role="alert">
          <AlertCircle size={19} style={{ color: '#b04a28', flexShrink: 0 }} />
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#8e3a1e' }}>Failed to load data</p>
          <p style={{ margin: 0, flex: 1, fontSize: 13.5, color: '#3d5c69' }}>{(error as Error).message}</p>
          <button onClick={handleRefresh} style={{ fontSize: 13, fontWeight: 600, color: '#8e3a1e', background: 'transparent', border: '1px solid rgba(176,74,40,.3)', padding: '7px 14px', borderRadius: 999, cursor: 'pointer' }}>
            Retry
          </button>
        </div>
      )}

      {/* Stat cards */}
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

      {/* Two-column body */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        {/* Left column */}
        <div style={{ flex: '2 1 540px', display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          {/* Assigned modules */}
          <div className="sd-card sd-card--flush">
            <div className="sd-card-head">
              <span className="sd-card-label">Assigned modules</span>
              <button onClick={() => navigate('/tenant/modules')} className="sd-textlink">Manage →</button>
            </div>
            {modules.length === 0 ? (
              <div className="sd-empty">
                <strong>No modules assigned</strong>
                Contact your platform administrator to enable modules.
              </div>
            ) : (
              modules.map((module) => (
                <div key={module.id} className="sd-mod-row">
                  <span className={`sd-mod-tile ${moduleTileClass(module.code, module.status === 'active')}`}>{module.icon}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="sd-mod-name" style={{ display: 'block' }}>{module.name}</span>
                    <span className="sd-mod-meta" style={{ display: 'block' }}>
                      {module.status === 'active' ? 'Enabled' : 'Not enabled for this tenant'}
                    </span>
                  </span>
                  <span className={`sd-pill ${module.status === 'active' ? 'sd-pill--active' : 'sd-pill--inactive'}`}>
                    {module.status === 'active' ? <CheckCircle size={13} /> : <Clock size={13} />}
                    {module.status === 'active' ? 'Active' : 'Inactive'}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* Subscription + Seat usage */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
            {subscription && (
              <div className="sd-card" style={{ flex: '0 1 300px', padding: '17px 19px', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 11 }}>
                  <Package size={16} style={{ color: '#0b4f60' }} />
                  <span className="sd-card-label" style={{ fontSize: 12.5 }}>Subscription</span>
                </div>
                <div>
                  <span className="sd-stat-value" style={{ fontSize: 32 }}>${parseMoney(subscription.pricing.basePriceDecimal)}</span>{' '}
                  <span className="sd-stat-unit">/ month</span>
                </div>
                <div style={{ marginTop: 8 }}>
                  <div className="sd-def-row">
                    <span className="sd-def-label">Plan</span>
                    <span className="sd-def-value">{subscription.planName}</span>
                  </div>
                  <div className="sd-def-row">
                    <span className="sd-def-label">Billing cycle</span>
                    <span className="sd-def-value" style={{ textTransform: 'capitalize' }}>{subscription.billingCycle}</span>
                  </div>
                  <div className="sd-def-row">
                    <span className="sd-def-label">Next invoice</span>
                    <span className="sd-def-value">{formatDate(subscription.currentPeriodEnd)}</span>
                  </div>
                  <div className="sd-def-row">
                    <span className="sd-def-label">Status</span>
                    <span className={`sd-pill ${subscription.status === 'active' ? 'sd-pill--active' : subscription.status === 'trial' ? 'sd-pill--pending' : 'sd-pill--inactive'}`}>
                      {subscription.status === 'trial' ? 'Trial' : subscription.status.charAt(0).toUpperCase() + subscription.status.slice(1)}
                    </span>
                  </div>
                </div>
              </div>
            )}
            <div className="sd-card" style={{ flex: '0 1 300px', padding: '17px 19px', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 11 }}>
                <Users size={16} style={{ color: '#0b4f60' }} />
                <span className="sd-card-label" style={{ fontSize: 12.5 }}>Seat usage</span>
              </div>
              <div>
                <span className="sd-stat-value" style={{ fontSize: 32 }}>{totalUsers}</span>{' '}
                <span className="sd-stat-unit">team members</span>
              </div>
              <div className="sd-progress" style={{ margin: '12px 0 7px' }}>
                <span style={{ width: `${seatPct}%` }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, fontWeight: 500, color: '#3d5c69' }}>
                <span>{seatPct}% active</span>
                <span>{Math.max(0, totalUsers - activeUsers)} inactive</span>
              </div>
            </div>
          </div>

          {/* Jump to */}
          <div>
            <span className="sd-card-label">Jump to</span>
            <div className="sd-jump-grid" style={{ marginTop: 11 }}>
              {JUMP_LINKS.map((link) => (
                <button key={link.to} type="button" className="sd-jump-card" onClick={() => navigate(link.to)}>
                  <span className="sd-jump-tile">{link.icon}</span>
                  <div className="sd-jump-label">{link.label}</div>
                  <div className="sd-jump-desc">{link.desc}</div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right column */}
        <div style={{ flex: '1 1 330px', display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          {/* Team activity */}
          <div className="sd-card" style={{ padding: '17px 19px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
              <Activity size={16} style={{ color: '#0b4f60' }} />
              <span className="sd-card-label" style={{ fontSize: 12.5 }}>Team activity</span>
            </div>
            {activities.length === 0 ? (
              <div className="sd-empty" style={{ padding: '28px 12px' }}>No recent activity</div>
            ) : (
              <div className="sd-activity-list">
                {activities.map((activity) => (
                  <div key={activity.id} className="sd-activity-row">
                    <span className="sd-avatar">{activity.initials}</span>
                    <span style={{ minWidth: 0 }}>
                      <span className="sd-activity-desc" style={{ display: 'block' }}>{activity.description}</span>
                      <span className="sd-activity-time" style={{ display: 'block' }}>{activity.timestamp}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default TenantDashboard;
