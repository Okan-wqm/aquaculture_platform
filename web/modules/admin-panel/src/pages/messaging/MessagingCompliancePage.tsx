/**
 * Messaging Compliance Page — the litigation-hold surface that reported a
 * perfect score from two requests that always failed
 * (ADMIN-CRITICAL-147 / ADMIN-HIGH-121).
 *
 * Both of this page's reads went out WITHOUT a tenant id. The client's own
 * docblocks promised that omitting it returned "platform-wide stats" and
 * "all tenants" — a mode neither route has ever had:
 * `MessagingAdminController.getComplianceStats` and `.getLegalHolds` each
 * declare `@TenantParam('query') tenantId: string` with the default
 * `optional: false`, so `VerifiedTenantPipe` answers a request without one
 * with `BadRequestException('tenantId is required')`.
 *
 * So every load 400'd, and the page rendered its placeholder:
 *
 *   - **Compliance Score: 100%**, in green, from `EMPTY_STATS`;
 *   - **Under Legal Hold: 0 messages**, Active Holds **0**, Pending Cleanup
 *     **0**, Retention Policies **0**, Active Exports **0**;
 *   - a legal-holds table showing a green tick and **"No legal holds"**.
 *
 * An error banner sat above all of it, but the six cards and the table stated
 * numbers, and the numbers said a platform under litigation hold had none.
 * That is the `getHealthScore()`-returns-100-from-an-empty-table pattern
 * (audit correction C2) on a regulatory surface.
 *
 * The fix has three parts. The client now REQUIRES a tenant id, so the call
 * the page made cannot be written. The page asks which tenant it is reporting
 * on and reads nothing until it knows — no placeholder, no score. And the
 * three sections no endpoint serves (export jobs, retention distribution,
 * audit operations per day) say that outright instead of drawing an empty
 * state that reads as a measured zero; building them is tracked as
 * ADMIN-HIGH-148.
 *
 * Releasing a legal hold also asked nothing before doing it. It confirms now:
 * the release makes messages eligible for retention cleanup again, which is
 * exactly the thing a hold exists to prevent.
 *
 * @see ADR-012 Phase 3 (Compliance)
 */

import React, { useState } from 'react';
import { Card, Button, Badge } from '@aquaculture/shared-ui';
import { messagingApi } from '../../services/api/messaging';
import type {
  ComplianceStats,
  LegalHold,
  ExportRecord,
  RetentionBucket,
  DailyAuditData,
} from '../../services/api/messaging';
import { adminKeys, useAdminMutation, useAdminQuery } from '../../hooks';
import { TenantSelect } from '../../components/TenantSelect';
import { QueryFailureNotice } from '../../components/QueryFailureNotice';

/**
 * A count the page has, or an em dash for one it does not.
 *
 * There is no `EMPTY_STATS` any more. A placeholder object is indistinguishable
 * from an answer once it reaches a stat card, and this page proved it: its
 * `complianceScore: 100` was rendered as the platform's compliance score for
 * as long as the endpoint refused the request.
 */
const count = (value: number | undefined): string =>
  value === undefined ? '—' : value.toLocaleString();

// ============================================================================
// StatCard Component
// ============================================================================

