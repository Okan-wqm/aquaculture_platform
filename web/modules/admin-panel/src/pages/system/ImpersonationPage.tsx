import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Card, Button, Badge, Input, Alert, useAuthContext } from '@aquaculture/shared-ui';
import {
  impersonationApi,
  tenantsApi,
  type ImpersonationSession,
  type ImpersonationPermission,
  type ImpersonationAction,
  type ImpersonationAuditSummary,
  type ImpersonationReasonCode,
  type ImpersonationSessionStatus,
} from '../../services/adminApi';
import { useFilters, usePagination } from '../../hooks';

// Backend ImpersonationReason enum values (StartImpersonationDto validates
// against these) with operator-facing labels. Free text goes in reasonDetails.
const REASON_OPTIONS: Array<{ value: ImpersonationReasonCode; label: string }> = [
  { value: 'support_request', label: 'Support request' },
  { value: 'debugging', label: 'Debugging' },
  { value: 'configuration', label: 'Configuration' },
  { value: 'onboarding_assistance', label: 'Onboarding assistance' },
  { value: 'security_investigation', label: 'Security investigation' },
  { value: 'data_verification', label: 'Data verification' },
  { value: 'other', label: 'Other' },
];

// Simplified tenant type
interface SimpleTenant {
  id: string;
  name: string;
  slug: string;
  status: string;
  tier: string;
}

type TabType = 'active' | 'history' | 'permissions' | 'audit';

/**
 * The Active tab loads its rows in one call and filters them in the browser,
 * which is honest only because the set is bounded: a super-admin's concurrent
 * sessions are capped server-side well below this ceiling.
 */
const ACTIVE_SESSION_LIMIT = 100;

/** The all-sessions tab is server-paginated — this table grows without bound. */
const SESSION_HISTORY_PAGE_SIZE = 20;

// Loading skeleton component
const LoadingSkeleton: React.FC = () => (
  <div className="animate-pulse space-y-6">
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="h-24 bg-gray-200 rounded-lg" />
      ))}
    </div>
    <div className="h-12 bg-gray-200 rounded-lg w-1/3" />
    <div className="space-y-4">
      {[1, 2, 3].map((i) => (
        <div key={i} className="h-32 bg-gray-200 rounded-lg" />
      ))}
    </div>
  </div>
);

