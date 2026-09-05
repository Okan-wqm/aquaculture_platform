/**
 * Messaging Tenants Page
 *
 * Per-tenant messaging data export for SUPER_ADMIN, backed by
 * POST /messaging/tenants/:id/export (messaging-service triggerExport).
 * The page shows only what the backend can do (ADMIN-HIGH-011): there is no
 * cross-tenant messaging overview endpoint, so there is no overview table.
 */

import React, { useState, useCallback } from 'react';
import { Card, Button } from '@aquaculture/shared-ui';
import { messagingApi } from '../../services/adminApi';
import type { ApiError } from '../../services/http-client';

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
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Messaging Tenants</h1>
        <p className="text-sm text-gray-500 mt-1">
          Trigger a messaging data export for a single tenant
        </p>
      </div>

      {/* Data Export -- Working */}
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

      {/* Architecture Note */}
      <Card className="p-4 bg-blue-50 border-blue-200">
        <h3 className="text-sm font-semibold text-blue-900 mb-1">
          Architecture Note
        </h3>
        <p className="text-xs text-blue-700 leading-relaxed">
          The tenant overview requires a cross-tenant aggregation endpoint in
          messaging-service that collects channel counts, message volumes,
          active user counts, and storage usage. This involves querying each
          tenant schema in isolation and merging results, which needs the
          multi-tenant query infrastructure to be extended. Until then, use the
          per-tenant compliance and audit pages for individual tenant visibility.
        </p>
      </Card>
    </div>
  );
};

export default MessagingTenantsPage;
