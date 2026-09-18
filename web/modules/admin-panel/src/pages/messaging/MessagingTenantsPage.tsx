/**
 * Messaging Tenants Page
 *
 * Per-tenant messaging management for SUPER_ADMIN.
 *
 * The overview table is backed by GET /messaging/tenants, which proxies the
 * messaging-service cross-tenant aggregate (message counts 24h/7d/all-time +
 * active channel counts per tenant, cached backend-side for 60 seconds).
 * The page also provides a working data-export trigger for individual tenants
 * via POST /messaging/tenants/:id/export.
 *
 * @see ADMIN-HIGH-009
 */

import React, { useState, useCallback } from 'react';
import { Card, Button, Badge } from '@aquaculture/shared-ui';
import { useAsyncData } from '../../hooks/useAsyncData';
import { messagingApi } from '../../services/adminApi';
import type { ApiError } from '../../services/http-client';
import type {
  MessagingTenantsOverview,
  TenantMessagingOverviewRow,
} from '../../services/types/messaging';

// ============================================================================
// Types
// ============================================================================

interface ExportFormState {
  tenantId: string;
  format: 'csv' | 'json';
}

interface ExportResult {
  jobId: string;
  status: string;
  format: string;
  recordCount: number;
  isUnderLegalHold: boolean;
  exportedAt: string;
}

// ============================================================================
// Sub-components
// ============================================================================

