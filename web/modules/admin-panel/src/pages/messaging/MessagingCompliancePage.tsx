/**
 * Messaging Compliance Page
 *
 * SUPER_ADMIN compliance dashboard for the messaging service.
 * Shows retention policies, legal holds, export jobs, compliance stats,
 * and an audit log operations-per-day chart.
 *
 * Wired to real admin-api-service endpoints:
 *   - GET  /messaging/compliance/stats
 *   - GET  /messaging/compliance/legal-holds
 *   - POST /messaging/compliance/legal-holds
 *   - DELETE /messaging/compliance/legal-holds/:id
 *
 * @see ADR-012 Phase 3 (Compliance)
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Card, Button, Badge, useAuthContext } from '@aquaculture/shared-ui';
import { useAsyncData } from '../../hooks/useAsyncData';
import {
  messagingApi,
  LEGAL_HOLD_MIN_RELEASE_REASON_CHARS,
} from '../../services/api/messaging';
import type {
  ComplianceStats,
  LegalHold,
  ExportRecord,
  RetentionBucket,
  DailyAuditData,
} from '../../services/api/messaging';
import { usersApi } from '../../services/api/users';
import type { User } from '../../services/types';

// ============================================================================
// Empty-state defaults (used before first API response)
// ============================================================================

const EMPTY_STATS: ComplianceStats = {
  messagesUnderLegalHold: 0,
  pendingRetentionCleanup: 0,
  activeExports: 0,
  complianceScore: 100,
  activeHoldsCount: 0,
  retentionPoliciesCount: 0,
  auditEntriesCount: 0,
};

// ============================================================================
// StatCard Component
// ============================================================================

const StatCard: React.FC<{
  title: string;
  value: string | number;
  subtitle?: string;
  color?: 'blue' | 'green' | 'yellow' | 'red' | 'purple';
}> = ({ title, value, subtitle, color = 'blue' }) => {
  const colorMap = {
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    green: 'bg-green-50 text-green-700 border-green-200',
    yellow: 'bg-yellow-50 text-yellow-700 border-yellow-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    purple: 'bg-purple-50 text-purple-700 border-purple-200',
  };

  return (
    <div className={`rounded-xl border p-5 ${colorMap[color]}`}>
      <p className="text-sm font-medium opacity-80">{title}</p>
      <p className="text-3xl font-bold mt-1">{value}</p>
      {subtitle && <p className="text-xs mt-1 opacity-60">{subtitle}</p>}
    </div>
  );
};

// ============================================================================
// StatusBadge Component
// ============================================================================

const HoldStatusBadge: React.FC<{ active: boolean }> = ({ active }) => (
  <span
    className={`px-2 py-0.5 text-xs font-semibold rounded-full ${
      active ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-600'
    }`}
  >
    {active ? 'ACTIVE' : 'RELEASED'}
  </span>
);

const ExportStatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const map: Record<string, string> = {
    completed: 'bg-green-100 text-green-800',
    pending: 'bg-yellow-100 text-yellow-800',
    failed: 'bg-red-100 text-red-800',
  };
  return (
    <span className={`px-2 py-0.5 text-xs font-semibold rounded-full ${map[status] ?? 'bg-gray-100 text-gray-800'}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
};

// ============================================================================
// Audit Operations Chart (SVG bar chart)
// ============================================================================

const AuditOperationsChart: React.FC<{ data: DailyAuditData[]; height?: number }> = ({
  data,
  height = 160,
}) => {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center text-gray-400 text-sm" style={{ height }}>
        No audit data available
      </div>
    );
  }
  const maxVal = Math.max(...data.map((d) => d.count), 1);
  const barWidth = Math.max(12, Math.floor(400 / data.length) - 4);
  return (
    <svg viewBox={`0 0 ${data.length * (barWidth + 4)} ${height}`} className="w-full" style={{ height }}>
      {data.map((d, i) => {
        const barHeight = (d.count / maxVal) * (height - 20);
        return (
          <g key={d.date}>
            <rect
              x={i * (barWidth + 4)}
              y={height - 20 - barHeight}
              width={barWidth}
              height={barHeight}
              rx={3}
              className="fill-indigo-500"
            />
            <text
              x={i * (barWidth + 4) + barWidth / 2}
              y={height - 4}
              textAnchor="middle"
              className="fill-gray-500"
              fontSize="7"
            >
              {d.date.slice(5)}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

// ============================================================================
// RetentionChart Component
// ============================================================================

const RetentionChart: React.FC<{ buckets: RetentionBucket[] }> = ({ buckets }) => {
  const maxCount = Math.max(...buckets.map((b) => b.tenantCount), 1);

  if (buckets.every((b) => b.tenantCount === 0)) {
    return (
      <div className="flex items-center justify-center text-gray-400 text-sm py-8">
        No retention data available
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {buckets.map((bucket) => (
        <div key={bucket.label} className="flex items-center gap-3">
          <span className="text-xs text-gray-600 w-20 text-right">{bucket.label}</span>
          <div className="flex-1 bg-gray-100 rounded-full h-5 overflow-hidden">
            <div
              className={`h-full rounded-full ${bucket.color} transition-all duration-500`}
              style={{ width: `${(bucket.tenantCount / maxCount) * 100}%` }}
            />
          </div>
          <span className="text-xs text-gray-500 w-8">{bucket.tenantCount}</span>
        </div>
      ))}
    </div>
  );
};

// ============================================================================
// ErrorBanner Component
// ============================================================================

const ErrorBanner: React.FC<{
  message: string;
  onRetry?: () => void;
  canRetry?: boolean;
}> = ({ message, onRetry, canRetry }) => (
  <div className="rounded-lg border border-red-200 bg-red-50 p-4 flex items-center justify-between">
    <div className="flex items-center gap-2">
      <svg className="w-5 h-5 text-red-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
      </svg>
      <p className="text-sm text-red-700">{message}</p>
    </div>
    {canRetry && onRetry && (
      <button
        onClick={onRetry}
        className="text-xs px-3 py-1 rounded font-medium text-red-600 hover:bg-red-100"
      >
        Retry
      </button>
    )}
  </div>
);

// ============================================================================
// Main Component
// ============================================================================

const MessagingCompliancePage: React.FC = () => {
  // ── Mutation state for release/create ──
  const [releaseLoading, setReleaseLoading] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  // ── Release dialog state (dual-approver, LEGAL-MEDIUM-002 / APA-163) ──
  const { user: currentUser } = useAuthContext();
  const [releaseTarget, setReleaseTarget] = useState<LegalHold | null>(null);
  const [approverId, setApproverId] = useState<string>('');
  const [releaseReason, setReleaseReason] = useState<string>('');
  const [approvers, setApprovers] = useState<User[]>([]);
  const [approversLoading, setApproversLoading] = useState<boolean>(false);
  const [approversError, setApproversError] = useState<string | null>(null);

  // ── Compliance Stats ──
  const statsQuery = useAsyncData<ComplianceStats>(
    () => messagingApi.getComplianceStats(),
    { cacheKey: 'messaging-compliance-stats', cacheTTL: 15_000 },
  );

  // ── Legal Holds ──
  const holdsQuery = useAsyncData<LegalHold[]>(
    () => messagingApi.getLegalHolds(),
    { cacheKey: 'messaging-compliance-legal-holds', cacheTTL: 15_000 },
  );

  const stats = statsQuery.data ?? EMPTY_STATS;
  const legalHolds = holdsQuery.data ?? [];

  // WHY: Exports, retention buckets, and daily audit data are not yet served
  // by dedicated endpoints. These sections render empty-state UI until
  // the messaging-service exposes the corresponding aggregation queries.
  const exports: ExportRecord[] = [];
  const retentionBuckets: RetentionBucket[] = [
    { label: '90 days', tenantCount: 0, color: 'bg-blue-500' },
    { label: '1 year', tenantCount: 0, color: 'bg-green-500' },
    { label: '3 years', tenantCount: 0, color: 'bg-yellow-500' },
    { label: 'Indefinite', tenantCount: 0, color: 'bg-purple-500' },
  ];
  const dailyAudit: DailyAuditData[] = [];

  const loading = statsQuery.loading || holdsQuery.loading;
  const queryError = statsQuery.error || holdsQuery.error;

  // ── Handlers ──

  const handleRefresh = useCallback(async (): Promise<void> => {
    setMutationError(null);
    await Promise.all([statsQuery.refresh(), holdsQuery.refresh()]);
  }, [statsQuery, holdsQuery]);

  /** Open the dual-approver release dialog for a specific hold. */
  const openReleaseDialog = useCallback((hold: LegalHold): void => {
    setReleaseTarget(hold);
    setApproverId('');
    setReleaseReason('');
    setMutationError(null);
  }, []);

  /** Close the release dialog and clear its inputs. */
  const closeReleaseDialog = useCallback((): void => {
    setReleaseTarget(null);
    setApproverId('');
    setReleaseReason('');
  }, []);

  // Load candidate approvers (active SUPER_ADMINs, excluding the current user
  // — the dual-approver protocol forbids self-approval) when the dialog opens.
  useEffect(() => {
    if (!releaseTarget) {
      return;
    }
    let cancelled = false;
    setApproversLoading(true);
    setApproversError(null);
    usersApi
      .list({ role: 'SUPER_ADMIN', limit: 100 })
      .then((res) => {
        if (cancelled) {
          return;
        }
        setApprovers(
          res.data.filter((u) => u.isActive && u.id !== currentUser?.id),
        );
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setApproversError(
          err instanceof Error ? err.message : 'Failed to load approvers',
        );
      })
      .finally(() => {
        if (!cancelled) {
          setApproversLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [releaseTarget, currentUser?.id]);

  const trimmedReason = releaseReason.trim();
  const reasonValid =
    trimmedReason.length >= LEGAL_HOLD_MIN_RELEASE_REASON_CHARS;
  const releaseValid =
    releaseTarget !== null && approverId !== '' && reasonValid;

  /** Submit the dual-approver release, then refresh stats + holds. */
  const submitRelease = useCallback(async (): Promise<void> => {
    if (releaseTarget === null || approverId === '' || !reasonValid) {
      return;
    }
    setReleaseLoading(releaseTarget.id);
    setMutationError(null);
    try {
      await messagingApi.releaseLegalHold(
        releaseTarget.id,
        releaseTarget.tenantId,
        { approverId, releaseReason: trimmedReason },
      );
      closeReleaseDialog();
      await Promise.all([statsQuery.refresh(), holdsQuery.refresh()]);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to release legal hold';
      setMutationError(message);
    } finally {
      setReleaseLoading(null);
    }
  }, [
    releaseTarget,
    approverId,
    reasonValid,
    trimmedReason,
    statsQuery,
    holdsQuery,
    closeReleaseDialog,
  ]);

  const handleDownloadExport = useCallback((exportId: string) => {
    const exportRecord = exports.find((e) => e.id === exportId);
    if (exportRecord?.downloadUrl) {
      window.open(exportRecord.downloadUrl, '_blank', 'noopener,noreferrer');
    }
  }, [exports]);

  const scoreColor = stats.complianceScore >= 90 ? 'green' : stats.complianceScore >= 70 ? 'yellow' : 'red';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Messaging Compliance</h1>
          <p className="text-sm text-gray-500 mt-1">
            Legal holds, data exports, retention compliance, and audit log summary
          </p>
        </div>
        <Button
          onClick={() => void handleRefresh()}
          disabled={loading}
          variant="secondary"
          size="sm"
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </Button>
      </div>

      {/* Error banners */}
      {queryError && (
        <ErrorBanner
          message={queryError}
          onRetry={() => void handleRefresh()}
          canRetry={statsQuery.canRetry || holdsQuery.canRetry}
        />
      )}
      {mutationError && (
        <ErrorBanner message={mutationError} />
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard
          title="Under Legal Hold"
          value={stats.messagesUnderLegalHold.toLocaleString()}
          subtitle="messages"
          color="red"
        />
        <StatCard
          title="Active Holds"
          value={stats.activeHoldsCount}
          color="yellow"
        />
        <StatCard
          title="Pending Cleanup"
          value={stats.pendingRetentionCleanup.toLocaleString()}
          subtitle="messages"
          color="purple"
        />
        <StatCard
          title="Retention Policies"
          value={stats.retentionPoliciesCount}
          color="blue"
        />
        <StatCard
          title="Active Exports"
          value={stats.activeExports}
          color="green"
        />
        <StatCard
          title="Compliance Score"
          value={`${stats.complianceScore}%`}
          color={scoreColor as 'green' | 'yellow' | 'red'}
        />
      </div>

      {/* Charts Row: Audit Summary + Retention Distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <div className="p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">Audit Operations Per Day</h3>
            <AuditOperationsChart data={dailyAudit} />
            <div className="mt-3 flex justify-between items-center">
              <span className="text-xs text-gray-400">Last 14 days</span>
              <span className="text-xs text-gray-500">
                Total: {stats.auditEntriesCount.toLocaleString()} entries
              </span>
            </div>
          </div>
        </Card>

        <Card>
          <div className="p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">Retention Distribution</h3>
            <RetentionChart buckets={retentionBuckets} />
            <div className="mt-4 space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-600">Messages Under Hold</span>
                <Badge variant={stats.messagesUnderLegalHold > 0 ? 'error' : 'success'}>
                  {stats.messagesUnderLegalHold.toLocaleString()}
                </Badge>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-600">Pending Retention Cleanup</span>
                <Badge variant={stats.pendingRetentionCleanup > 1000 ? 'warning' : 'success'}>
                  {stats.pendingRetentionCleanup.toLocaleString()}
                </Badge>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Legal Holds Table */}
      <Card>
        <div className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-700">Legal Holds</h3>
            <span className="text-xs text-gray-400">
              {legalHolds.filter((h) => h.isActive).length} active / {legalHolds.length} total
            </span>
          </div>
          {holdsQuery.loading && legalHolds.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <p className="text-sm text-gray-400">Loading legal holds...</p>
            </div>
          ) : legalHolds.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-center">
                <svg className="w-10 h-10 text-green-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-sm text-gray-500">No legal holds</p>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tenant</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Scope</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Reason</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Started</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Released</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {legalHolds.map((hold) => (
                    <tr key={hold.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <HoldStatusBadge active={hold.isActive} />
                      </td>
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{hold.tenantName}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {hold.channelName ?? 'Tenant-wide'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 max-w-xs truncate">{hold.reason}</td>
                      <td className="px-4 py-3 text-sm text-gray-500">
                        {new Date(hold.startedAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">
                        {hold.releasedAt ? new Date(hold.releasedAt).toLocaleDateString() : '--'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {hold.isActive && (
                          <button
                            onClick={() => openReleaseDialog(hold)}
                            disabled={releaseLoading === hold.id}
                            className="text-xs px-2 py-1 rounded font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                          >
                            {releaseLoading === hold.id ? 'Releasing...' : 'Release'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      {/* Exports Table */}
      <Card>
        <div className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-700">Export Jobs</h3>
            <span className="text-xs text-gray-400">
              {exports.filter((e) => e.status === 'completed').length} completed
            </span>
          </div>
          {exports.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">
              No export jobs found.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tenant</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Format</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Records</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Legal Hold</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Exported</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {exports.map((exp) => (
                    <tr key={exp.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{exp.tenantName}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 uppercase">{exp.format}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right">{exp.recordCount.toLocaleString()}</td>
                      <td className="px-4 py-3 text-center">
                        <ExportStatusBadge status={exp.status} />
                      </td>
                      <td className="px-4 py-3 text-center">
                        {exp.isUnderLegalHold && (
                          <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-red-100 text-red-800">
                            HOLD
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500 text-right">
                        {new Date(exp.createdAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {exp.status === 'completed' && exp.downloadUrl && (
                          <button
                            onClick={() => handleDownloadExport(exp.id)}
                            className="text-xs px-2 py-1 rounded font-medium text-blue-600 hover:bg-blue-50"
                          >
                            Download
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      {/* Release Legal Hold dialog (dual-approver, LEGAL-MEDIUM-002 / APA-163) */}
      {releaseTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 overflow-y-auto p-4">
          <Card className="w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h2 className="text-lg font-bold text-gray-900">Release Legal Hold</h2>
                <p className="text-sm text-gray-500 mt-1">
                  Releasing a hold requires a second, distinct SUPER_ADMIN to
                  countersign and a justification of at least{' '}
                  {LEGAL_HOLD_MIN_RELEASE_REASON_CHARS} characters.
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={closeReleaseDialog}>
                Close
              </Button>
            </div>

            <div className="space-y-2 mb-4 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-gray-500 flex-shrink-0">Scope</span>
                <span className="text-gray-800 text-right">
                  {releaseTarget.channelName ?? 'Tenant-wide'}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-gray-500 flex-shrink-0">Reason for hold</span>
                <span className="text-gray-800 text-right truncate">
                  {releaseTarget.reason}
                </span>
              </div>
            </div>

            {mutationError && (
              <div className="mb-4">
                <ErrorBanner message={mutationError} />
              </div>
            )}

            {/* Countersigning approver */}
            <div className="mb-4">
              <label
                htmlFor="release-approver"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Countersigning approver (second SUPER_ADMIN)
              </label>
              <select
                id="release-approver"
                value={approverId}
                onChange={(e) => setApproverId(e.target.value)}
                disabled={approversLoading}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
              >
                <option value="">
                  {approversLoading ? 'Loading approvers...' : 'Select an approver'}
                </option>
                {approvers.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.firstName} {a.lastName} ({a.email})
                  </option>
                ))}
              </select>
              {approversError && (
                <p className="text-xs text-red-600 mt-1">{approversError}</p>
              )}
              {!approversLoading && !approversError && approvers.length === 0 && (
                <p className="text-xs text-amber-600 mt-1">
                  No other SUPER_ADMIN is available to countersign. A second
                  SUPER_ADMIN account is required to release a hold.
                </p>
              )}
            </div>

            {/* Justification */}
            <div className="mb-4">
              <label
                htmlFor="release-reason"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Justification
              </label>
              <textarea
                id="release-reason"
                value={releaseReason}
                onChange={(e) => setReleaseReason(e.target.value)}
                rows={4}
                placeholder="Explain why this legal hold is being released (recorded on the audit trail)..."
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p
                className={`text-xs mt-1 ${
                  reasonValid ? 'text-gray-400' : 'text-amber-600'
                }`}
              >
                {trimmedReason.length}/{LEGAL_HOLD_MIN_RELEASE_REASON_CHARS} characters minimum
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={closeReleaseDialog}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => void submitRelease()}
                disabled={!releaseValid || releaseLoading === releaseTarget.id}
              >
                {releaseLoading === releaseTarget.id ? 'Releasing...' : 'Release hold'}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};

export default MessagingCompliancePage;
