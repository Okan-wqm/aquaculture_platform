/**
 * Messaging Monitoring Page — cross-tenant volume, channel activity and outbox
 * health (ADMIN-HIGH-009 / ADMIN-MEDIUM-152).
 *
 * Recorded deliberately: this page was NOT lying. Every KPI renders an em dash
 * until the aggregate arrives, the outbox panel renders only when it has one,
 * `oldestPendingAgeSeconds === null` shows a dash rather than "0s", the error
 * banner carries the server's own message with a retry, and the freshness note
 * says the numbers are the aggregation's, not the request's. ADMIN-HIGH-009
 * wrote both sides of the contract together and they still agree field for
 * field.
 *
 * So this migration closes no fabricated number. What it removes is narrower
 * and still real:
 *
 *  - the read sat in a second, module-scoped cache with no abort signal, so
 *    leaving the page could not cancel it and `logoutCleanup()` had one more
 *    store to remember (ADMIN-HIGH-121);
 *  - the tenant chart's empty state read "No tenant messaging activity
 *    recorded yet." on a FAILED read as well as an empty one — the one
 *    sentence on the page that asserted something it had not established;
 *  - `ErrorBanner` was a fourth local copy of what `QueryFailureNotice`
 *    exists to be;
 *  - and the five response shapes were hand-written, because both routes were
 *    typed by interfaces the swagger plugin cannot describe. They are DTO
 *    classes now, and the frontend derives its types from them — closing the
 *    drift before it happened rather than after, which is the only time it is
 *    cheap.
 *
 * The backend caches the aggregate for 60 seconds; `staleTime` matches, so the
 * page does not re-request a number that cannot have changed.
 */

import React from 'react';
import { Card, Badge, KpiCard, BarChart, Button } from '@aquaculture/shared-ui';
import { messagingApi } from '../../services/api/messaging';
import type { MessagingMonitoringStats } from '../../services/types/messaging';
import { adminKeys, useAdminQuery } from '../../hooks';
import { QueryFailureNotice } from '../../components/QueryFailureNotice';

// ============================================================================
// Helpers
// ============================================================================

/** Number of tenants shown in the top-tenants bar chart. */
const TOP_TENANTS_LIMIT = 10;

/** messaging-service caches the aggregate for this long, so re-reading is waste. */
const AGGREGATE_CACHE_MS = 60_000;

/** Shorten a tenant UUID for axis labels (first block is unique enough visually). */
const shortTenantId = (tenantId: string): string => tenantId.split('-')[0] ?? tenantId;

/** Format an age in seconds as a compact human-readable duration. */
const formatAge = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
};

// ============================================================================
// Sub-components
// ============================================================================

const OutboxHealthPanel: React.FC<{ stats: MessagingMonitoringStats }> = ({ stats }) => {
  const { outbox } = stats;
  const hasFailures = outbox.failedCount > 0;

  return (
    <Card className={hasFailures ? 'border-amber-300' : undefined}>
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Outbox Health</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Transactional event outbox of the messaging service
            </p>
          </div>
          {hasFailures ? (
            <Badge variant="warning">Attention required</Badge>
          ) : (
            <Badge variant="success">Healthy</Badge>
          )}
        </div>

        {hasFailures && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
            <p className="text-sm text-amber-800">
              {outbox.failedCount.toLocaleString()} event(s) are dead-lettered and will not be
              retried automatically. Investigate the messaging-service dead-letter queue.
            </p>
          </div>
        )}

        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="p-3 rounded-lg bg-gray-50">
            <dt className="text-xs font-medium text-gray-500">Pending events</dt>
            <dd className="text-xl font-bold text-gray-900 mt-1">
              {outbox.pendingCount.toLocaleString()}
            </dd>
          </div>
          <div className={`p-3 rounded-lg ${hasFailures ? 'bg-red-50' : 'bg-gray-50'}`}>
            <dt className={`text-xs font-medium ${hasFailures ? 'text-red-600' : 'text-gray-500'}`}>
              Dead-lettered events
            </dt>
            <dd className={`text-xl font-bold mt-1 ${hasFailures ? 'text-red-700' : 'text-gray-900'}`}>
              {outbox.failedCount.toLocaleString()}
            </dd>
          </div>
          <div className="p-3 rounded-lg bg-gray-50">
            <dt className="text-xs font-medium text-gray-500">Oldest pending age</dt>
            <dd className="text-xl font-bold text-gray-900 mt-1">
              {outbox.oldestPendingAgeSeconds === null
                ? '—'
                : formatAge(outbox.oldestPendingAgeSeconds)}
            </dd>
          </div>
        </dl>
      </div>
    </Card>
  );
};

