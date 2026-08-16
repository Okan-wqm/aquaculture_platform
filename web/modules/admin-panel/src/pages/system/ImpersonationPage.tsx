import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Card, Button, Badge, Input, Alert, useAuthContext } from '@aquaculture/shared-ui';
import {
  IMPERSONATION_HANDOFF_FRAGMENT_FIELDS,
  isImpersonationContextId,
  isImpersonationCredential,
} from '@aquaculture/shared-contracts';
import {
  impersonationApi,
  tenantsApi,
  type ImpersonationSession,
  type ImpersonationSessionStatus,
  type ImpersonationReasonCode,
} from '../../services/adminApi';
import { useFilters } from '../../hooks';
import {
  beginAdminRead,
  rejectAdminRead,
  settleAdminRead,
  verifyAdminRead,
  type AdminReadRejectedEvidenceV1,
  type AdminReadState,
  type AdminReadVerifiedEvidenceV1,
} from '../../services/admin-read-evidence';
import { openAdminNavigation } from '../../services/browser-capabilities';
import type { AdminApiRouteResponse } from '../../services/types/generated/admin-route-contracts';

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

// Stats type
type ImpersonationStats = AdminApiRouteResponse<'GET /impersonation/stats'>;
type ImpersonationSessionPage = AdminApiRouteResponse<'GET /impersonation/sessions'>;
type ImpersonationPermissionPage = AdminApiRouteResponse<'GET /impersonation/permissions'>;

type TabType = 'active' | 'history' | 'permissions' | 'audit';

const SESSION_PAGE_SIZE = 20;
const SESSION_STATUS_VALUES: readonly ImpersonationSessionStatus[] = Object.freeze([
  'active',
  'ended',
  'expired',
  'terminated',
]);

function sessionStatusFromFilter(value: string): ImpersonationSessionStatus | undefined {
  return SESSION_STATUS_VALUES.find((status) => status === value);
}

interface RevealedSessionCredential {
  readonly credential: string;
  readonly targetTenantId: string;
}

interface ImpersonationBootstrapValue {
  readonly permissions: ImpersonationPermissionPage;
  readonly stats: ImpersonationStats;
  readonly tenants: readonly SimpleTenant[];
}

type ImpersonationBootstrapState =
  | { readonly outcome: 'PENDING' }
  | {
      readonly outcome: 'VERIFIED';
      readonly value: ImpersonationBootstrapValue;
      readonly evidence: readonly AdminReadVerifiedEvidenceV1[];
    }
  | {
      readonly outcome: 'REJECTED';
      readonly evidence: readonly AdminReadRejectedEvidenceV1[];
    };

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

const RejectedReadEvidence: React.FC<{
  readonly title: string;
  readonly evidence: readonly AdminReadRejectedEvidenceV1[];
  readonly onRetry: () => void;
}> = ({ title, evidence, onRetry }) => (
  <Card className="p-6">
    <Alert type="error">
      <div className="space-y-3">
        <p className="font-semibold">{title}</p>
        <p>
          No empty result or zero total was inferred. The rejected authority evidence is preserved
          below.
        </p>
        <ul className="space-y-2 text-sm">
          {evidence.map((entry) => (
            <li key={`${entry.authority}:${JSON.stringify(entry.coordinates)}`}>
              <div>
                <span className="font-medium">{entry.authority}</span> — {entry.failure.kind}:{' '}
                {entry.failure.message}
              </div>
              <div>
                Coordinates:{' '}
                {Object.entries(entry.coordinates)
                  .map(([key, value]) => `${key}=${String(value)}`)
                  .join(', ') || 'none'}
              </div>
              {(entry.failure.status !== undefined ||
                entry.failure.code !== undefined ||
                entry.failure.requestId !== undefined) && (
                <div>
                  Evidence:{' '}
                  {[
                    entry.failure.status === undefined
                      ? undefined
                      : `status=${entry.failure.status}`,
                    entry.failure.code === undefined ? undefined : `code=${entry.failure.code}`,
                    entry.failure.requestId === undefined
                      ? undefined
                      : `requestId=${entry.failure.requestId}`,
                  ]
                    .filter((value) => value !== undefined)
                    .join(', ')}
                </div>
              )}
            </li>
          ))}
        </ul>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Retry rejected read
        </Button>
      </div>
    </Alert>
  </Card>
);