export const ImpersonationPage: React.FC = () => {
  const { user } = useAuthContext();
  const currentAdminId = user?.id ?? '';

  // Tenant list cache to avoid re-fetching 100 tenants on every page load (PERF-003)
  const tenantCacheRef = useRef<{ data: SimpleTenant[]; fetchedAt: number } | null>(null);
  const TENANT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  // State
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [activeSessions, setActiveSessions] = useState<readonly ImpersonationSession[]>([]);
  const [permissions, setPermissions] = useState<readonly ImpersonationPermission[]>([]);
  const [tenants, setTenants] = useState<SimpleTenant[]>([]);
  const [summary, setSummary] = useState<ImpersonationAuditSummary | null>(null);

  // The all-sessions table is its own data source: it is server-paginated, so
  // it cannot be derived by filtering a list loaded for another tab.
  const [historySessions, setHistorySessions] = useState<readonly ImpersonationSession[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyPagination = usePagination({ initialLimit: SESSION_HISTORY_PAGE_SIZE });
  const [activeTab, setActiveTab] = useState<TabType>('active');
  // `search` is debounced because the all-sessions tab sends it to the server;
  // the in-memory tabs read the immediate value.
  const { filters, debouncedFilters, setFilter } = useFilters<{
    search: string;
    status: string;
  }>({
    initialFilters: { search: '', status: 'all' },
    debounceKeys: ['search'],
  });
  const searchQuery = filters.search;
  const statusFilter = filters.status;

  // Modal states
  const [showStartModal, setShowStartModal] = useState(false);
  const [showPermissionModal, setShowPermissionModal] = useState(false);
  const [showActionsModal, setShowActionsModal] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  // Session actions modal
  const [selectedSession, setSelectedSession] = useState<ImpersonationSession | null>(null);
  const [sessionActions, setSessionActions] = useState<ImpersonationAction[]>([]);
  const [loadingActions, setLoadingActions] = useState(false);

  // Confirmation state
  const [confirmAction, setConfirmAction] = useState<{
    type: 'end' | 'revoke' | 'extend' | 'revoke_permission';
    id: string;
    title: string;
    message: string;
    data?: Record<string, unknown>;
  } | null>(null);

  // Start impersonation form — fields mirror the backend StartImpersonationDto
  // (targetTenantId/targetUserId/reason enum + free-text reasonDetails).
  const [startForm, setStartForm] = useState<{
    targetTenantId: string;
    reason: ImpersonationReasonCode | '';
    reasonDetails: string;
    targetUserId: string;
  }>({
    targetTenantId: '',
    reason: '',
    reasonDetails: '',
    targetUserId: '',
  });

  // Grant permission form
  const [permissionForm, setPermissionForm] = useState({
    tenantId: '',
    maxSessionDuration: 60,
    allowedActions: ['read'] as string[],
    reason: '',
    expiresAt: '',
  });

  // Extend session form
  const [extendMinutes, setExtendMinutes] = useState(30);
  const [revokeReason, setRevokeReason] = useState('');

  // Fetch data
  const fetchData = useCallback(async () => {
    setLoading(true);
    const now = Date.now();

    // Use cached tenant list if still fresh (PERF-003)
    // apiFetch unwraps the API envelope, so tenantsApi.search() returns Tenant[] directly
    const tenantsPromise: Promise<SimpleTenant[]> =
      tenantCacheRef.current && now - tenantCacheRef.current.fetchedAt < TENANT_CACHE_TTL
        ? Promise.resolve(tenantCacheRef.current.data)
        : tenantsApi.search('', 100).then((res) => {
            const mapped = res.map((t) => ({ id: t.id, name: t.name, slug: t.slug, status: t.status, tier: t.tier }));
            tenantCacheRef.current = { data: mapped, fetchedAt: Date.now() };
            return mapped;
          });

    try {
      const [sessionsRes, permissionsRes, summaryRes, tenantsRes] = await Promise.allSettled([
        // Only the live sessions — the full list is the all-sessions tab's own
        // paginated query, not something to slice out of this one.
        impersonationApi.getSessions({ status: 'active', limit: ACTIVE_SESSION_LIMIT }),
        impersonationApi.getPermissions(),
        impersonationApi.getAuditSummary(),
        tenantsPromise,
      ]);

      setActiveSessions(sessionsRes.status === 'fulfilled' ? sessionsRes.value.data : []);
      setPermissions(permissionsRes.status === 'fulfilled' ? permissionsRes.value.data : []);
      setSummary(summaryRes.status === 'fulfilled' ? summaryRes.value : null);
      setTenants(tenantsRes.status === 'fulfilled' ? tenantsRes.value : []);
    } catch (error) {
      console.error('Failed to fetch impersonation data:', error);
      setActiveSessions([]);
      setPermissions([]);
      setSummary(null);
      setTenants([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  /**
   * The all-sessions page.
   *
   * Search and status go to the SERVER. Filtering a paginated table in the
   * browser answers "no results" for a session that exists on the next page,
   * and does so with no way for the operator to tell the difference.
   */
  const historyPage = historyPagination.page;
  const historyLimit = historyPagination.limit;
  const historySetTotal = historyPagination.setTotal;
  const fetchHistory = useCallback(async () => {
    setHistoryError(null);
    try {
      const result = await impersonationApi.getSessions({
        page: historyPage,
        limit: historyLimit,
        status:
          debouncedFilters.status === 'all'
            ? undefined
            : (debouncedFilters.status as ImpersonationSessionStatus),
        search: debouncedFilters.search || undefined,
      });
      setHistorySessions(result.data);
      historySetTotal(result.total);
    } catch (error) {
      setHistorySessions([]);
      historySetTotal(0);
      setHistoryError(
        error instanceof Error ? error.message : 'Failed to load session history',
      );
    }
  }, [historyPage, historyLimit, historySetTotal, debouncedFilters.status, debouncedFilters.search]);

  useEffect(() => {
    if (activeTab === 'history') {
      void fetchHistory();
    }
  }, [activeTab, fetchHistory]);

  // Computed values — wrapped in useMemo to avoid recomputing on every render (PERF-002)
  const activePermissions = useMemo(() => permissions.filter((p) => p.isActive), [permissions]);
  const revokedPermissions = useMemo(() => permissions.filter((p) => !p.isActive), [permissions]);

  /**
   * The period label for the windowed cards, derived from the window the
   * backend says it used.
   *
   * These cards read "(30d)" as a literal in the JSX while the number behind
   * them was an all-time count. Computing the label from `windowStart`/
   * `windowEnd` means the two cannot disagree: change the default window
   * server-side and the heading follows.
   */
  const windowLabel = useMemo(() => {
    if (summary === null) {
      return '';
    }
    const days = Math.round(
      (new Date(summary.windowEnd).getTime() - new Date(summary.windowStart).getTime()) /
        (24 * 60 * 60 * 1000),
    );
    return `(${days}d)`;
  }, [summary]);

  /**
   * Client-side filtering, and correct here: the live-session set is loaded
   * whole and bounded by the server's concurrent-session cap, so there is no
   * unseen page for a term to hide on.
   */
  const filteredActiveSessions = useMemo(() => activeSessions.filter((session) => {
    // targetTenantName/superAdminEmail are nullable backend columns — an
    // absent value simply cannot match a search term.
    return (
      !searchQuery ||
      (session.targetTenantName ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (session.superAdminEmail ?? '').toLowerCase().includes(searchQuery.toLowerCase())
    );
  }), [activeSessions, searchQuery]);

  const filteredPermissions = useMemo(() => permissions.filter((permission) => {
    const matchesSearch =
      !searchQuery ||
      permission.tenantName.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus =
      statusFilter === 'all' ||
      (statusFilter === 'active' ? permission.isActive : !permission.isActive);
    return matchesSearch && matchesStatus;
  }), [permissions, searchQuery, statusFilter]);

  // Handlers
  const handleStartImpersonation = async () => {
    // The submit button gates on these, but narrowing the '' union here keeps
    // the payload type exact (reason must be a backend enum value).
    if (!startForm.targetTenantId || !startForm.reason) return;
    setPageError(null);
    try {
      // The super-admin identity comes from the verified JWT on the backend;
      // the body carries ONLY StartImpersonationDto fields (forbidNonWhitelisted).
      await impersonationApi.startSession({
        targetTenantId: startForm.targetTenantId,
        targetTenantName: tenants.find((t) => t.id === startForm.targetTenantId)?.name,
        targetUserId: startForm.targetUserId || undefined,
        reason: startForm.reason,
        reasonDetails: startForm.reasonDetails || undefined,
      });
      setShowStartModal(false);
      setStartForm({ targetTenantId: '', reason: '', reasonDetails: '', targetUserId: '' });
      fetchData();
    } catch (error) {
      console.error('Failed to start impersonation:', error);
      setPageError(error instanceof Error ? error.message : 'Failed to start impersonation session. Please try again.');
    }
  };

  const handleEndSession = async (sessionId: string) => {
    try {
      await impersonationApi.endSession(sessionId);
      fetchData();
    } catch (error) {
      console.error('Failed to end session:', error);
    }
    setShowConfirmModal(false);
    setConfirmAction(null);
  };

  const handleExtendSession = async (sessionId: string, minutes: number) => {
    try {
      await impersonationApi.extendSession(sessionId, minutes);
      fetchData();
    } catch (error) {
      console.error('Failed to extend session:', error);
    }
    setShowConfirmModal(false);
    setConfirmAction(null);
  };

  const handleRevokeSession = async (sessionId: string, reason: string) => {
    try {
      // Terminate endpoint takes only { reason }; the terminating admin's
      // identity is derived from the JWT server-side.
      await impersonationApi.revokeSession(sessionId, reason);
      fetchData();
    } catch (error) {
      console.error('Failed to revoke session:', error);
      setPageError(error instanceof Error ? error.message : 'Failed to revoke session.');
    }
    setShowConfirmModal(false);
    setConfirmAction(null);
    setRevokeReason('');
  };

  const handleGrantPermission = async () => {
    setPageError(null);
    try {
      // Fix: backend DTO uses superAdminId (from currentAdminId) and allowedTenants
      await impersonationApi.grantPermission({
        superAdminId: currentAdminId,
        allowedTenants: [permissionForm.tenantId],
        maxSessionDurationMinutes: permissionForm.maxSessionDuration,
        notes: permissionForm.reason,
        expiresAt: permissionForm.expiresAt || undefined,
      });
      setShowPermissionModal(false);
      setPermissionForm({
        tenantId: '',
        maxSessionDuration: 60,
        allowedActions: ['read'],
        reason: '',
        expiresAt: '',
      });
      fetchData();
    } catch (error) {
      console.error('Failed to grant permission:', error);
      setPageError(error instanceof Error ? error.message : 'Failed to grant permission. Please try again.');
    }
  };

  const handleRevokePermission = async (permissionId: string, reason: string) => {
    try {
      await impersonationApi.revokePermission(permissionId, currentAdminId, reason);
      fetchData();
    } catch (error) {
      console.error('Failed to revoke permission:', error);
      setPageError(error instanceof Error ? error.message : 'Failed to revoke permission.');
    }
    setShowConfirmModal(false);
    setConfirmAction(null);
    setRevokeReason('');
  };

  const handleViewActions = async (session: ImpersonationSession) => {
    setSelectedSession(session);
    setShowActionsModal(true);
    setLoadingActions(true);
    try {
      const actions = await impersonationApi.getSessionActions(session.id);
      setSessionActions(actions);
    } catch (error) {
      console.error('Failed to fetch session actions:', error);
      setSessionActions([]);
    } finally {
      setLoadingActions(false);
    }
  };

  // Utility functions
  const getStatusBadge = (status: string) => {
    // Keys mirror the backend ImpersonationStatus enum ('terminated', not 'revoked').
    const variants: Record<string, 'success' | 'error' | 'warning' | 'default'> = {
      active: 'success',
      ended: 'default',
      expired: 'warning',
      terminated: 'error',
    };
    return variants[status] || 'default';
  };

  const formatDate = (date: string) => new Date(date).toLocaleString();

  const formatDuration = (start: string, end?: string) => {
    const startTime = new Date(start).getTime();
    const endTime = end ? new Date(end).getTime() : Date.now();
    const minutes = Math.round((endTime - startTime) / 60000);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remainingMins = minutes % 60;
    return `${hours}h ${remainingMins}m`;
  };

  const getTimeRemaining = (expiresAt: string) => {
    const remaining = new Date(expiresAt).getTime() - Date.now();
    if (remaining <= 0) return 'Expired';
    const minutes = Math.round(remaining / 60000);
    if (minutes < 60) return `${minutes} min remaining`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m remaining`;
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Tenant Impersonation</h1>
          <p className="text-gray-600 mt-1">Securely access tenant accounts for support and debugging</p>
        </div>
        <LoadingSkeleton />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tenant Impersonation</h1>
          <p className="text-gray-600 mt-1">Securely access tenant accounts for support and debugging</p>
        </div>
        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => setShowPermissionModal(true)}>
            Grant Permission
          </Button>
          <Button variant="primary" onClick={() => setShowStartModal(true)}>
            Start Impersonation
          </Button>
        </div>
      </div>

      {/* Page-level error display */}
      {pageError && (
        <Alert type="error" dismissible onDismiss={() => setPageError(null)}>
          {pageError}
        </Alert>
      )}

      {/* Active Session Banner */}
      {activeSessions.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 bg-yellow-500 rounded-full animate-pulse" />
              <div>
                <div className="font-medium text-yellow-800">
                  {activeSessions.length} Active Impersonation Session{activeSessions.length > 1 ? 's' : ''}
                </div>
                <div className="text-sm text-yellow-700">
                  Currently impersonating: {activeSessions.map((s) => s.targetTenantName ?? s.targetTenantId).join(', ')}
                </div>
              </div>
            </div>
            {activeSessions.length === 1 && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-yellow-700">
                  {getTimeRemaining(activeSessions[0].expiresAt)}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setConfirmAction({
                      type: 'end',
                      id: activeSessions[0].id,
                      title: 'End Session',
                      message: `Are you sure you want to end the impersonation session for ${activeSessions[0].targetTenantName ?? activeSessions[0].targetTenantId}?`,
                    });
                    setShowConfirmModal(true);
                  }}
                >
                  End Session
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Active Sessions</p>
              <p className="text-2xl font-bold text-green-600">
                {summary === null ? '—' : summary.activeSessionsNow}
              </p>
            </div>
            <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
              <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Total Sessions {windowLabel}</p>
              <p className="text-2xl font-bold text-gray-900">
                {summary === null ? '—' : summary.totalSessionsInWindow}
              </p>
            </div>
            <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center">
              <svg className="w-6 h-6 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Active Permissions</p>
              <p className="text-2xl font-bold text-blue-600">
                {summary === null ? '—' : summary.activePermissionsNow}
              </p>
            </div>
            <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center">
              <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Actions Logged {windowLabel}</p>
              <p className="text-2xl font-bold text-purple-600">
                {summary === null ? '—' : summary.actionsLoggedInWindow}
              </p>
            </div>
            <div className="w-12 h-12 bg-purple-100 rounded-full flex items-center justify-center">
              <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
              </svg>
            </div>
          </div>
        </Card>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-8">
          {[
            { id: 'active' as TabType, label: 'Active Sessions', count: activeSessions.length },
            // "All Sessions", not "History": this table is one server-paginated
            // query over every session, and the Status column distinguishes the
            // live ones. Calling it history while it is fed by a single
            // unfiltered page is how the tab came to silently show only the 20
            // most recent sessions of an unbounded table.
            { id: 'history' as TabType, label: 'All Sessions', count: historyPagination.total },
            { id: 'permissions' as TabType, label: 'Permissions', count: activePermissions.length },
            { id: 'audit' as TabType, label: 'Audit Summary' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`py-3 border-b-2 font-medium text-sm transition-colors ${
                activeTab === tab.id
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.label}
              {tab.count !== undefined && (
                <span className={`ml-2 px-2 py-0.5 rounded-full text-xs ${
                  activeTab === tab.id ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-600'
                }`}>
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* Search and Filters */}
      {activeTab !== 'audit' && (
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1">
            <Input
              placeholder={activeTab === 'permissions' ? 'Search tenants...' : 'Search sessions...'}
              value={searchQuery}
              onChange={(e) => setFilter('search', e.target.value)}
              className="w-full"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setFilter('status', e.target.value)}
            className="w-full md:w-48 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="all">All Status</option>
            {activeTab === 'permissions' ? (
              <>
                <option value="active">Active</option>
                <option value="revoked">Revoked</option>
              </>
            ) : (
              <>
                {/* Session statuses mirror the backend enum — operator override is 'terminated'. */}
                <option value="active">Active</option>
                <option value="ended">Ended</option>
                <option value="expired">Expired</option>
                <option value="terminated">Terminated</option>
              </>
            )}
          </select>
        </div>
      )}

      {/* Active Sessions Tab */}
      {activeTab === 'active' && (
        <div className="space-y-4">
          {filteredActiveSessions.length === 0 ? (
            <Card className="p-8 text-center">
              <div className="text-gray-500 mb-4">
                <svg className="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              </div>
              <p className="text-gray-500">No active impersonation sessions</p>
              <Button variant="primary" className="mt-4" onClick={() => setShowStartModal(true)}>
                Start Impersonation
              </Button>
            </Card>
          ) : (
            filteredActiveSessions.map((session) => (
              <Card key={session.id} className="p-6">
                <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-lg font-semibold text-gray-900">{session.targetTenantName ?? session.targetTenantId}</h3>
                      <Badge variant={getStatusBadge(session.status)}>{session.status}</Badge>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm text-gray-600 mb-3">
                      <div>
                        <span className="text-gray-500">Admin:</span> {session.superAdminEmail ?? session.superAdminId}
                      </div>
                      {session.targetUserId && (
                        <div>
                          <span className="text-gray-500">As User:</span> {session.targetUserEmail ?? session.targetUserId}
                        </div>
                      )}
                      <div>
                        <span className="text-gray-500">Started:</span> {formatDate(session.createdAt)}
                      </div>
                      <div>
                        <span className="text-gray-500">Expires:</span> {formatDate(session.expiresAt)}
                      </div>
                      <div>
                        <span className="text-gray-500">IP Address:</span> {session.ipAddress ?? '-'}
                      </div>
                      <div>
                        <span className="text-gray-500">Actions:</span> {session.actionCount}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <div className={`px-3 py-1 rounded-full text-sm font-medium ${
                        new Date(session.expiresAt).getTime() - Date.now() < 10 * 60 * 1000
                          ? 'bg-red-100 text-red-700'
                          : 'bg-blue-100 text-blue-700'
                      }`}>
                        {getTimeRemaining(session.expiresAt)}
                      </div>
                      <span className="text-sm text-gray-500">
                        Duration: {formatDuration(session.createdAt)}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleViewActions(session)}
                    >
                      View Actions
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setConfirmAction({
                          type: 'extend',
                          id: session.id,
                          title: 'Extend Session',
                          message: `Extend the impersonation session for ${session.targetTenantName ?? session.targetTenantId}`,
                        });
                        setShowConfirmModal(true);
                      }}
                    >
                      Extend
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        // Open tenant portal in a new tab with the impersonation session's access token
                        const tenantPortalUrl = `/tenant?impersonation_session=${session.id}`;
                        window.open(tenantPortalUrl, '_blank', 'noopener,noreferrer');
                      }}
                    >
                      Open Tenant Portal
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => {
                        setConfirmAction({
                          type: 'end',
                          id: session.id,
                          title: 'End Session',
                          message: `Are you sure you want to end the impersonation session for ${session.targetTenantName ?? session.targetTenantId}?`,
                        });
                        setShowConfirmModal(true);
                      }}
                    >
                      End Session
                    </Button>
                  </div>
                </div>
              </Card>
            ))
          )}
        </div>
      )}

      {/* History Tab */}
      {activeTab === 'history' && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Tenant
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Admin
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Duration
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Date
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Details
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {historySessions.map((session) => (
                    <tr key={session.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="font-medium text-gray-900">{session.targetTenantName ?? session.targetTenantId}</div>
                        <div className="text-sm text-gray-500">{session.targetTenantId}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        {session.superAdminEmail ?? session.superAdminId}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <Badge variant={getStatusBadge(session.status)}>{session.status}</Badge>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        {formatDuration(session.createdAt, session.endedAt)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        {session.actionCount}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        {formatDate(session.createdAt)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleViewActions(session)}
                        >
                          View
                        </Button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {historyError !== null && (
              <div className="text-center py-8 text-red-600">{historyError}</div>
            )}
            {historyError === null && historySessions.length === 0 && (
              <div className="text-center py-8 text-gray-500">No sessions found</div>
            )}
          </div>
          {historyPagination.totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-gray-200 px-6 py-3">
              <span className="text-sm text-gray-600">
                Page {historyPagination.page} of {historyPagination.totalPages} (
                {historyPagination.total.toLocaleString()} sessions)
              </span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!historyPagination.canPrev}
                  onClick={historyPagination.prevPage}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!historyPagination.canNext}
                  onClick={historyPagination.nextPage}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Permissions Tab */}
      {activeTab === 'permissions' && (
        <div className="space-y-6">
          {/* Active Permissions */}
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Active Permissions</h3>
            {activePermissions.length === 0 ? (
              <Card className="p-6 text-center text-gray-500">
                No active permissions
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {filteredPermissions
                  .filter((p) => p.isActive)
                  .map((permission) => (
                    <Card key={permission.id} className="p-4">
                      <div className="flex justify-between items-start mb-3">
                        <div>
                          <h4 className="font-medium text-gray-900">{permission.tenantName}</h4>
                          <p className="text-sm text-gray-500">{permission.tenantId}</p>
                        </div>
                        <Badge variant="success">Active</Badge>
                      </div>

                      <div className="space-y-2 text-sm text-gray-600 mb-3">
                        <div>
                          <span className="text-gray-500">Granted by:</span> {permission.grantedByEmail}
                        </div>
                        <div>
                          <span className="text-gray-500">Max Duration:</span> {permission.maxSessionDuration} min
                        </div>
                        <div>
                          <span className="text-gray-500">Allowed Actions:</span>{' '}
                          {permission.allowedActions.join(', ')}
                        </div>
                        {permission.expiresAt && (
                          <div>
                            <span className="text-gray-500">Expires:</span> {formatDate(permission.expiresAt)}
                          </div>
                        )}
                        {permission.reason && (
                          <div>
                            <span className="text-gray-500">Reason:</span> {permission.reason}
                          </div>
                        )}
                      </div>

                      <div className="flex justify-end gap-2">
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => {
                            setConfirmAction({
                              type: 'revoke_permission',
                              id: permission.id,
                              title: 'Revoke Permission',
                              message: `Are you sure you want to revoke impersonation permission for ${permission.tenantName}?`,
                            });
                            setShowConfirmModal(true);
                          }}
                        >
                          Revoke
                        </Button>
                      </div>
                    </Card>
                  ))}
              </div>
            )}
          </div>

          {/* Revoked Permissions */}
          {revokedPermissions.length > 0 && (
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Revoked Permissions</h3>
              <Card className="overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Tenant</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Granted By</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Revoked By</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Revoked At</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {revokedPermissions.map((permission) => (
                      <tr key={permission.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="font-medium text-gray-900">{permission.tenantName}</div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                          {permission.grantedByEmail}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                          {permission.revokedBy || '-'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                          {permission.revokedAt ? formatDate(permission.revokedAt) : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </div>
          )}
        </div>
      )}

      {/* Audit Tab */}
      {activeTab === 'audit' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Top Impersonating Admins</h3>
            {(summary?.topImpersonatorsInWindow ?? []).length === 0 ? (
              <p className="text-sm text-gray-500">No admin activity data available.</p>
            ) : (
              <div className="space-y-4">
                {(summary?.topImpersonatorsInWindow ?? []).map((admin, index) => (
                  <div key={admin.adminId} className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                        index === 0 ? 'bg-yellow-100 text-yellow-700' :
                        index === 1 ? 'bg-gray-200 text-gray-700' :
                        index === 2 ? 'bg-orange-100 text-orange-700' :
                        'bg-gray-100 text-gray-600'
                      }`}>
                        {index + 1}
                      </div>
                      <span className="text-gray-900">{admin.email}</span>
                    </div>
                    <span className="font-medium text-gray-600">{admin.sessionCount} sessions</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Session Status Distribution</h3>
            <div className="grid grid-cols-2 gap-4">
              {[
                { status: 'Active now', count: summary?.activeSessionsNow ?? 0, color: 'bg-blue-500' },
                { status: `Total ${windowLabel}`, count: summary?.totalSessionsInWindow ?? 0, color: 'bg-green-500' },
              ].map((item) => (
                <div key={item.status} className="flex items-center gap-3">
                  <div className={`w-3 h-3 rounded-full ${item.color}`} />
                  <div>
                    <div className="text-sm text-gray-600">{item.status}</div>
                    <div className="font-semibold">{item.count}</div>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-4">Detailed breakdown available via audit log export.</p>
          </Card>

          <Card className="p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Recent Activity</h3>
            {(summary?.recentSessionsInWindow ?? []).length === 0 ? (
              <p className="text-sm text-gray-500">No recent session activity.</p>
            ) : (
              <div className="space-y-3">
                {(summary?.recentSessionsInWindow ?? []).slice(0, 5).map((session) => (
                  <div key={session.id} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                    <div>
                      <div className="font-medium text-gray-900">{session.targetTenantName ?? session.targetTenantId}</div>
                      <div className="text-sm text-gray-500">{session.superAdminEmail ?? session.superAdminId}</div>
                    </div>
                    <Badge variant={getStatusBadge(session.status)}>{session.status}</Badge>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Start Impersonation Modal */}
      {showStartModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-lg">
            <div className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">Start Impersonation Session</h2>

              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6">
                <div className="flex gap-3">
                  <svg className="w-5 h-5 text-yellow-600 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <div className="text-sm text-yellow-800">
                    <p className="font-medium">Security Notice</p>
                    <p>All actions performed during impersonation are logged and audited. Only impersonate when necessary and with proper authorization.</p>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Select Tenant <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={startForm.targetTenantId}
                    onChange={(e) => setStartForm({ ...startForm, targetTenantId: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">Choose a tenant...</option>
                    {tenants.map((tenant) => (
                      <option key={tenant.id} value={tenant.id}>
                        {tenant.name} ({tenant.tier}) - {tenant.status}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Impersonate Specific User (Optional)
                  </label>
                  <Input
                    placeholder="User ID (UUID)"
                    value={startForm.targetUserId}
                    onChange={(e) => setStartForm({ ...startForm, targetUserId: e.target.value })}
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Leave empty to impersonate as tenant admin
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Reason <span className="text-red-500">*</span>
                  </label>
                  {/* The backend validates reason against its ImpersonationReason
                      enum; free text belongs in the details field below. */}
                  <select
                    value={startForm.reason}
                    onChange={(e) => {
                      // Narrow via the option catalogue instead of a type
                      // assertion — only real enum values reach the form state.
                      const selected = REASON_OPTIONS.find((option) => option.value === e.target.value);
                      setStartForm({ ...startForm, reason: selected ? selected.value : '' });
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">Choose a reason...</option>
                    {REASON_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Details (Optional)
                  </label>
                  <textarea
                    value={startForm.reasonDetails}
                    onChange={(e) => setStartForm({ ...startForm, reasonDetails: e.target.value })}
                    rows={3}
                    placeholder="Describe why you need to impersonate this tenant..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 mt-6">
                <Button variant="secondary" onClick={() => setShowStartModal(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleStartImpersonation}
                  disabled={!startForm.targetTenantId || !startForm.reason}
                >
                  Start Session
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Grant Permission Modal */}
      {showPermissionModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-lg">
            <div className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">Grant Impersonation Permission</h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Select Tenant <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={permissionForm.tenantId}
                    onChange={(e) => setPermissionForm({ ...permissionForm, tenantId: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">Choose a tenant...</option>
                    {tenants.map((tenant) => (
                      <option key={tenant.id} value={tenant.id}>
                        {tenant.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Max Session Duration (minutes)
                  </label>
                  <Input
                    type="number"
                    min={15}
                    max={480}
                    value={permissionForm.maxSessionDuration}
                    onChange={(e) => setPermissionForm({ ...permissionForm, maxSessionDuration: parseInt(e.target.value) || 60 })}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Allowed Actions
                  </label>
                  <div className="flex gap-4">
                    {['read', 'write', 'admin'].map((action) => (
                      <label key={action} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={permissionForm.allowedActions.includes(action)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setPermissionForm({
                                ...permissionForm,
                                allowedActions: [...permissionForm.allowedActions, action],
                              });
                            } else {
                              setPermissionForm({
                                ...permissionForm,
                                allowedActions: permissionForm.allowedActions.filter((a) => a !== action),
                              });
                            }
                          }}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-sm text-gray-700 capitalize">{action}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Expires At (Optional)
                  </label>
                  <Input
                    type="datetime-local"
                    value={permissionForm.expiresAt}
                    onChange={(e) => setPermissionForm({ ...permissionForm, expiresAt: e.target.value })}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Reason <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    value={permissionForm.reason}
                    onChange={(e) => setPermissionForm({ ...permissionForm, reason: e.target.value })}
                    rows={3}
                    placeholder="Reason for granting permission..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 mt-6">
                <Button variant="secondary" onClick={() => setShowPermissionModal(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleGrantPermission}
                  disabled={!permissionForm.tenantId || !permissionForm.reason}
                >
                  Grant Permission
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Session Actions Modal */}
      {showActionsModal && selectedSession && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-200">
              <div className="flex justify-between items-start">
                <div>
                  <h2 className="text-xl font-bold text-gray-900">Session Actions</h2>
                  <p className="text-sm text-gray-500 mt-1">
                    {selectedSession.targetTenantName ?? selectedSession.targetTenantId} - {selectedSession.superAdminEmail ?? selectedSession.superAdminId}
                  </p>
                </div>
                <button
                  onClick={() => {
                    setShowActionsModal(false);
                    setSelectedSession(null);
                    setSessionActions([]);
                  }}
                  className="text-gray-500 hover:text-gray-600"
                >
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {loadingActions ? (
                <div className="flex items-center justify-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
                </div>
              ) : sessionActions.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  No actions recorded for this session
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Backend action entries carry no id — the timestamp+index pair keys the list. */}
                  {sessionActions.map((action, index) => (
                    <div key={`${action.timestamp}-${index}`} className="flex gap-4 p-3 bg-gray-50 rounded-lg">
                      <div className="flex-shrink-0 w-2 h-2 mt-2 bg-blue-500 rounded-full" />
                      <div className="flex-1">
                        <div className="flex justify-between items-start">
                          <div className="font-medium text-gray-900">{action.action}</div>
                          <div className="text-xs text-gray-500">
                            {formatDate(action.timestamp)}
                          </div>
                        </div>
                        <div className="text-sm text-gray-600 mt-1">
                          {action.resource}
                          {action.resourceId ? `: ${action.resourceId}` : ''}
                        </div>
                        {action.details && typeof action.details === 'object' && (
                          <pre className="text-xs text-gray-500 mt-2 bg-gray-100 p-2 rounded overflow-x-auto">
                            {JSON.stringify(
                              // Whitelist only primitive-valued keys to prevent leaking nested objects (SEC-008)
                              Object.fromEntries(
                                Object.entries(action.details).filter(([, v]) =>
                                  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
                                )
                              ),
                              null,
                              2
                            )}
                          </pre>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="p-6 border-t border-gray-200">
              <Button
                variant="secondary"
                onClick={() => {
                  setShowActionsModal(false);
                  setSelectedSession(null);
                  setSessionActions([]);
                }}
                className="w-full"
              >
                Close
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Confirm Modal */}
      {showConfirmModal && confirmAction && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-md">
            <div className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-2">{confirmAction.title}</h2>
              <p className="text-gray-600 mb-4">{confirmAction.message}</p>

              {confirmAction.type === 'extend' && (
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Extend by (minutes)
                  </label>
                  <Input
                    type="number"
                    min={15}
                    max={120}
                    value={extendMinutes}
                    onChange={(e) => setExtendMinutes(parseInt(e.target.value) || 30)}
                  />
                </div>
              )}

              {(confirmAction.type === 'revoke' || confirmAction.type === 'revoke_permission') && (
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Reason (optional)
                  </label>
                  <textarea
                    value={revokeReason}
                    onChange={(e) => setRevokeReason(e.target.value)}
                    rows={2}
                    placeholder="Reason for revocation..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              )}

              <div className="flex justify-end gap-3">
                <Button
                  variant="secondary"
                  autoFocus={confirmAction.type !== 'extend'}
                  onClick={() => {
                    setShowConfirmModal(false);
                    setConfirmAction(null);
                    setRevokeReason('');
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant={confirmAction.type === 'extend' ? 'primary' : 'danger'}
                  autoFocus={confirmAction.type === 'extend'}
                  onClick={() => {
                    if (confirmAction.type === 'end') {
                      handleEndSession(confirmAction.id);
                    } else if (confirmAction.type === 'extend') {
                      handleExtendSession(confirmAction.id, extendMinutes);
                    } else if (confirmAction.type === 'revoke') {
                      handleRevokeSession(confirmAction.id, revokeReason);
                    } else if (confirmAction.type === 'revoke_permission') {
                      handleRevokePermission(confirmAction.id, revokeReason);
                    }
                  }}
                >
                  {confirmAction.type === 'extend' ? 'Extend' : 'Confirm'}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};

export default ImpersonationPage;
