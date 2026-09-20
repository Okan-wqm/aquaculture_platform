/**
 * VfdAuditLogViewer
 *
 * Tab 4 content: Immutable audit trail of all VFD parameter changes.
 * IEC 62443 compliant with filtering and pagination.
 */

import React, { useState, useMemo } from 'react';
import { ChevronDown, AlertTriangle, History, Filter } from 'lucide-react';
import { VfdParameterAuditLog, VfdRiskLevel } from '../../types/vfd.types';
import {
  Button,
  DataTable,
  Select,
  SeverityBadge,
  Spinner,
  type DataTableColumn,
} from '@aquaculture/shared-ui';

// ============================================================================
// Constants
// ============================================================================

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
        return <SeverityBadge severity={risk} label={risk} data-testid={`risk-${log.id}`} />;
      },
    },
  ];

  return (
    <div data-testid="vfd-audit-log">
      {/* Filter bar */}
      <div className="mb-4 flex items-center gap-3">
        <Filter className="h-4 w-4 text-gray-400 dark:text-gray-500" />
        <Select
          value={paramFilter}
          onChange={(e) => handleFilterChange(e.target.value)}
          aria-label="Filter by parameter"
          placeholder="All Parameters"
          options={availableParameters.map((p) => ({ value: p, label: p }))}
        />
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
