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
import {
  Card,
  Button,
  Badge,
  DataTable,
  type DataTableColumn,
  PageHeader,
  useConfirm,
} from '@aquaculture/shared-ui';
import { messagingApi } from '../../services/api/messaging';
import type { ComplianceStats, LegalHold } from '../../services/api/messaging';
import { adminKeys, useAdminMutation, useAdminQuery } from '../../hooks';
import { TenantSelect } from '../../components/TenantSelect';
import { QueryFailureNotice } from '../../components/QueryFailureNotice';
import { CircleCheck } from 'lucide-react';

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
    blue: 'bg-info-50 dark:bg-info-900/20 text-info-700 dark:text-info-300 border-info-200 dark:border-info-800',
    green:
      'bg-success-50 dark:bg-success-900/20 text-success-700 dark:text-success-300 border-success-200 dark:border-success-800',
    yellow:
      'bg-warning-50 dark:bg-warning-900/20 text-warning-700 dark:text-warning-300 border-warning-200 dark:border-warning-800',
    red: 'bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-300 border-error-200 dark:border-error-800',
    purple:
      'bg-accent-50 dark:bg-accent-900/20 text-accent-700 dark:text-accent-300 border-accent-200 dark:border-accent-800',
    // A value the page does not have must not borrow a colour that grades it.
    unknown:
      'bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-700',
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
      active
        ? 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200'
        : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
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
  <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 p-5">
    <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{what}</p>
    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
      No endpoint serves this yet — {needs}. This panel does not mean the figure is zero. Tracked as
      ADMIN-HIGH-148.
    </p>
  </div>
);

// ============================================================================
// Main Component
// ============================================================================

const MessagingCompliancePage: React.FC = () => {
  const confirm = useConfirm();
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
  const handleReleaseLegalHold = async (hold: LegalHold): Promise<void> => {
    // The design-system dialog, not the browser's: `no-alert` bans the latter
    // panel-wide.
    if (
      !(await confirm({
        title: `Release the legal hold on ${hold.tenantName}${
          hold.channelName ? ` / ${hold.channelName}` : ''
        }?`,
        message:
          'Held messages become eligible for retention cleanup again. This cannot be undone.',
        confirmText: 'Release',
        cancelText: 'Cancel',
        variant: 'danger',
      }))
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

  const legalHoldColumns: DataTableColumn<LegalHold>[] = [
    {
      key: 'status',
      header: 'Status',
      render: (_value, hold) => <HoldStatusBadge active={hold.isActive} />,
    },
    {
      key: 'tenant',
      header: 'Tenant',
      render: (_value, hold) => hold.tenantName,
    },
    {
      key: 'scope',
      header: 'Scope',
      render: (_value, hold) => hold.channelName ?? 'Tenant-wide',
    },
    {
      key: 'reason',
      header: 'Reason',
      render: (_value, hold) => hold.reason,
    },
    {
      key: 'started',
      header: 'Started',
      render: (_value, hold) => new Date(hold.startedAt).toLocaleDateString(),
    },
    {
      key: 'released',
      header: 'Released',
      render: (_value, hold) =>
        hold.releasedAt ? new Date(hold.releasedAt).toLocaleDateString() : '—',
    },
    {
      key: 'action',
      header: 'Action',
      align: 'right',
      render: (_value, hold) => (
        <>
          {hold.isActive && (
            <button
              onClick={() => void handleReleaseLegalHold(hold)}
              aria-label={`Release the legal hold on ${hold.tenantName}`}
              disabled={releaseMutation.isPending}
              className="text-xs px-2 py-1 rounded font-medium text-error-600 dark:text-error-400 hover:bg-error-50 dark:hover:bg-error-900/30 disabled:opacity-50"
            >
              {releaseMutation.isPending ? 'Releasing...' : 'Release'}
            </button>
          )}
        </>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Messaging Compliance"
        description="Legal holds and retention compliance for one tenant's messaging data."
        actions={
          <div className="flex items-end gap-2">
            <div className="w-72">
              <label
                htmlFor="compliance-tenant"
                className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1"
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
        }
      />

      <QueryFailureNotice
        errors={[statsQuery.error, holdsQuery.error, releaseMutation.error]}
        hasContent={stats !== undefined || legalHolds.length > 0}
        onRetry={reload}
      />

      {tenantId === null ? (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-8 text-center">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Choose a tenant</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Legal holds and retention state are held per tenant, and both reads on this page require
            one. Nothing is shown until a tenant is selected — a compliance score rendered without a
            tenant would be a number about nobody.
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
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                  Legal Holds
                </h3>
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  {holdsQuery.data === undefined
                    ? '—'
                    : `${legalHolds.filter((h) => h.isActive).length} active / ${legalHolds.length} total`}
                </span>
              </div>
              {holdsQuery.isPending ? (
                <div className="flex items-center justify-center py-12">
                  <p className="text-sm text-gray-400 dark:text-gray-500">Loading legal holds...</p>
                </div>
              ) : holdsQuery.isError ? // The banner above carries the reason. What must NOT appear
              // here is the green tick and "No legal holds".
              null : legalHolds.length === 0 ? (
                <div className="flex items-center justify-center py-12">
                  <div className="text-center">
                    <CircleCheck
                      className="w-10 h-10 text-success-400 mx-auto mb-2"
                      aria-hidden="true"
                    />
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      No legal holds on this tenant
                    </p>
                  </div>
                </div>
              ) : (
                <DataTable<LegalHold>
                  data={legalHolds}
                  columns={legalHoldColumns}
                  keyExtractor={(hold) => hold.id}
                  emptyMessage="No legal holds"
                  searchable={false}
                  sortable={false}
                  stickyHeader={false}
                  className="shadow-none rounded-none"
                />
              )}
            </div>
          </Card>

          {/* Retention summary — the two figures the stats endpoint does give */}
          <Card>
            <div className="p-5">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">
                Retention Pressure
              </h3>
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-gray-600 dark:text-gray-400">
                    Messages Under Hold
                  </span>
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
                  <span className="text-sm text-gray-600 dark:text-gray-400">
                    Pending Retention Cleanup
                  </span>
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
                  <span className="text-sm text-gray-600 dark:text-gray-400">Audit Entries</span>
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
