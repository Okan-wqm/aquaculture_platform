/**
 * Messaging Tenants Page — the GDPR export that was fetched and thrown away
 * (ADMIN-HIGH-153 / ADMIN-HIGH-121).
 *
 * `POST /messaging/tenants/:id/export` performs the export INSIDE the request
 * and replies with `data`: the rows already serialised as JSON or CSV. Nothing
 * stores it server-side and there is no second endpoint to fetch it from, so
 * that response is the only copy that will ever exist.
 *
 * admin-api declared the reply as `{ exportId, status }` — a field name the
 * reply does not use, and five fields short. The panel's own type listed six
 * of the seven and omitted `data`. So the page rendered "Export job accepted /
 * Records: 12,431" and **discarded the export**. An operator answering a data
 * portability request ran it, watched it succeed, and had no file. That is why
 * ADMIN-HIGH-148 found nothing to list: nothing was ever kept.
 *
 * The page now hands over the file. Three smaller things went with it:
 *
 *  - the route answered **202 Accepted** for work already finished, so the
 *    page's own copy said the job "runs asynchronously" — both now say what
 *    happens;
 *  - the tenant was typed by hand into a free-text UUID box. A valid-but-wrong
 *    id exports a DIFFERENT tenant's messaging data, which on this endpoint is
 *    the whole of it. `TenantSelect` removes the class;
 *  - the overview read sat in a second module-scoped cache with no abort
 *    signal (ADMIN-HIGH-121), and its five response shapes were hand-written
 *    because both aggregates were typed by controller interfaces
 *    (ADMIN-MEDIUM-152).
 *
 * The export is audited as `MESSAGE_EXPORT` in the tenant's compliance log —
 * one of the four actions `MessagingAuditPage`'s filter could never match
 * before ADMIN-CRITICAL-150.
 *
 * @see ADMIN-HIGH-009
 */

import React, { useState } from 'react';
import {
  Card,
  Button,
  Badge,
  DataTable,
  type DataTableColumn,
  PageHeader,
} from '@aquaculture/shared-ui';
import { messagingApi } from '../../services/api/messaging';
import type { ExportTriggerResult } from '../../services/api/messaging';
import type {
  MessagingTenantsOverview,
  TenantMessagingOverviewRow,
} from '../../services/types/messaging';
import { saveBlob } from '../../services/blob-client';
import { adminKeys, useAdminMutation, useAdminQuery } from '../../hooks';
import { TenantSelect } from '../../components/TenantSelect';
import { QueryFailureNotice } from '../../components/QueryFailureNotice';

/** messaging-service caches the aggregate for this long. */
const AGGREGATE_CACHE_MS = 60_000;

type ExportFormat = 'csv' | 'json';

/** The MIME type and extension each format is saved as. */
const FORMAT_FILE: Record<ExportFormat, { readonly mime: string; readonly extension: string }> = {
  json: { mime: 'application/json;charset=utf-8;', extension: 'json' },
  csv: { mime: 'text/csv;charset=utf-8;', extension: 'csv' },
};

// ============================================================================
// Sub-components
// ============================================================================

const tenantMessagingOverviewRowColumns: DataTableColumn<TenantMessagingOverviewRow>[] = [
  {
    key: 'tenantId',
    header: 'Tenant ID',
    render: (_value, tenant) => tenant.tenantId,
  },
  {
    key: 'messages24h',
    header: 'Messages (24h)',
    align: 'right',
    render: (_value, tenant) => tenant.messageCount24h.toLocaleString(),
  },
  {
    key: 'messages7d',
    header: 'Messages (7d)',
    align: 'right',
    render: (_value, tenant) => tenant.messageCount7d.toLocaleString(),
  },
  {
    key: 'totalMessages',
    header: 'Total Messages',
    align: 'right',
    render: (_value, tenant) => tenant.totalMessages.toLocaleString(),
  },
  {
    key: 'activeChannels',
    header: 'Active Channels',
    align: 'right',
    render: (_value, tenant) => tenant.activeChannels.toLocaleString(),
  },
];

const OverviewTable: React.FC<{ tenants: readonly TenantMessagingOverviewRow[] }> = ({
  tenants,
}) => (
  <DataTable<TenantMessagingOverviewRow>
    data={tenants}
    columns={tenantMessagingOverviewRowColumns}
    keyExtractor={(tenant) => tenant.tenantId}
    emptyMessage="No records found"
    searchable={false}
    sortable={false}
    stickyHeader={false}
    className="shadow-none"
  />
);

// ============================================================================
// Main Component
// ============================================================================