const OverviewTable: React.FC<{ tenants: TenantMessagingOverviewRow[] }> = ({ tenants }) => (
  <div className="overflow-x-auto">
    <table className="min-w-full divide-y divide-gray-200">
      <thead>
        <tr>
          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
            Tenant ID
          </th>
          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
            Messages (24h)
          </th>
          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
            Messages (7d)
          </th>
          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
            Total Messages
          </th>
          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
            Active Channels
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {tenants.map((tenant) => (
          <tr key={tenant.tenantId} className="hover:bg-gray-50">
            <td className="px-4 py-3 text-sm font-mono text-gray-900">{tenant.tenantId}</td>
            <td className="px-4 py-3 text-sm text-gray-700 text-right">
              {tenant.messageCount24h.toLocaleString()}
            </td>
            <td className="px-4 py-3 text-sm text-gray-700 text-right">
              {tenant.messageCount7d.toLocaleString()}
            </td>
            <td className="px-4 py-3 text-sm text-gray-700 text-right">
              {tenant.totalMessages.toLocaleString()}
            </td>
            <td className="px-4 py-3 text-sm text-gray-700 text-right">
              {tenant.activeChannels.toLocaleString()}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

// ============================================================================
// Main Component
// ============================================================================

const MessagingTenantsPage: React.FC = () => {
  const [exportForm, setExportForm] = useState<ExportFormState>({
    tenantId: '',
    format: 'json',
  });
  const [exportLoading, setExportLoading] = useState(false);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // ── Tenant overview ──
  const overviewQuery = useAsyncData<MessagingTenantsOverview>(
    () => messagingApi.getTenantsOverview(),
    { cacheKey: 'messaging-tenants-overview', cacheTTL: 15_000 },
  );

  const tenants = overviewQuery.data?.tenants ?? [];

  /** SECURITY: Validate UUID format before sending to API */
  const isValidUuid = (value: string): boolean =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

  const handleExport = useCallback(async (): Promise<void> => {
    if (!exportForm.tenantId.trim()) {
      setExportError('Tenant ID is required.');
      return;
    }

    if (!isValidUuid(exportForm.tenantId.trim())) {
      setExportError('Tenant ID must be a valid UUID.');
      return;
    }

    setExportLoading(true);
    setExportError(null);
    setExportResult(null);

    try {
      const result = await messagingApi.triggerExport(
        exportForm.tenantId.trim(),
        exportForm.format,
      );
      setExportResult(result);
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      setExportError(apiErr.message || 'Failed to trigger export.');
    } finally {
      setExportLoading(false);
    }
  }, [exportForm]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Messaging Tenants</h1>
          <p className="text-sm text-gray-500 mt-1">
            Per-tenant messaging management and controls
          </p>
        </div>
        <Button
          onClick={() => void overviewQuery.refresh()}
          disabled={overviewQuery.loading}
          variant="secondary"
          size="sm"
        >
          {overviewQuery.loading ? 'Refreshing...' : 'Refresh'}
        </Button>
      </div>

      {/* Tenant Overview */}
      <Card>
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Tenant Messaging Overview</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Message volume and active channel counts per tenant, sorted by 24h volume
              </p>
            </div>
            {tenants.length > 0 && (
              <Badge variant="default">{tenants.length.toLocaleString()} tenant(s)</Badge>
            )}
          </div>

          {overviewQuery.error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-center justify-between gap-4">
              <p className="text-sm text-red-700">{overviewQuery.error}</p>
              {overviewQuery.canRetry && (
                <Button onClick={() => void overviewQuery.retry()} variant="secondary" size="sm">
                  Retry
                </Button>
              )}
            </div>
          )}

          {!overviewQuery.error && overviewQuery.loading && tenants.length === 0 && (
            <div className="py-10 text-center text-sm text-gray-500">
              Loading tenant messaging overview...
            </div>
          )}

          {!overviewQuery.error && !overviewQuery.loading && tenants.length === 0 && (
            <div className="py-10 text-center text-sm text-gray-500">
              No tenant messaging activity recorded yet.
            </div>
          )}

          {tenants.length > 0 && <OverviewTable tenants={tenants} />}

          {overviewQuery.data && (
            <p className="text-xs text-gray-400 mt-4">
              Aggregated by the messaging service and cached for 60 seconds. Last computed:{' '}
              {new Date(overviewQuery.data.generatedAt).toLocaleString()}
            </p>
          )}
        </div>
      </Card>

      {/* Data Export */}
      <Card>
        <div className="p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-1">
            Trigger Tenant Data Export
          </h3>
          <p className="text-xs text-gray-500 mb-4">
            Export all messaging data for a specific tenant. The export job runs
            asynchronously and respects active legal holds.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-end">
            <div className="flex-1 w-full">
              <label htmlFor="export-tenant-id" className="block text-xs font-medium text-gray-700 mb-1">
                Tenant ID (UUID)
              </label>
              <input
                id="export-tenant-id"
                type="text"
                placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000"
                value={exportForm.tenantId}
                onChange={(e) => {
                  setExportForm((prev) => ({ ...prev, tenantId: e.target.value }));
                  setExportError(null);
                  setExportResult(null);
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden"
              />
            </div>
            <div>
              <label htmlFor="export-format" className="block text-xs font-medium text-gray-700 mb-1">
                Format
              </label>
              <select
                id="export-format"
                value={exportForm.format}
                onChange={(e) =>
                  setExportForm((prev) => ({
                    ...prev,
                    format: e.target.value as 'csv' | 'json',
                  }))
                }
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
              >
                <option value="json">JSON</option>
                <option value="csv">CSV</option>
              </select>
            </div>
            <Button
              onClick={() => void handleExport()}
              disabled={exportLoading || !exportForm.tenantId.trim()}
              variant="primary"
              size="sm"
            >
              {exportLoading ? 'Exporting...' : 'Trigger Export'}
            </Button>
          </div>

          {/* Export Error */}
          {exportError && (
            <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-700">{exportError}</p>
            </div>
          )}

          {/* Export Result */}
          {exportResult && (
            <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded-lg">
              <p className="text-sm font-medium text-green-800 mb-2">
                Export job accepted
              </p>
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                <div>
                  <dt className="text-green-600 font-medium">Job ID</dt>
                  <dd className="text-green-800 font-mono">{exportResult.jobId}</dd>
                </div>
                <div>
                  <dt className="text-green-600 font-medium">Status</dt>
                  <dd className="text-green-800">{exportResult.status}</dd>
                </div>
                <div>
                  <dt className="text-green-600 font-medium">Format</dt>
                  <dd className="text-green-800">{exportResult.format}</dd>
                </div>
                <div>
                  <dt className="text-green-600 font-medium">Records</dt>
                  <dd className="text-green-800">{exportResult.recordCount.toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-green-600 font-medium">Legal Hold</dt>
                  <dd className="text-green-800">
                    {exportResult.isUnderLegalHold ? 'Yes' : 'No'}
                  </dd>
                </div>
                <div>
                  <dt className="text-green-600 font-medium">Exported At</dt>
                  <dd className="text-green-800">
                    {new Date(exportResult.exportedAt).toLocaleString()}
                  </dd>
                </div>
              </dl>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};

export default MessagingTenantsPage;