// ============================================================================
// Main Component
// ============================================================================

const MessagingMonitoringPage: React.FC = () => {
  const statsQuery = useAdminQuery<MessagingMonitoringStats>(
    adminKeys.messaging.monitoring(),
    ({ signal }) => messagingApi.getMonitoringStats(signal),
    { staleTime: AGGREGATE_CACHE_MS },
  );

  const stats = statsQuery.data;
  const loading = statsQuery.isPending;
  const topTenants = (stats?.perTenant ?? []).slice(0, TOP_TENANTS_LIMIT);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Messaging Monitoring</h1>
          <p className="text-sm text-gray-500 mt-1">
            Cross-tenant message volume, channel activity, and outbox health
          </p>
        </div>
        <Button
          onClick={() => void statsQuery.refetch()}
          disabled={statsQuery.isFetching}
          variant="secondary"
          size="sm"
        >
          {statsQuery.isFetching ? 'Refreshing...' : 'Refresh'}
        </Button>
      </div>

      <QueryFailureNotice
        errors={[statsQuery.error]}
        hasContent={stats !== undefined}
        onRetry={() => void statsQuery.refetch()}
      />

      {/* KPI grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
        <KpiCard
          title="Total Messages"
          value={stats ? stats.totals.totalMessages.toLocaleString() : '—'}
          description="All-time messages across all tenants"
          loading={loading && !stats}
        />
        <KpiCard
          title="Messages (24h)"
          value={stats ? stats.totals.messages24h.toLocaleString() : '—'}
          description="Messages created in the last 24 hours"
          variant="primary"
          loading={loading && !stats}
        />
        <KpiCard
          title="Messages (7d)"
          value={stats ? stats.totals.messages7d.toLocaleString() : '—'}
          description="Messages created in the last 7 days"
          variant="info"
          loading={loading && !stats}
        />
        <KpiCard
          title="Active Channels"
          value={stats ? stats.totals.activeChannels.toLocaleString() : '—'}
          description="Non-archived channels across all tenants"
          variant="success"
          loading={loading && !stats}
        />
        <KpiCard
          title="Tenants with Activity"
          value={stats ? stats.totals.tenantCount.toLocaleString() : '—'}
          description="Tenants with messages or active channels"
          loading={loading && !stats}
        />
      </div>

      {/* Outbox health */}
      {stats && <OutboxHealthPanel stats={stats} />}

      {/* Top tenants by 24h volume */}
      <Card>
        <div className="p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-1">
            Top Tenants by 24h Message Volume
          </h3>
          <p className="text-xs text-gray-500 mb-4">
            Highest-volume tenants over the last 24 hours (tenant IDs shortened)
          </p>

          {statsQuery.isError ? (
            // The banner above carries the reason. Nothing is said here: the
            // previous copy — "No tenant messaging activity recorded yet." —
            // was the one sentence on this page that asserted an absence it
            // had not established.
            null
          ) : topTenants.length > 0 ? (
            <div className="overflow-x-auto">
              <BarChart
                labels={topTenants.map((t) => shortTenantId(t.tenantId))}
                datasets={[
                  {
                    label: 'Messages (24h)',
                    data: topTenants.map((t) => t.messageCount24h),
                  },
                ]}
                width={Math.max(480, topTenants.length * 80)}
                height={260}
              />
            </div>
          ) : (
            <p className="text-sm text-gray-500 py-8 text-center">
              {loading
                ? 'Loading tenant activity...'
                : 'No tenant messaging activity recorded yet.'}
            </p>
          )}
        </div>
      </Card>

      {/* Freshness note */}
      {stats && (
        <p className="text-xs text-gray-400">
          Statistics are aggregated by the messaging service and cached for 60 seconds. Last
          computed: {new Date(stats.generatedAt).toLocaleString()}
        </p>
      )}
    </div>
  );
};

export default MessagingMonitoringPage;