const SessionPageControls: React.FC<{
  readonly page: ImpersonationSessionPage;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}> = ({ page, onPrevious, onNext }) => (
  <div className="flex items-center justify-between border-t border-gray-200 px-6 py-3">
    <span className="text-sm text-gray-600">
      Page {page.page} of {page.totalPages} ({page.total.toLocaleString()} sessions)
    </span>
    <div className="flex gap-2">
      <Button variant="secondary" size="sm" disabled={!page.hasPreviousPage} onClick={onPrevious}>
        Previous
      </Button>
      <Button variant="secondary" size="sm" disabled={!page.hasNextPage} onClick={onNext}>
        Next
      </Button>
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
  const [pageError, setPageError] = useState<string | null>(null);
  const [bootstrapRead, setBootstrapRead] = useState<ImpersonationBootstrapState>({
    outcome: 'PENDING',
  });
  const bootstrapGenerationRef = useRef(0);
  const [activeTab, setActiveTab] = useState<TabType>('active');
  const [activeSessionPage, setActiveSessionPage] = useState(1);
  const [historySessionPage, setHistorySessionPage] = useState(1);
  const [sessionReadAttempt, setSessionReadAttempt] = useState(0);
  const [sessionRead, setSessionRead] = useState<AdminReadState<ImpersonationSessionPage>>(() =>
    beginAdminRead('GET /impersonation/sessions', {
      page: 1,
      limit: SESSION_PAGE_SIZE,
      status: 'active',
    }),
  );
  const {
    filters: sessionFilters,
    debouncedFilters: debouncedSessionFilters,
    setFilter,
  } = useFilters<{ search: string; status: string }>({
    initialFilters: { search: '', status: 'all' },
    debounceKeys: ['search'],
  });
  const [permissionSearch, setPermissionSearch] = useState('');
  const [permissionStatus, setPermissionStatus] = useState('all');
  // Raw credentials are returned once and deliberately retained only for the
  // lifetime of this mounted page. Refreshing/unmounting requires a new session.
  const [sessionCredentials, setSessionCredentials] = useState<
    Readonly<Record<string, RevealedSessionCredential>>
  >({});

  // Modal states
  const [showStartModal, setShowStartModal] = useState(false);
  const [showPermissionModal, setShowPermissionModal] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

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

  // Fetch non-session authorities as one fail-closed bootstrap cut. A rejected
  // member rejects the cut; it can never become an empty list or a zero metric.
  const fetchData = useCallback(async (): Promise<void> => {
    const generation = ++bootstrapGenerationRef.current;
    setBootstrapRead({ outcome: 'PENDING' });
    const now = Date.now();

    // Use cached tenant list if still fresh (PERF-003)
    // apiFetch unwraps the API envelope, so tenantsApi.search() returns Tenant[] directly
    const tenantsPromise: Promise<SimpleTenant[]> =
      tenantCacheRef.current && now - tenantCacheRef.current.fetchedAt < TENANT_CACHE_TTL
        ? Promise.resolve(tenantCacheRef.current.data)
        : tenantsApi.search('', 100).then((res) => {
            const mapped = res.map((t) => ({
              id: t.id,
              name: t.name,
              slug: t.slug,
              status: t.status,
              tier: t.tier,
            }));
            tenantCacheRef.current = { data: mapped, fetchedAt: Date.now() };
            return mapped;
          });

    const permissionsPending = beginAdminRead('GET /impersonation/permissions', {
      page: 1,
      limit: 100,
    });
    const statsPending = beginAdminRead('GET /impersonation/stats', {});
    const tenantsPending = beginAdminRead('GET /admin/tenants/search', { q: '', limit: 100 });
    const [permissionsResult, statsResult, tenantsResult] = await Promise.allSettled([
      impersonationApi.getPermissions({ page: 1, limit: 100 }),
      impersonationApi.getImpersonationStats(),
      tenantsPromise,
    ]);

    if (generation !== bootstrapGenerationRef.current) {
      return;
    }

    const permissionsRead = settleAdminRead(permissionsPending, permissionsResult);
    const statsRead = settleAdminRead(statsPending, statsResult);
    const tenantsRead = settleAdminRead(tenantsPending, tenantsResult);

    if (
      permissionsRead.outcome === 'VERIFIED' &&
      statsRead.outcome === 'VERIFIED' &&
      tenantsRead.outcome === 'VERIFIED'
    ) {
      setBootstrapRead({
        outcome: 'VERIFIED',
        value: {
          permissions: permissionsRead.value,
          stats: statsRead.value,
          tenants: tenantsRead.value,
        },
        evidence: [permissionsRead.evidence, statsRead.evidence, tenantsRead.evidence],
      });
      return;
    }

    const rejectedEvidence: AdminReadRejectedEvidenceV1[] = [];
    if (permissionsRead.outcome === 'REJECTED') rejectedEvidence.push(permissionsRead.evidence);
    if (statsRead.outcome === 'REJECTED') rejectedEvidence.push(statsRead.evidence);
    if (tenantsRead.outcome === 'REJECTED') rejectedEvidence.push(tenantsRead.evidence);
    setBootstrapRead({ outcome: 'REJECTED', evidence: rejectedEvidence });
  }, []);

  useEffect(() => {
    void fetchData();
    return () => {
      bootstrapGenerationRef.current += 1;
    };
  }, [fetchData]);

  const selectedSessionPage = activeTab === 'active' ? activeSessionPage : historySessionPage;
  const selectedSessionStatus =
    activeTab === 'active' ? 'active' : sessionStatusFromFilter(debouncedSessionFilters.status);
  const selectedSessionSearch = debouncedSessionFilters.search.trim();

  useEffect(() => {
    if (activeTab !== 'active' && activeTab !== 'history') return;

    const coordinates = {
      page: selectedSessionPage,
      limit: SESSION_PAGE_SIZE,
      ...(selectedSessionStatus === undefined ? {} : { status: selectedSessionStatus }),
      ...(selectedSessionSearch === '' ? {} : { search: selectedSessionSearch }),
    };
    const pending = beginAdminRead('GET /impersonation/sessions', coordinates);
    const controller = new AbortController();
    setSessionRead(pending);

    void impersonationApi.getSessions(coordinates, { signal: controller.signal }).then(
      (page) => {
        if (!controller.signal.aborted) setSessionRead(verifyAdminRead(pending, page));
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setSessionRead(rejectAdminRead(pending, error));
      },
    );

    return () => controller.abort();
  }, [
    activeTab,
    selectedSessionPage,
    selectedSessionSearch,
    selectedSessionStatus,
    sessionReadAttempt,
  ]);

  if (bootstrapRead.outcome === 'PENDING') {
    return (
      <div className="p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Tenant Impersonation</h1>
          <p className="text-gray-600 mt-1">
            Securely access tenant accounts for support and debugging
          </p>
        </div>
        <LoadingSkeleton />
      </div>
    );
  }

  if (bootstrapRead.outcome === 'REJECTED') {
    return (
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tenant Impersonation</h1>
          <p className="text-gray-600 mt-1">
            Securely access tenant accounts for support and debugging
          </p>
        </div>
        <RejectedReadEvidence
          title="The impersonation bootstrap read was rejected"
          evidence={bootstrapRead.evidence}
          onRetry={() => void fetchData()}
        />
      </div>
    );
  }

  const { permissions: permissionPage, stats, tenants } = bootstrapRead.value;
  const permissions = permissionPage.items;
  const activePermissions = permissions.filter((permission) => permission.isActive);
  const revokedPermissions = permissions.filter((permission) => !permission.isActive);
  const normalizedPermissionSearch = permissionSearch.toLowerCase();
  const filteredPermissions = permissions.filter((permission) => {
    const matchesSearch =
      normalizedPermissionSearch === '' ||
      (permission.superAdminEmail ?? permission.superAdminId)
        .toLowerCase()
        .includes(normalizedPermissionSearch) ||
      (permission.allowedTenants ?? []).some((tenantId) =>
        tenantId.toLowerCase().includes(normalizedPermissionSearch),
      );
    const matchesStatus =
      permissionStatus === 'all' ||
      (permissionStatus === 'active' ? permission.isActive : !permission.isActive);
    return matchesSearch && matchesStatus;
  });

  const refreshPageData = async (): Promise<void> => {
    setSessionReadAttempt((attempt) => attempt + 1);
    await fetchData();
  };

  // Handlers
  const handleStartImpersonation = async (): Promise<void> => {
    // The submit button gates on these, but narrowing the '' union here keeps
    // the payload type exact (reason must be a backend enum value).
    if (!startForm.targetTenantId || !startForm.reason) return;
    setPageError(null);
    try {
      // The super-admin identity comes from the verified JWT on the backend;
      // the body carries ONLY StartImpersonationDto fields (forbidNonWhitelisted).
      const created = await impersonationApi.startSession({
        targetTenantId: startForm.targetTenantId,
        targetTenantName: tenants.find((t) => t.id === startForm.targetTenantId)?.name,
        targetUserId: startForm.targetUserId || undefined,
        reason: startForm.reason,
        reasonDetails: startForm.reasonDetails || undefined,
      });
      if (
        !isImpersonationContextId(created.id) ||
        !isImpersonationCredential(created.impersonationToken) ||
        !isImpersonationContextId(created.targetTenantId) ||
        created.targetTenantId !== startForm.targetTenantId
      ) {
        throw new Error('Impersonation authority returned an invalid one-time credential');
      }
      setSessionCredentials((current) => ({
        ...current,
        [created.id]: Object.freeze({
          credential: created.impersonationToken,
          targetTenantId: created.targetTenantId,
        }),
      }));
      setShowStartModal(false);
      setStartForm({ targetTenantId: '', reason: '', reasonDetails: '', targetUserId: '' });
      await refreshPageData();
    } catch (error) {
      setPageError(
        error instanceof Error
          ? error.message
          : 'Failed to start impersonation session. Please try again.',
      );
    }
  };

  const handleEndSession = async (sessionId: string): Promise<void> => {
    try {
      await impersonationApi.endSession(sessionId);
      setSessionCredentials((current) => {
        const next = { ...current };
        Reflect.deleteProperty(next, sessionId);
        return next;
      });
      await refreshPageData();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Failed to end session.');
    }
    setShowConfirmModal(false);
    setConfirmAction(null);
  };

  const handleExtendSession = async (sessionId: string, minutes: number): Promise<void> => {
    try {
      await impersonationApi.extendSession(sessionId, minutes);
      await refreshPageData();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Failed to extend session.');
    }
    setShowConfirmModal(false);
    setConfirmAction(null);
  };

  const handleRevokeSession = async (sessionId: string, reason: string): Promise<void> => {
    try {
      // Terminate endpoint takes only { reason }; the terminating admin's
      // identity is derived from the JWT server-side.
      await impersonationApi.revokeSession(sessionId, reason);
      setSessionCredentials((current) => {
        const next = { ...current };
        Reflect.deleteProperty(next, sessionId);
        return next;
      });
      await refreshPageData();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Failed to revoke session.');
    }
    setShowConfirmModal(false);
    setConfirmAction(null);
    setRevokeReason('');
  };

  const handleOpenTenantPortal = (session: ImpersonationSession): void => {
    const revealed = sessionCredentials[session.id];
    if (!revealed || revealed.targetTenantId !== session.targetTenantId) {
      setPageError(
        'This session credential is no longer available. End this session and start a new one before opening the tenant portal.',
      );
      return;
    }

    const fragment = new URLSearchParams([
      [IMPERSONATION_HANDOFF_FRAGMENT_FIELDS.sessionId, session.id],
      [IMPERSONATION_HANDOFF_FRAGMENT_FIELDS.credential, revealed.credential],
      [IMPERSONATION_HANDOFF_FRAGMENT_FIELDS.targetTenantId, revealed.targetTenantId],
    ]);
    openAdminNavigation(`/tenant#${fragment.toString()}`);
  };

  const handleGrantPermission = async (): Promise<void> => {
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
      await refreshPageData();
    } catch (error) {
      setPageError(
        error instanceof Error ? error.message : 'Failed to grant permission. Please try again.',
      );
    }
  };

  const handleRevokePermission = async (superAdminId: string, reason: string): Promise<void> => {
    try {
      await impersonationApi.revokePermission(superAdminId, currentAdminId, reason);
      await refreshPageData();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Failed to revoke permission.');
    }
    setShowConfirmModal(false);
    setConfirmAction(null);
    setRevokeReason('');
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

  const verifiedSessionPage = sessionRead.outcome === 'VERIFIED' ? sessionRead.value : undefined;
  const goToPreviousSessionPage = (): void => {
    if (verifiedSessionPage === undefined || !verifiedSessionPage.hasPreviousPage) return;
    if (activeTab === 'active') {
      setActiveSessionPage(verifiedSessionPage.page - 1);
    } else if (activeTab === 'history') {
      setHistorySessionPage(verifiedSessionPage.page - 1);
    }
  };
  const goToNextSessionPage = (): void => {
    if (verifiedSessionPage === undefined || !verifiedSessionPage.hasNextPage) return;
    if (activeTab === 'active') {
      setActiveSessionPage(verifiedSessionPage.page + 1);
    } else if (activeTab === 'history') {
      setHistorySessionPage(verifiedSessionPage.page + 1);
    }
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tenant Impersonation</h1>
          <p className="text-gray-600 mt-1">
            Securely access tenant accounts for support and debugging
          </p>
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

      {/* Active Session Banner: visible only from a contract-verified active page. */}
      {activeTab === 'active' &&
        verifiedSessionPage !== undefined &&
        verifiedSessionPage.items.length > 0 && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 bg-yellow-500 rounded-full animate-pulse" />
                <div>
                  <div className="font-medium text-yellow-800">
                    {verifiedSessionPage.total} Active Impersonation Session
                    {verifiedSessionPage.total > 1 ? 's' : ''}
                  </div>
                  <div className="text-sm text-yellow-700">
                    Targets on this page:{' '}
                    {verifiedSessionPage.items
                      .map((session) => session.targetTenantName ?? session.targetTenantId)
                      .join(', ')}
                  </div>
                </div>
              </div>
              {verifiedSessionPage.total === 1 && verifiedSessionPage.items[0] !== undefined && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-yellow-700">
                    {getTimeRemaining(verifiedSessionPage.items[0].expiresAt)}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setConfirmAction({
                        type: 'end',
                        id: verifiedSessionPage.items[0].id,
                        title: 'End Session',
                        message: `Are you sure you want to end the impersonation session for ${verifiedSessionPage.items[0].targetTenantName ?? verifiedSessionPage.items[0].targetTenantId}?`,
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
              <p className="text-2xl font-bold text-green-600">{stats.activeSessions}</p>
            </div>
            <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
              <svg
                className="w-6 h-6 text-green-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                />
              </svg>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Total Sessions</p>
              <p className="text-2xl font-bold text-gray-900">{stats.totalSessions}</p>
            </div>
            <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center">
              <svg
                className="w-6 h-6 text-gray-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                />
              </svg>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Active Permissions</p>
              <p className="text-2xl font-bold text-blue-600">{stats.activePermissions}</p>
            </div>
            <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center">
              <svg
                className="w-6 h-6 text-blue-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                />
              </svg>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Actions on Loaded Page</p>
              <p className="text-2xl font-bold text-purple-600">
                {verifiedSessionPage === undefined
                  ? '—'
                  : verifiedSessionPage.items.reduce(
                      (sum, session) => sum + session.actionCount,
                      0,
                    )}
              </p>
            </div>
            <div className="w-12 h-12 bg-purple-100 rounded-full flex items-center justify-center">
              <svg
                className="w-6 h-6 text-purple-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
                />
              </svg>
            </div>
          </div>
        </Card>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-8">
          {[
            { id: 'active' as TabType, label: 'Active Sessions', count: stats.activeSessions },
            {
              id: 'history' as TabType,
              label: 'All Sessions',
              count:
                activeTab === 'history' && verifiedSessionPage !== undefined
                  ? verifiedSessionPage.total
                  : undefined,
            },
            {
              id: 'permissions' as TabType,
              label: 'Permissions',
              count: stats.activePermissions,
            },
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
                <span
                  className={`ml-2 px-2 py-0.5 rounded-full text-xs ${
                    activeTab === tab.id ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-600'
                  }`}
                >
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
              value={activeTab === 'permissions' ? permissionSearch : sessionFilters.search}
              onChange={(event) => {
                if (activeTab === 'permissions') {
                  setPermissionSearch(event.target.value);
                } else {
                  setFilter('search', event.target.value);
                  setActiveSessionPage(1);
                  setHistorySessionPage(1);
                }
              }}
              className="w-full"
            />
          </div>
          {activeTab !== 'active' && (
            <select
              value={activeTab === 'permissions' ? permissionStatus : sessionFilters.status}
              onChange={(event) => {
                if (activeTab === 'permissions') {
                  setPermissionStatus(event.target.value);
                } else {
                  setFilter('status', event.target.value);
                  setHistorySessionPage(1);
                }
              }}
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
          )}
        </div>
      )}

      {/* Active Sessions Tab */}
      {activeTab === 'active' && (
        <div className="space-y-4">
          {sessionRead.outcome === 'PENDING' ? (
            <Card className="p-8 text-center text-gray-500">Loading verified session page…</Card>
          ) : sessionRead.outcome === 'REJECTED' ? (
            <RejectedReadEvidence
              title="The active-session page read was rejected"
              evidence={[sessionRead.evidence]}
              onRetry={() => setSessionReadAttempt((attempt) => attempt + 1)}
            />
          ) : sessionRead.value.items.length === 0 ? (
            <Card className="p-8 text-center">
              <div className="text-gray-500 mb-4">
                <svg
                  className="w-12 h-12 mx-auto"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                  />
                </svg>
              </div>
              <p className="text-gray-500">No active impersonation sessions</p>
              <Button variant="primary" className="mt-4" onClick={() => setShowStartModal(true)}>
                Start Impersonation
              </Button>
            </Card>
          ) : (
            <>
              {sessionRead.value.items.map((session) => (
                <Card key={session.id} className="p-6">
                  <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <h3 className="text-lg font-semibold text-gray-900">
                          {session.targetTenantName ?? session.targetTenantId}
                        </h3>
                        <Badge variant={getStatusBadge(session.status)}>{session.status}</Badge>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm text-gray-600 mb-3">
                        <div>
                          <span className="text-gray-500">Admin:</span>{' '}
                          {session.superAdminEmail ?? session.superAdminId}
                        </div>
                        {session.targetUserId && (
                          <div>
                            <span className="text-gray-500">As User:</span>{' '}
                            {session.targetUserEmail ?? session.targetUserId}
                          </div>
                        )}
                        <div>
                          <span className="text-gray-500">Started:</span>{' '}
                          {formatDate(session.createdAt)}
                        </div>
                        <div>
                          <span className="text-gray-500">Expires:</span>{' '}
                          {formatDate(session.expiresAt)}
                        </div>
                        <div>
                          <span className="text-gray-500">IP Address:</span>{' '}
                          {session.ipAddress ?? '-'}
                        </div>
                        <div>
                          <span className="text-gray-500">Actions:</span> {session.actionCount}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <div
                          className={`px-3 py-1 rounded-full text-sm font-medium ${
                            new Date(session.expiresAt).getTime() - Date.now() < 10 * 60 * 1000
                              ? 'bg-red-100 text-red-700'
                              : 'bg-blue-100 text-blue-700'
                          }`}
                        >
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
                        onClick={() => handleOpenTenantPortal(session)}
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
              ))}
              <Card className="overflow-hidden">
                <SessionPageControls
                  page={sessionRead.value}
                  onPrevious={goToPreviousSessionPage}
                  onNext={goToNextSessionPage}
                />
              </Card>
            </>
          )}
        </div>
      )}

      {/* History Tab */}
      {activeTab === 'history' && (
        <div className="space-y-4">
          {sessionRead.outcome === 'PENDING' ? (
            <Card className="p-8 text-center text-gray-500">Loading verified session page…</Card>
          ) : sessionRead.outcome === 'REJECTED' ? (
            <RejectedReadEvidence
              title="The all-sessions page read was rejected"
              evidence={[sessionRead.evidence]}
              onRetry={() => setSessionReadAttempt((attempt) => attempt + 1)}
            />
          ) : (
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
                    {sessionRead.value.items.map((session) => (
                      <tr key={session.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="font-medium text-gray-900">
                            {session.targetTenantName ?? session.targetTenantId}
                          </div>
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
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-500">
                          Durable audit only
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {sessionRead.value.items.length === 0 && (
                  <div className="text-center py-8 text-gray-500">No sessions found</div>
                )}
              </div>
              <SessionPageControls
                page={sessionRead.value}
                onPrevious={goToPreviousSessionPage}
                onNext={goToNextSessionPage}
              />
            </Card>
          )}
        </div>
      )}

      {/* Permissions Tab */}
      {activeTab === 'permissions' && (
        <div className="space-y-6">
          {/* Active Permissions */}
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Active Permissions</h3>
            {activePermissions.length === 0 ? (
              <Card className="p-6 text-center text-gray-500">No active permissions</Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {filteredPermissions
                  .filter((p) => p.isActive)
                  .map((permission) => (
                    <Card key={permission.id} className="p-4">
                      <div className="flex justify-between items-start mb-3">
                        <div>
                          <h4 className="font-medium text-gray-900">
                            {permission.superAdminEmail ?? permission.superAdminId}
                          </h4>
                          <p className="text-sm text-gray-500">{permission.superAdminId}</p>
                        </div>
                        <Badge variant="success">Active</Badge>
                      </div>

                      <div className="space-y-2 text-sm text-gray-600 mb-3">
                        <div>
                          <span className="text-gray-500">Granted by:</span>{' '}
                          {permission.grantedBy ?? 'System'}
                        </div>
                        <div>
                          <span className="text-gray-500">Max Duration:</span>{' '}
                          {permission.maxSessionDurationMinutes} min
                        </div>
                        <div>
                          <span className="text-gray-500">Tenant Scope:</span>{' '}
                          {permission.allowedTenants?.join(', ') || 'All tenants'}
                        </div>
                        {permission.expiresAt && (
                          <div>
                            <span className="text-gray-500">Expires:</span>{' '}
                            {formatDate(permission.expiresAt)}
                          </div>
                        )}
                        {permission.notes && (
                          <div>
                            <span className="text-gray-500">Notes:</span> {permission.notes}
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
                              id: permission.superAdminId,
                              title: 'Revoke Permission',
                              message: `Are you sure you want to revoke impersonation permission for ${permission.superAdminEmail ?? permission.superAdminId}?`,
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
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Administrator
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Granted By
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Tenant Scope
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Last Updated
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {revokedPermissions.map((permission) => (
                      <tr key={permission.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="font-medium text-gray-900">
                            {permission.superAdminEmail ?? permission.superAdminId}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                          {permission.grantedBy ?? 'System'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                          {permission.allowedTenants?.join(', ') || 'All tenants'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                          {formatDate(permission.updatedAt)}
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
            {stats.topAdmins.length === 0 ? (
              <p className="text-sm text-gray-500">No admin activity data available.</p>
            ) : (
              <div className="space-y-4">
                {stats.topAdmins.map((admin, index) => (
                  <div key={admin.adminId} className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                          index === 0
                            ? 'bg-yellow-100 text-yellow-700'
                            : index === 1
                              ? 'bg-gray-200 text-gray-700'
                              : index === 2
                                ? 'bg-orange-100 text-orange-700'
                                : 'bg-gray-100 text-gray-600'
                        }`}
                      >
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
            <h3 className="text-lg font-semibold text-gray-900 mb-4">
              Session Status Distribution
            </h3>
            <div className="grid grid-cols-2 gap-4">
              {[
                { status: 'Active', count: stats.activeSessions, color: 'bg-blue-500' },
                { status: 'Total', count: stats.totalSessions, color: 'bg-green-500' },
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
            <p className="text-xs text-gray-500 mt-4">
              Detailed breakdown available via audit log export.
            </p>
          </Card>

          <Card className="p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Recent Activity</h3>
            {stats.recentSessions.length === 0 ? (
              <p className="text-sm text-gray-500">No recent session activity.</p>
            ) : (
              <div className="space-y-3">
                {stats.recentSessions.slice(0, 5).map((session) => (
                  <div
                    key={session.id}
                    className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0"
                  >
                    <div>
                      <div className="font-medium text-gray-900">
                        {session.targetTenantName ?? session.targetTenantId}
                      </div>
                      <div className="text-sm text-gray-500">
                        {session.superAdminEmail ?? session.superAdminId}
                      </div>
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
                  <svg
                    className="w-5 h-5 text-yellow-600 mt-0.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                  <div className="text-sm text-yellow-800">
                    <p className="font-medium">Security Notice</p>
                    <p>
                      All actions performed during impersonation are logged and audited. Only
                      impersonate when necessary and with proper authorization.
                    </p>
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
                      const selected = REASON_OPTIONS.find(
                        (option) => option.value === e.target.value,
                      );
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
              <h2 className="text-xl font-bold text-gray-900 mb-4">
                Grant Impersonation Permission
              </h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Select Tenant <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={permissionForm.tenantId}
                    onChange={(e) =>
                      setPermissionForm({ ...permissionForm, tenantId: e.target.value })
                    }
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
                    onChange={(e) =>
                      setPermissionForm({
                        ...permissionForm,
                        maxSessionDuration: parseInt(e.target.value) || 60,
                      })
                    }
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
                                allowedActions: permissionForm.allowedActions.filter(
                                  (a) => a !== action,
                                ),
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
                    onChange={(e) =>
                      setPermissionForm({ ...permissionForm, expiresAt: e.target.value })
                    }
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Reason <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    value={permissionForm.reason}
                    onChange={(e) =>
                      setPermissionForm({ ...permissionForm, reason: e.target.value })
                    }
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