const StatCard: React.FC<{
  title: string;
  value: string | number;
  subtitle?: string;
  color?: 'blue' | 'green' | 'yellow' | 'red' | 'purple' | 'unknown';
}> = ({ title, value, subtitle, color = 'blue' }) => {
  const colorMap = {
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    green: 'bg-green-50 text-green-700 border-green-200',
    yellow: 'bg-yellow-50 text-yellow-700 border-yellow-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    purple: 'bg-purple-50 text-purple-700 border-purple-200',
    // A value the page does not have must not borrow a colour that grades it.
    unknown: 'bg-gray-50 text-gray-500 border-gray-200',
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

// ============================================================================
// UnservedSection Component
// ============================================================================

/**
 * A section of this dashboard that no endpoint answers yet.
 *
 * It replaces three empty states — "No export jobs found.", "No retention data
 * available", "No audit data available" — which were rendered from
 * locally-constructed empty arrays and therefore said, on a GDPR surface, that
 * the platform had no export jobs and no audit activity. The arrays carried a
 * `// WHY:` comment explaining they were placeholders; the operator reading the
 * page could not see the comment.
 *
 * Saying "not served yet" is the only honest render until the aggregate exists,
 * and the missing aggregate is a tracked finding rather than a silence.
 */
const UnservedSection: React.FC<{ what: string; needs: string }> = ({ what, needs }) => (
  <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-5">
    <p className="text-sm font-medium text-gray-700">{what}</p>
    <p className="text-xs text-gray-500 mt-1">
      No endpoint serves this yet — {needs}. This panel does not mean the figure is zero.
      Tracked as ADMIN-HIGH-148.
    </p>
  </div>
);

// ============================================================================
// Main Component
// ============================================================================

const MessagingCompliancePage: React.FC = () => {
  /**
   * Which tenant this page is reporting on.
   *
   * Required, not a filter. Legal holds are held per tenant and both reads
   * REFUSE a request without one (ADMIN-CRITICAL-147), so there is no
   * platform-wide mode to default to — and rendering one from a placeholder is
   * what this page used to do.
   */
  const [tenantId, setTenantId] = useState<string | null>(null);

  const statsQuery = useAdminQuery<ComplianceStats>(
    adminKeys.messaging.complianceStats(tenantId ?? ''),
    ({ signal }) => messagingApi.getComplianceStats(tenantId ?? '', signal),
    { enabled: tenantId !== null },
  );

  const holdsQuery = useAdminQuery<LegalHold[]>(
    adminKeys.messaging.legalHolds(tenantId ?? ''),
    ({ signal }) => messagingApi.getLegalHolds(tenantId ?? '', signal),
    { enabled: tenantId !== null },
  );

  const releaseMutation = useAdminMutation(
    ({ holdId, holdTenantId }: { holdId: string; holdTenantId: string }) =>
      messagingApi.releaseLegalHold(holdId, holdTenantId),
    // The prefix covers both the stats aggregate and the holds list: releasing
    // a hold moves `activeHoldsCount` and `messagesUnderLegalHold` too.
    { invalidateKeys: [adminKeys.messaging.compliance()] },
  );

  const stats = statsQuery.data;
  const legalHolds = holdsQuery.data ?? [];

  const reload = (): void => {
    void statsQuery.refetch();
    void holdsQuery.refetch();
  };

  /**
   * Release an active hold, after asking.
   *
   * A release makes the held messages eligible for retention cleanup again —
   * the one thing the hold exists to prevent — and it used to happen on a
   * single click.
   */
  const handleReleaseLegalHold = (hold: LegalHold): void => {
    if (
      !confirm(
        `Release the legal hold on ${hold.tenantName}${
          hold.channelName ? ` / ${hold.channelName}` : ''
        }?\n\nHeld messages become eligible for retention cleanup again. This cannot be undone.`,
      )
    ) {
      return;
    }
    releaseMutation.mutate({ holdId: hold.id, holdTenantId: hold.tenantId });
  };

  const scoreColor: 'green' | 'yellow' | 'red' | 'unknown' =
    stats === undefined
      ? 'unknown'
      : stats.complianceScore >= 90
        ? 'green'
        : stats.complianceScore >= 70
          ? 'yellow'
          : 'red';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Messaging Compliance</h1>
          <p className="text-sm text-gray-500 mt-1">
            Legal holds and retention compliance for one tenant&apos;s messaging data.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="w-72">
            <label
              htmlFor="compliance-tenant"
              className="block text-xs font-medium text-gray-600 mb-1"
            >
              Tenant
            </label>
            <div id="compliance-tenant">
              <TenantSelect value={tenantId} onChange={setTenantId} />
            </div>
          </div>
          <Button
            onClick={reload}
            disabled={tenantId === null || statsQuery.isFetching || holdsQuery.isFetching}
            variant="secondary"
            size="sm"
          >
            {statsQuery.isFetching || holdsQuery.isFetching ? 'Refreshing...' : 'Refresh'}
          </Button>
        </div>
      </div>

      <QueryFailureNotice
        errors={[statsQuery.error, holdsQuery.error, releaseMutation.error]}
        hasContent={stats !== undefined || legalHolds.length > 0}
        onRetry={reload}
      />

      {tenantId === null ? (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center">
          <p className="text-sm font-medium text-gray-700">Choose a tenant</p>
          <p className="text-xs text-gray-500 mt-1">
            Legal holds and retention state are held per tenant, and both reads on this page
            require one. Nothing is shown until a tenant is selected — a compliance score
            rendered without a tenant would be a number about nobody.
          </p>
        </div>
      ) : (
        <>
          {/* Stats Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
            <StatCard
              title="Under Legal Hold"
              value={count(stats?.messagesUnderLegalHold)}
              subtitle="messages"
              color={stats === undefined ? 'unknown' : 'red'}
            />
            <StatCard
              title="Active Holds"
              value={count(stats?.activeHoldsCount)}
              color={stats === undefined ? 'unknown' : 'yellow'}
            />
            <StatCard
              title="Pending Cleanup"
              value={count(stats?.pendingRetentionCleanup)}
              subtitle="messages"
              color={stats === undefined ? 'unknown' : 'purple'}
            />
            <StatCard
              title="Retention Policies"
              value={count(stats?.retentionPoliciesCount)}
              color={stats === undefined ? 'unknown' : 'blue'}
            />
            <StatCard
              title="Active Exports"
              value={count(stats?.activeExports)}
              color={stats === undefined ? 'unknown' : 'green'}
            />
            <StatCard
              title="Compliance Score"
              // Never a placeholder: this card read "100%" in green for as long
              // as the endpoint refused the request.
              value={stats === undefined ? '—' : `${stats.complianceScore}%`}
              color={scoreColor}
            />
          </div>

          {/* Sections no endpoint answers yet */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <UnservedSection
              what="Audit operations per day"
              needs="messaging-service has no per-day audit aggregation query"
            />
            <UnservedSection
              what="Retention distribution across tenants"
              needs="messaging-service has no retention-bucket aggregation query"
            />
          </div>

          {/* Legal Holds Table */}
          <Card>
            <div className="p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-gray-700">Legal Holds</h3>
                <span className="text-xs text-gray-400">
                  {holdsQuery.data === undefined
                    ? '—'
                    : `${legalHolds.filter((h) => h.isActive).length} active / ${legalHolds.length} total`}
                </span>
              </div>
              {holdsQuery.isPending ? (
                <div className="flex items-center justify-center py-12">
                  <p className="text-sm text-gray-400">Loading legal holds...</p>
                </div>
              ) : holdsQuery.isError ? (
                // The banner above carries the reason. What must NOT appear
                // here is the green tick and "No legal holds".
                null
              ) : legalHolds.length === 0 ? (
                <div className="flex items-center justify-center py-12">
                  <div className="text-center">
                    <svg
                      className="w-10 h-10 text-green-400 mx-auto mb-2"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    <p className="text-sm text-gray-500">No legal holds on this tenant</p>
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Status
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Tenant
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Scope
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Reason
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Started
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Released
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Action
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {legalHolds.map((hold) => (
                        <tr key={hold.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3">
                            <HoldStatusBadge active={hold.isActive} />
                          </td>
                          <td className="px-4 py-3 text-sm font-medium text-gray-900">
                            {hold.tenantName}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600">
                            {hold.channelName ?? 'Tenant-wide'}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600 max-w-xs truncate">
                            {hold.reason}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-500">
                            {new Date(hold.startedAt).toLocaleDateString()}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-500">
                            {hold.releasedAt ? new Date(hold.releasedAt).toLocaleDateString() : '—'}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {hold.isActive && (
                              <button
                                onClick={() => handleReleaseLegalHold(hold)}
                                aria-label={`Release the legal hold on ${hold.tenantName}`}
                                disabled={releaseMutation.isPending}
                                className="text-xs px-2 py-1 rounded font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                              >
                                {releaseMutation.isPending ? 'Releasing...' : 'Release'}
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

          {/* Retention summary — the two figures the stats endpoint does give */}
          <Card>
            <div className="p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Retention Pressure</h3>
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-gray-600">Messages Under Hold</span>
                  <Badge
                    variant={
                      stats === undefined
                        ? 'default'
                        : stats.messagesUnderLegalHold > 0
                          ? 'error'
                          : 'success'
                    }
                  >
                    {count(stats?.messagesUnderLegalHold)}
                  </Badge>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-gray-600">Pending Retention Cleanup</span>
                  <Badge
                    variant={
                      stats === undefined
                        ? 'default'
                        : stats.pendingRetentionCleanup > 1000
                          ? 'warning'
                          : 'success'
                    }
                  >
                    {count(stats?.pendingRetentionCleanup)}
                  </Badge>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-gray-600">Audit Entries</span>
                  <Badge variant="default">{count(stats?.auditEntriesCount)}</Badge>
                </div>
              </div>
            </div>
          </Card>

          <UnservedSection
            what="Export jobs"
            needs="messaging-service exposes POST /messaging/tenants/:id/export but no listing of the jobs it creates"
          />
        </>
      )}
    </div>
  );
};

export default MessagingCompliancePage;
