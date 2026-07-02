/**
 * SubmissionHistorySection (FARM-HIGH-125)
 *
 * Shared report-history block for every regulatory report tab: stats
 * cards, status filter and the persisted submission rows fetched from
 * the backend `regulatory_reports` record-of-submission. Replaces the
 * per-tab mock arrays that used to fabricate report history.
 *
 * Each row shows the reporting period, client reference, lifecycle
 * status, the Mattilsynet receipt (referanse) or failure message, and
 * an expandable payload view of exactly what was submitted.
 */
import React, { useMemo, useState } from 'react';
import {
  useRegulatoryReport,
  useRegulatoryReports,
  RegulatoryReportRow,
  RegulatoryReportStatusValue,
  RegulatoryReportTypeValue,
} from '../../../hooks/useRegulatoryReports';

// ============================================================================
// Helpers
// ============================================================================

const STATUS_LABELS: Record<RegulatoryReportStatusValue, string> = {
  PENDING: 'Pending',
  SUBMITTED: 'Submitted',
  QUEUED: 'Queued',
  FAILED: 'Failed',
};

const STATUS_BADGES: Record<RegulatoryReportStatusValue, string> = {
  PENDING: 'bg-yellow-100 text-yellow-800',
  SUBMITTED: 'bg-green-100 text-green-800',
  QUEUED: 'bg-blue-100 text-blue-800',
  FAILED: 'bg-red-100 text-red-800',
};

function periodLabel(row: RegulatoryReportRow): string {
  if (row.reportWeek && row.reportYear) return `Week ${row.reportWeek}, ${row.reportYear}`;
  if (row.reportMonth && row.reportYear) {
    const monthName = new Date(row.reportYear, row.reportMonth - 1, 1).toLocaleDateString('en-GB', {
      month: 'long',
    });
    return `${monthName} ${row.reportYear}`;
  }
  return new Date(row.createdAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatTimestamp(value?: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ============================================================================
// Payload detail (lazy — fetched only when a row is expanded)
// ============================================================================

/**
 * Human-readable payload rendering without JSON.stringify's indent
 * argument (banned by the structured-logging lint rule).
 */
export function formatPayload(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}(none)`;
    return value.map((item) => formatPayload(item, indent)).join('\n');
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) =>
        entry !== null && typeof entry === 'object'
          ? `${pad}${key}:\n${formatPayload(entry, indent + 1)}`
          : `${pad}${key}: ${String(entry)}`,
      )
      .join('\n');
  }
  return `${pad}${String(value)}`;
}

const PayloadDetail: React.FC<{ reportId: string }> = ({ reportId }) => {
  const { data, isLoading } = useRegulatoryReport(reportId);
  if (isLoading) {
    return <p className="text-sm text-gray-500 p-3">Loading submitted payload…</p>;
  }
  if (!data) {
    return <p className="text-sm text-gray-500 p-3">Payload unavailable.</p>;
  }
  return (
    <pre className="text-xs bg-gray-50 border border-gray-200 rounded-md p-3 overflow-x-auto max-h-72">
      {formatPayload(data.payload)}
    </pre>
  );
};

// ============================================================================
// Section
// ============================================================================

export interface SubmissionHistorySectionProps {
  reportType: RegulatoryReportTypeValue;
  siteId?: string;
  /** Extra stats card, e.g. domain-specific aggregate supplied by the tab. */
  title?: string;
}

export const SubmissionHistorySection: React.FC<SubmissionHistorySectionProps> = ({
  reportType,
  siteId,
  title = 'Submission History',
}) => {
  const { data: rows = [], isLoading, error } = useRegulatoryReports(reportType, siteId);
  const [statusFilter, setStatusFilter] = useState<RegulatoryReportStatusValue | 'all'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const stats = useMemo(
    () => ({
      total: rows.length,
      submitted: rows.filter((r) => r.status === 'SUBMITTED' || r.status === 'QUEUED').length,
      failed: rows.filter((r) => r.status === 'FAILED').length,
      pending: rows.filter((r) => r.status === 'PENDING').length,
    }),
    [rows],
  );

  const visibleRows = useMemo(
    () => (statusFilter === 'all' ? rows : rows.filter((r) => r.status === statusFilter)),
    [rows, statusFilter],
  );

  return (
    <div className="space-y-4" data-testid={`submission-history-${reportType}`}>
      <h3 className="text-md font-semibold text-gray-900">{title}</h3>

      {/* Stats Cards */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-2xl font-bold text-gray-900">{stats.total}</div>
          <div className="text-sm text-gray-500">Total Submissions</div>
        </div>
        <div className="bg-white rounded-lg border border-green-200 p-4">
          <div className="text-2xl font-bold text-green-600">{stats.submitted}</div>
          <div className="text-sm text-gray-500">Submitted</div>
        </div>
        <div className="bg-white rounded-lg border border-red-200 p-4">
          <div className="text-2xl font-bold text-red-600">{stats.failed}</div>
          <div className="text-sm text-gray-500">Failed</div>
        </div>
        <div className="bg-white rounded-lg border border-yellow-200 p-4">
          <div className="text-2xl font-bold text-yellow-600">{stats.pending}</div>
          <div className="text-sm text-gray-500">Pending</div>
        </div>
      </div>

      {/* Status filter */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-500">Filter:</span>
        {(['all', 'SUBMITTED', 'QUEUED', 'FAILED', 'PENDING'] as const).map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => setStatusFilter(status)}
            className={`px-3 py-1.5 text-sm rounded-md ${
              statusFilter === status
                ? 'bg-blue-100 text-blue-700'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {status === 'all' ? 'All' : STATUS_LABELS[status]}
          </button>
        ))}
      </div>

      {/* Rows */}
      {isLoading ? (
        <p className="text-sm text-gray-500 py-8 text-center">Loading submission history…</p>
      ) : error ? (
        <div className="text-center py-8 bg-red-50 rounded-lg border border-red-200">
          <p className="text-sm text-red-700">Failed to load submission history. Please retry.</p>
        </div>
      ) : visibleRows.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
          <p className="text-sm text-gray-500">No submissions recorded yet.</p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-200 bg-white rounded-lg border border-gray-200">
          {visibleRows.map((row) => (
            <li key={row.id} className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900">{periodLabel(row)}</span>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full ${STATUS_BADGES[row.status]}`}
                    >
                      {STATUS_LABELS[row.status]}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    Locality {row.lokalitetsnummer} · Ref {row.klientReferanse}
                  </p>
                  {row.referanse && (
                    <p className="text-xs text-gray-500 mt-0.5">
                      Mattilsynet receipt: {row.referanse}
                    </p>
                  )}
                  {row.feilmelding && (
                    <p className="text-xs text-red-600 mt-0.5" role="alert">
                      {row.feilmelding}
                    </p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs text-gray-500">{formatTimestamp(row.submittedAt)}</p>
                  <button
                    type="button"
                    onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                    className="mt-1 text-xs text-blue-600 hover:text-blue-800"
                  >
                    {expandedId === row.id ? 'Hide payload' : 'View payload'}
                  </button>
                </div>
              </div>
              {expandedId === row.id && (
                <div className="mt-3">
                  <PayloadDetail reportId={row.id} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default SubmissionHistorySection;