const MessagingTenantsPage: React.FC = () => {
  const [exportTenantId, setExportTenantId] = useState<string | null>(null);
  const [format, setFormat] = useState<ExportFormat>('json');
  const [lastExport, setLastExport] = useState<ExportTriggerResult | null>(null);

  const overviewQuery = useAdminQuery<MessagingTenantsOverview>(
    adminKeys.messaging.tenants(),
    ({ signal }) => messagingApi.getTenantsOverview(signal),
    { staleTime: AGGREGATE_CACHE_MS },
  );

  const tenants: readonly TenantMessagingOverviewRow[] = overviewQuery.data?.tenants ?? [];

  /**
   * Run the export and hand the operator the file.
   *
   * `saveBlob` on success is the whole point: the response carries the only
   * copy of the export that will ever exist, and the page used to drop it.
   */
  const exportMutation = useAdminMutation(
    (input: { tenantId: string; format: ExportFormat }) =>
      messagingApi.triggerExport(input.tenantId, input.format),
    {
      mutationOptions: {
        onSuccess: (result, input) => {
          setLastExport(result);
          const file = FORMAT_FILE[input.format];
          saveBlob(
            new Blob([result.data], { type: file.mime }),
            `messaging-export-${input.tenantId}-${result.exportedAt.slice(0, 10)}.${file.extension}`,
          );
        },
      },
    },
  );

  const runExport = (): void => {
    if (exportTenantId === null) return;
    setLastExport(null);
    exportMutation.mutate({ tenantId: exportTenantId, format });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Messaging Tenants"
        description="Per-tenant messaging volume, and data export"
        actions={
          <Button
            onClick={() => void overviewQuery.refetch()}
            disabled={overviewQuery.isFetching}
            variant="secondary"
            size="sm"
          >
            {overviewQuery.isFetching ? 'Refreshing...' : 'Refresh'}
          </Button>
        }
      />

      <QueryFailureNotice
        errors={[overviewQuery.error, exportMutation.error]}
        hasContent={tenants.length > 0}
        onRetry={() => void overviewQuery.refetch()}
      />

      {/* Tenant Overview */}
      <Card>
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                Tenant Messaging Overview
              </h3>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                Message volume and active channel counts per tenant, sorted by 24h volume
              </p>
            </div>
            {tenants.length > 0 && (
              <Badge variant="default">{tenants.length.toLocaleString()} tenant(s)</Badge>
            )}
          </div>

          {overviewQuery.isPending ? (
            <div className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">
              Loading tenant messaging overview...
            </div>
          ) : overviewQuery.isError ? (
            // The banner above carries the reason. Nothing is drawn here.
            null
          ) : tenants.length === 0 ? (
            <div className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">
              No tenant messaging activity recorded yet.
            </div>
          ) : null}

          {tenants.length > 0 && <OverviewTable tenants={tenants} />}

          {overviewQuery.data && (
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-4">
              Aggregated by the messaging service and cached for 60 seconds. Last computed:{' '}
              {new Date(overviewQuery.data.generatedAt).toLocaleString()}
            </p>
          )}
        </div>
      </Card>

      {/* Data Export */}
      <Card>
        <div className="p-6">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
            Export tenant data
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            Exports the tenant&apos;s messaging data and downloads it. The export runs inside this
            request and the response is the only copy — nothing is stored server-side. Active
            legal holds are recorded on the result; they do not stop the export.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-end">
            <div className="flex-1 w-full max-w-sm">
              <label
                htmlFor="export-tenant"
                className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                Tenant
              </label>
              {/* A picker, not a UUID box: a valid-but-wrong id used to export
                  a DIFFERENT tenant's entire messaging history. */}
              <div id="export-tenant">
                <TenantSelect
                  value={exportTenantId}
                  onChange={(next) => {
                    setExportTenantId(next || null);
                    setLastExport(null);
                  }}
                />
              </div>
            </div>
            <div>
              <label
                htmlFor="export-format"
                className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                Format
              </label>
              <select
                id="export-format"
                value={format}
                onChange={(e) => setFormat(e.target.value as ExportFormat)}
                className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm"
              >
                <option value="json">JSON</option>
                <option value="csv">CSV</option>
              </select>
            </div>
            <Button
              onClick={runExport}
              disabled={exportTenantId === null || exportMutation.isPending}
              variant="primary"
              size="sm"
            >
              {exportMutation.isPending ? 'Exporting...' : 'Export and download'}
            </Button>
          </div>

          {lastExport && (
            <div className="mt-3 p-3 bg-success-50 dark:bg-success-900/20 border border-success-200 dark:border-success-800 rounded-lg">
              <p className="text-sm font-medium text-success-800 dark:text-success-200 mb-2">
                Export complete — {lastExport.recordCount.toLocaleString()} record(s) downloaded
              </p>
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                <div>
                  <dt className="text-success-600 dark:text-success-400 font-medium">Job ID</dt>
                  <dd className="text-success-800 dark:text-success-200 font-mono">
                    {lastExport.jobId}
                  </dd>
                </div>
                <div>
                  <dt className="text-success-600 dark:text-success-400 font-medium">Format</dt>
                  <dd className="text-success-800 dark:text-success-200 uppercase">
                    {lastExport.format}
                  </dd>
                </div>
                <div>
                  <dt className="text-success-600 dark:text-success-400 font-medium">Records</dt>
                  <dd className="text-success-800 dark:text-success-200">
                    {lastExport.recordCount.toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt className="text-success-600 dark:text-success-400 font-medium">
                    Under legal hold
                  </dt>
                  <dd className="text-success-800 dark:text-success-200">
                    {lastExport.isUnderLegalHold ? 'Yes' : 'No'}
                  </dd>
                </div>
                <div>
                  <dt className="text-success-600 dark:text-success-400 font-medium">
                    Exported at
                  </dt>
                  <dd className="text-success-800 dark:text-success-200">
                    {new Date(lastExport.exportedAt).toLocaleString()}
                  </dd>
                </div>
              </dl>
              <p className="text-xs text-success-700 dark:text-success-300 mt-2">
                Recorded in this tenant&apos;s compliance audit log as{' '}
                <span className="font-mono">message_export</span>.
              </p>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};

export default MessagingTenantsPage;
