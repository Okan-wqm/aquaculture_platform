/**
 * VfdAuditLogViewer
 *
 * Tab 4 content: Immutable audit trail of all VFD parameter changes.
 * IEC 62443 compliant with filtering and pagination.
 */

import React, { useState, useMemo } from 'react';
import { ChevronDown, AlertTriangle, History, Filter } from 'lucide-react';
import { VfdParameterAuditLog, VfdRiskLevel } from '../../types/vfd.types';
import { DataTable, type DataTableColumn, Spinner, Button } from '@aquaculture/shared-ui';

// ============================================================================
// Constants
// ============================================================================

const RISK_COLORS: Record<string, string> = {
  [VfdRiskLevel.LOW]:
    'bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300',
  [VfdRiskLevel.MEDIUM]:
    'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300',
  [VfdRiskLevel.HIGH]:
    'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300',
  [VfdRiskLevel.CRITICAL]: 'bg-error-100 dark:bg-error-900/40 text-error-700 dark:text-error-300',
};

// ============================================================================
// Props
// ============================================================================

interface VfdAuditLogViewerProps {
  logs: VfdParameterAuditLog[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  onLoadMore: () => void;
  availableParameters: string[];
  onParameterFilter: (parameterName: string | undefined) => void;
}

// ============================================================================
// Component
// ============================================================================

export function VfdAuditLogViewer({
  logs,
  loading,
  error,
  hasMore,
  onLoadMore,
  availableParameters,
  onParameterFilter,
}: VfdAuditLogViewerProps) {
  const [paramFilter, setParamFilter] = useState<string>('');

  const handleFilterChange = (value: string) => {
    setParamFilter(value);
    onParameterFilter(value || undefined);
  };

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12" role="alert">
        <AlertTriangle className="mb-2 h-8 w-8 text-error-500" />
        <p className="text-sm text-error-600 dark:text-error-400">{error}</p>
      </div>
    );
  }

  const vfdParameterAuditLogColumns: DataTableColumn<VfdParameterAuditLog>[] = [
    {
      key: 'timestamp',
      header: 'Timestamp',
      render: (_value, log) => formatTimestamp(log.timestamp),
    },
    {
      key: 'parameter',
      header: 'Parameter',
      render: (_value, log) => log.parameterName,
    },
    {
      key: 'oldValue',
      header: 'Old Value',
      render: (_value, log) => (log.previousValue !== null ? log.previousValue : '-'),
    },
    {
      key: 'newValue',
      header: 'New Value',
      render: (_value, log) => log.newValue,
    },
    {
      key: 'by',
      header: 'By',
      render: (_value, log) => log.performedBy,
    },
    {
      key: 'source',
      header: 'Source',
      render: (_value, log) => log.action,
    },
    {
      key: 'risk',
      header: 'Risk',
      render: (_value, log) => {
        const risk = (log.metadata?.riskLevel as string) ?? VfdRiskLevel.LOW;
        const riskClass = RISK_COLORS[risk] ?? RISK_COLORS[VfdRiskLevel.LOW];
        return (
          <>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${riskClass}`}
              data-testid={`risk-${log.id}`}
            >
              {risk}
            </span>
          </>
        );
      },
    },
  ];

  return (
    <div data-testid="vfd-audit-log">
      {/* Filter bar */}
      <div className="mb-4 flex items-center gap-3">
        <Filter className="h-4 w-4 text-gray-400 dark:text-gray-500" />
        <select
          value={paramFilter}
          onChange={(e) => handleFilterChange(e.target.value)}
          className="rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm"
          aria-label="Filter by parameter"
        >
          <option value="">All Parameters</option>
          {availableParameters.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-gray-400 dark:text-gray-500">
          {logs.length} log entr{logs.length !== 1 ? 'ies' : 'y'}
        </span>
      </div>

      {/* Table */}
      {loading && logs.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Spinner size="md" />
        </div>
      ) : logs.length === 0 ? (
        <div className="py-12 text-center">
          <History className="mx-auto mb-2 h-8 w-8 text-gray-300" />
          <p className="text-sm text-gray-500 dark:text-gray-400">No audit log entries</p>
        </div>
      ) : (
        <DataTable<VfdParameterAuditLog>
          data={logs}
          columns={vfdParameterAuditLogColumns}
          keyExtractor={(log) => log.id}
          emptyMessage="No audit log entries"
          searchable={false}
          sortable={false}
          stickyHeader={false}
          compact
        />
      )}

      {/* Load more */}
      {hasMore && (
        <div className="mt-4 text-center">
          <Button variant="secondary" type="button" onClick={onLoadMore} disabled={loading}>
            {loading ? <Spinner size="sm" color="inherit" /> : <ChevronDown className="h-4 w-4" />}
            Load More
          </Button>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}
