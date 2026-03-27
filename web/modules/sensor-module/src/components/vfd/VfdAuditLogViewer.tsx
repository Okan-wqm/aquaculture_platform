/**
 * VfdAuditLogViewer
 *
 * Tab 4 content: Immutable audit trail of all VFD parameter changes.
 * IEC 62443 compliant with filtering and pagination.
 */

import React, { useState, useMemo } from 'react';
import {
  ChevronDown,
  Loader2,
  AlertTriangle,
  History,
  Filter,
} from 'lucide-react';
import { VfdParameterAuditLog, VfdRiskLevel } from '../../types/vfd.types';

// ============================================================================
// Constants
// ============================================================================

const RISK_COLORS: Record<string, string> = {
  [VfdRiskLevel.LOW]: 'bg-green-100 text-green-700',
  [VfdRiskLevel.MEDIUM]: 'bg-yellow-100 text-yellow-700',
  [VfdRiskLevel.HIGH]: 'bg-orange-100 text-orange-700',
  [VfdRiskLevel.CRITICAL]: 'bg-red-100 text-red-700',
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
        <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
        <p className="text-sm text-red-600">{error}</p>
      </div>
    );
  }

  return (
    <div data-testid="vfd-audit-log">
      {/* Filter bar */}
      <div className="mb-4 flex items-center gap-3">
        <Filter className="h-4 w-4 text-gray-400" />
        <select
          value={paramFilter}
          onChange={(e) => handleFilterChange(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          aria-label="Filter by parameter"
        >
          <option value="">All Parameters</option>
          {availableParameters.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-gray-400">
          {logs.length} log entr{logs.length !== 1 ? 'ies' : 'y'}
        </span>
      </div>

      {/* Table */}
      {loading && logs.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-indigo-600" />
        </div>
      ) : logs.length === 0 ? (
        <div className="py-12 text-center">
          <History className="mx-auto mb-2 h-8 w-8 text-gray-300" />
          <p className="text-sm text-gray-500">No audit log entries</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="audit-table">
            <thead>
              <tr className="border-b text-left text-xs font-medium text-gray-500">
                <th className="pb-2 pr-4">Timestamp</th>
                <th className="pb-2 pr-4">Parameter</th>
                <th className="pb-2 pr-4">Old Value</th>
                <th className="pb-2 pr-4">New Value</th>
                <th className="pb-2 pr-4">By</th>
                <th className="pb-2 pr-4">Source</th>
                <th className="pb-2">Risk</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => {
                // Derive risk level from metadata if present
                const risk = (log.metadata?.riskLevel as string) ?? VfdRiskLevel.LOW;
                const riskClass = RISK_COLORS[risk] ?? RISK_COLORS[VfdRiskLevel.LOW];

                return (
                  <tr
                    key={log.id}
                    className="border-b border-gray-100 hover:bg-gray-50"
                    data-testid={`audit-row-${log.id}`}
                  >
                    <td className="py-2 pr-4 text-xs text-gray-600">
                      {formatTimestamp(log.timestamp)}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs font-medium">
                      {log.parameterName}
                    </td>
                    <td className="py-2 pr-4 text-xs text-gray-600">
                      {log.previousValue !== null ? log.previousValue : '-'}
                    </td>
                    <td className="py-2 pr-4 text-xs font-medium text-indigo-700">
                      {log.newValue}
                    </td>
                    <td className="py-2 pr-4 text-xs text-gray-600">
                      {log.performedBy}
                    </td>
                    <td className="py-2 pr-4 text-xs text-gray-500">
                      {log.action}
                    </td>
                    <td className="py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${riskClass}`}
                        data-testid={`risk-${log.id}`}
                      >
                        {risk}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Load more */}
      {hasMore && (
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4" />}
            Load More
          </button>
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
      day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return iso;
  }
}
