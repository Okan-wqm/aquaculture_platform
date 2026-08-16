/**
 * Reports Page
 *
 * Rapor olusturma ve indirme sayfasi.
 * Tenant, Financial, Usage ve System raporlari.
 * Uses real API data from backend reports service.
 */

import { Card, Button, Badge, Modal, Input } from '@aquaculture/shared-ui';
import {
  REPORT_CAPABILITY_CATALOG,
  REPORT_AUTHORITY_GRAPH_SHA256,
  REPORT_CAPABILITY_CATALOG_SHA256,
  REPORT_MEASUREMENT_AUTHORITY_CATALOG_SHA256,
  getReportCapability,
  getReportMeasurementAuthority,
  type ReportCapabilityV1,
  type ReportFormat,
  type ReportMeasurementState,
  type ReportType,
} from '@platform/reporting-contracts';
import React, { useCallback, useEffect, useState } from 'react';

import { reportsApi } from '../services/adminApi';
import { downloadAdminOwnedBlob } from '../services/browser-capabilities';
import {
  decodeReportExecutionEvidence,
  decodeReportExecutionEvidencePage,
  type GeneratedReport,
} from './reporting/report-execution-evidence';

// ============================================================================
// Types
// ============================================================================

interface ReportDefinition extends ReportCapabilityV1 {
  icon: React.ReactNode;
  measurementState: ReportMeasurementState;
  unavailableReason?: string;
}

const utcDayBoundary = (calendarDate: string): string =>
  `${calendarDate}T00:00:00.000Z`;
// ============================================================================
// Column Header & Value Formatting
// ============================================================================

/**
 * Column header formatter that converts any casing convention to
 * human-readable title case. Handles:
 * - UPPERCASE:   CREATEDAT   -> Created At
 * - camelCase:   createdAt   -> Created At
 * - snake_case:  created_at  -> Created At
 * - PascalCase:  CreatedAt   -> Created At
 *
 * Known abbreviations (API, MRR, ARPU, ID, URL, IP, KPI) are preserved
 * in uppercase.
 */
const ABBREVIATIONS = new Set(['api', 'mrr', 'arpu', 'id', 'url', 'ip', 'kpi']);

const formatColumnHeader = (raw: string): string => {
  // For fully-uppercase compound words (e.g. CREATEDAT, NETREVENUE),
  // attempt dictionary-based splitting using common analytics terms.
  // This runs before regex splitting which cannot detect word boundaries
  // in all-caps strings.
  const KNOWN_WORDS = [
    'created',
    'updated',
    'deleted',
    'storage',
    'revenue',
    'amount',
    'count',
    'total',
    'active',
    'status',
    'tenant',
    'module',
    'plan',
    'distribution',
    'monthly',
    'annual',
    'daily',
    'weekly',
    'churn',
    'growth',
    'rate',
    'date',
    'time',
    'name',
    'type',
    'used',
    'free',
    'paid',
    'pending',
    'overdue',
    'refund',
    'net',
    'gross',
    'avg',
    'average',
    'max',
    'min',
    'percent',
    'ratio',
    'price',
    'cost',
    'user',
    'email',
    'phone',
    'address',
    'region',
    'country',
    'city',
    'subscription',
    'invoice',
    'payment',
    'billing',
    'period',
    'start',
    'end',
    'last',
    'first',
    'login',
    'session',
    'duration',
    'feature',
    'adoption',
    'usage',
    'byte',
    'bytes',
    'connections',
    'jobs',
    'queued',
    'error',
    'uptime',
    'response',
    'calls',
    'today',
    'month',
    'week',
    'year',
    'day',
    'at',
    'by',
    'per',
    'this',
    'new',
  ];

  let processed = raw;

  // If the entire string is uppercase and has no separators, try dictionary split
  if (/^[A-Z]+$/.test(raw) && raw.length > 3) {
    const lower = raw.toLowerCase();
    const result: string[] = [];
    let remaining = lower;

    while (remaining.length > 0) {
      // Greedy: try longest matching word first
      let matched = false;
      for (let len = Math.min(remaining.length, 14); len >= 2; len--) {
        const candidate = remaining.substring(0, len);
        if (KNOWN_WORDS.includes(candidate)) {
          result.push(candidate);
          remaining = remaining.substring(len);
          matched = true;
          break;
        }
      }
      if (!matched) {
        // No dictionary match found, take the rest as one word
        result.push(remaining);
        remaining = '';
      }
    }
    processed = result.join(' ');
  }

  const words = processed
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase boundary
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // ACRONYM followed by Word
    .replace(/_/g, ' ') // snake_case separator
    .split(/\s+/)
    .filter(Boolean);

  return words
    .map((w) => {
      const lower = w.toLowerCase();
      if (ABBREVIATIONS.has(lower)) return w.toUpperCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
};

/**
 * Smart value renderer for report cells. Handles all value types
 * so that [object Object] is never rendered in the UI:
 * - Primitives (string, number, boolean) -> direct string
 * - null/undefined                       -> dash placeholder
 * - Arrays                               -> comma-separated
 * - Objects (like planDistribution)       -> "Key: value" pairs
 */
const renderReportValue = (value: unknown): string => {
  if (value === null || value === undefined) return '\u2014';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => renderReportValue(v)).join(', ');
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${formatColumnHeader(k)}: ${renderReportValue(v)}`)
      .join(', ');
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol') return value.description ?? 'Symbol()';
  return '[unrenderable]';
};

// ============================================================================
// Report Definitions
// ============================================================================

const reportIcon = (
  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M9 17v-6m4 6V7m4 10v-3M5 21h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z"
    />
  </svg>
);

const reportDefinitions: readonly ReportDefinition[] =
  REPORT_CAPABILITY_CATALOG.entries.map((capability) => {
    const measurement = getReportMeasurementAuthority(capability.reportType);
    return {
      ...capability,
      icon: reportIcon,
      measurementState: measurement.state,
      ...(measurement.blocker === null
        ? {}
        : { unavailableReason: measurement.blocker }),
    };
  });

// ============================================================================
// Report Card Component
// ============================================================================

interface ReportCardProps {
  report: ReportDefinition;
  authorityVerified: boolean;
  onGenerate: (type: ReportType) => void;
}

const ReportCard: React.FC<ReportCardProps> = ({
  report,
  authorityVerified,
  onGenerate,
}) => {
  const categoryColors: Record<string, string> = {
    Tenant: 'bg-blue-100 text-blue-800',
    Financial: 'bg-green-100 text-green-800',
    Usage: 'bg-purple-100 text-purple-800',
    System: 'bg-orange-100 text-orange-800',
  };

  return (
    <Card className="hover:shadow-lg transition-shadow">
      <div className="flex items-start gap-4">
        <div className="p-3 bg-gray-100 rounded-lg text-gray-600">{report.icon}</div>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-semibold text-gray-900">{report.name}</h3>
            <span
              className={`px-2 py-0.5 rounded text-xs font-medium ${categoryColors[report.category]}`}
            >
              {report.category}
            </span>
          </div>
          <p className="text-sm text-gray-500 mb-4">{report.description}</p>
          {report.unavailableReason && (
            <p className="text-xs text-amber-700 mb-3">{report.unavailableReason}</p>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={() => onGenerate(report.reportType)}
            disabled={!authorityVerified || report.measurementState !== 'QUALIFIED'}
          >
            {!authorityVerified
              ? 'Verifying authority'
              : report.measurementState === 'QUALIFIED'
                ? 'Generate Report'
                : 'Unavailable'}
          </Button>
        </div>
      </div>
    </Card>
  );
};

// ============================================================================
// Report History Item
// ============================================================================

interface ReportHistoryItemProps {
  report: GeneratedReport;
  onDownload: (report: GeneratedReport) => void;
  onView: (report: GeneratedReport) => void;
}

const ReportHistoryItem: React.FC<ReportHistoryItemProps> = ({ report, onDownload, onView }) => {
  const statusColors: Record<string, string> = {
    pending: 'warning',
    ready: 'success',
    failed: 'error',
    unavailable: 'warning',
  };

  return (
    <div className="flex items-center justify-between p-4 border-b last:border-b-0 hover:bg-gray-50">
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-gray-900">{report.title}</span>
          <Badge variant={statusColors[report.status] as 'success' | 'warning' | 'error'}>
            {report.status === 'pending'
              ? 'Generating'
              : report.status === 'ready'
                ? 'Ready'
                : report.status === 'unavailable'
                  ? 'Unavailable'
                  : 'Failed'}
          </Badge>
        </div>
        <p className="text-sm text-gray-500">
          {new Date(report.generatedAt).toLocaleString()}
          {report.rowCount !== undefined ? ` - ${report.rowCount.toLocaleString()} rows` : ''}
        </p>
        {report.errorMessage && (
          <p className="text-xs text-amber-700 mt-1">{report.errorMessage}</p>
        )}
      </div>
      {report.status === 'ready' && (
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => onView(report)}>
            View
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onDownload(report)}>
            {report.format.toUpperCase()}
          </Button>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Reports Page
// ============================================================================

const ReportsPage: React.FC = () => {
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [generatedReports, setGeneratedReports] = useState<GeneratedReport[]>([]);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [selectedReportType, setSelectedReportType] = useState<ReportType | null>(null);
  const [selectedReport, setSelectedReport] = useState<GeneratedReport | null>(null);
  const [dateRange, setDateRange] = useState({
    startDate:
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split('T')[0] ?? '',
    endDate: new Date().toISOString().split('T')[0] ?? '',
  });
  const [selectedFormat, setSelectedFormat] = useState<ReportFormat>('json');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyLimit, setHistoryLimit] = useState(20);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyTotalPages, setHistoryTotalPages] = useState(1);
  const [historyHasNextPage, setHistoryHasNextPage] = useState(false);
  const [historyHasPreviousPage, setHistoryHasPreviousPage] = useState(false);
  const [authorityVerified, setAuthorityVerified] = useState(false);

  const categories = [
    'all',
    ...new Set(REPORT_CAPABILITY_CATALOG.entries.map((entry) => entry.category)),
  ];
  const selectedCapability =
    selectedReportType === null ? null : getReportCapability(selectedReportType);

  const filteredReports =
    activeCategory === 'all'
      ? reportDefinitions
      : reportDefinitions.filter((r) => r.category === activeCategory);

  const handleOpenGenerateModal = (type: ReportType): void => {
    if (!authorityVerified) {
      setError('The report authority graph has not been verified against the server');
      return;
    }
    const authority = getReportMeasurementAuthority(type);
    if (authority.state !== 'QUALIFIED') {
      setError(authority.blocker ?? 'Report measurement is not qualified');
      return;
    }
    setSelectedReportType(type);
    setShowGenerateModal(true);
    setError(null);
  };

  const verifyServerAuthority = useCallback(async () => {
    try {
      const capabilities = await reportsApi.getReportCapabilities();
      const exactGraph =
        capabilities.length === REPORT_CAPABILITY_CATALOG.entries.length &&
        capabilities.every((capability, index) => {
          const expected = REPORT_CAPABILITY_CATALOG.entries[index];
          return (
            expected !== undefined &&
            capability.type === expected.reportType &&
            capability.capabilityCatalogSha256 === REPORT_CAPABILITY_CATALOG_SHA256 &&
            capability.measurementCatalogSha256 ===
              REPORT_MEASUREMENT_AUTHORITY_CATALOG_SHA256 &&
            capability.authorityGraphSha256 === REPORT_AUTHORITY_GRAPH_SHA256 &&
            capability.measurementState ===
              getReportMeasurementAuthority(expected.reportType).state
          );
        });
      if (!exactGraph) {
        throw new Error('Server and browser report authority graphs do not match');
      }
      setAuthorityVerified(true);
    } catch (err) {
      setAuthorityVerified(false);
      setError(err instanceof Error ? err.message : 'Failed to verify report authority');
    }
  }, []);

  const loadReportHistory = useCallback(async () => {
    try {
      const response = await reportsApi.getReportExecutions({
        page: historyPage,
        limit: historyLimit,
      });
      const evidencePage = decodeReportExecutionEvidencePage(response);
      setGeneratedReports([...evidencePage.items]);
      setHistoryTotal(evidencePage.total);
      setHistoryTotalPages(evidencePage.totalPages);
      setHistoryHasNextPage(evidencePage.hasNextPage);
      setHistoryHasPreviousPage(evidencePage.hasPreviousPage);
    } catch (err) {
      setGeneratedReports([]);
      setHistoryTotal(0);
      setHistoryTotalPages(1);
      setHistoryHasNextPage(false);
      setHistoryHasPreviousPage(false);
      setError(err instanceof Error ? err.message : 'Failed to load report history');
    }
  }, [historyLimit, historyPage]);

  useEffect(() => {
    void loadReportHistory();
  }, [loadReportHistory]);

  useEffect(() => {
    void verifyServerAuthority();
  }, [verifyServerAuthority]);

  const handleGenerateReport = useCallback(async () => {
    if (!selectedReportType) return;

    setGenerating(true);
    setError(null);

    try {
      if (!authorityVerified) {
        throw new Error('The report authority graph has not been verified against the server');
      }
      const reportDef = reportDefinitions.find((r) => r.reportType === selectedReportType);
      if (!reportDef) throw new Error('Report definition not found');
      if (reportDef.measurementState !== 'QUALIFIED') {
        throw new Error(reportDef.unavailableReason ?? 'Report measurement is not qualified');
      }

      const execution = await reportsApi.executeReport({
        reportType: selectedReportType,
        reportName: reportDef.name,
        format: selectedFormat,
        ...(reportDef.range.policy === 'REQUIRED'
          ? {
              startDate: utcDayBoundary(dateRange.startDate),
              endDate: utcDayBoundary(dateRange.endDate),
            }
          : {}),
      });

      const newReport = decodeReportExecutionEvidence(execution);

      setGeneratedReports((prev) => [newReport, ...prev.filter((r) => r.id !== newReport.id)]);
      setShowGenerateModal(false);
      setSelectedReportType(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate report');
    } finally {
      setGenerating(false);
    }
  }, [authorityVerified, selectedReportType, selectedFormat, dateRange]);

  const handleDownload = async (report: GeneratedReport): Promise<void> => {
    try {
      const { blob, filename } = await reportsApi.downloadReport(report.id);
      downloadAdminOwnedBlob({
        blob,
        filename,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to download report');
    }
  };

  const handleViewReport = (report: GeneratedReport): void => {
    setSelectedReport(report);
    setShowPreviewModal(true);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Reports</h1>
          <p className="text-gray-500 mt-1">Generate and download detailed reports</p>
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
          <svg
            className="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0"
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
              clipRule="evenodd"
            />
          </svg>
          <p className="text-sm text-red-700 flex-1">{error}</p>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
      )}

      {/* Category Tabs */}
      <div className="flex flex-wrap gap-2">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeCategory === cat
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {cat === 'all' ? 'All' : cat}
          </button>
        ))}
      </div>

      {/* Report Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredReports.map((report) => (
          <ReportCard
            key={report.reportType}
            report={report}
            authorityVerified={authorityVerified}
            onGenerate={handleOpenGenerateModal}
          />
        ))}
      </div>

      {/* Generated Reports History */}
      <Card title="Report Execution Evidence">
        {generatedReports.length === 0 ? (
          <p className="p-4 text-sm text-gray-500">No report executions on this page.</p>
        ) : (
          <div className="divide-y">
            {generatedReports.map((report) => (
              <ReportHistoryItem
                key={report.id}
                report={report}
                onDownload={(report) => {
                  void handleDownload(report);
                }}
                onView={handleViewReport}
              />
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
          <p className="text-sm text-gray-500">
            Page {historyPage} of {historyTotalPages} · {historyTotal.toLocaleString()} executions
          </p>
          <div className="flex items-center gap-2">
            <label htmlFor="report-history-limit" className="text-sm text-gray-600">
              Rows
            </label>
            <select
              id="report-history-limit"
              value={historyLimit}
              onChange={(event) => {
                setHistoryLimit(Number(event.currentTarget.value));
                setHistoryPage(1);
              }}
              className="rounded border border-gray-300 px-2 py-1 text-sm"
            >
              {[10, 20, 50].map((limit) => (
                <option key={limit} value={limit}>
                  {limit}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              size="sm"
              disabled={!historyHasPreviousPage}
              onClick={() => setHistoryPage((page) => Math.max(1, page - 1))}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!historyHasNextPage}
              onClick={() => setHistoryPage((page) => page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </Card>

      {/* Generate Report Modal */}
      {showGenerateModal && selectedReportType && (
        <Modal
          isOpen={showGenerateModal}
          onClose={() => setShowGenerateModal(false)}
          title="Generate Report"
        >
          <div className="space-y-4">
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                {error}
              </div>
            )}

            <div>
              <p className="block text-sm font-medium text-gray-700 mb-2">Report Type</p>
              <p className="text-gray-900 font-medium">
                {reportDefinitions.find((r) => r.reportType === selectedReportType)?.name}
              </p>
              <p className="text-sm text-gray-500">
                {reportDefinitions.find((r) => r.reportType === selectedReportType)?.description}
              </p>
            </div>

            {selectedCapability?.range.policy === 'REQUIRED' && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="report-start-date"
                    className="block text-sm font-medium text-gray-700 mb-2"
                  >
                    Start Date
                  </label>
                  <Input
                    id="report-start-date"
                    type="date"
                    value={dateRange.startDate}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                      setDateRange((prev) => ({
                        ...prev,
                        startDate: event.currentTarget.value,
                      }))
                    }
                  />
                </div>
                <div>
                  <label
                    htmlFor="report-end-date"
                    className="block text-sm font-medium text-gray-700 mb-2"
                  >
                    End Date (exclusive)
                  </label>
                  <Input
                    id="report-end-date"
                    type="date"
                    value={dateRange.endDate}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                      setDateRange((prev) => ({
                        ...prev,
                        endDate: event.currentTarget.value,
                      }))
                    }
                  />
                </div>
              </div>
            )}

            <div>
              <p className="block text-sm font-medium text-gray-700 mb-2">Format</p>
              <div className="flex gap-2">
                {selectedCapability?.artifact.formats.map((format) => (
                  <button
                    key={format}
                    onClick={() => setSelectedFormat(format)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      selectedFormat === format
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {format.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t">
              <Button variant="secondary" onClick={() => setShowGenerateModal(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  void handleGenerateReport();
                }}
                disabled={
                  generating ||
                  !authorityVerified ||
                  getReportMeasurementAuthority(selectedReportType).state !== 'QUALIFIED'
                }
              >
                {generating ? 'Generating...' : 'Generate Report'}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Preview Modal */}
      {showPreviewModal && selectedReport && (
        <Modal
          isOpen={showPreviewModal}
          onClose={() => setShowPreviewModal(false)}
          title={`Report: ${selectedReport.title}`}
          size="xl"
        >
          <div className="space-y-4">
            {/* Summary */}
            {selectedReport.summary && Object.keys(selectedReport.summary).length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-2">Summary</h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {Object.entries(selectedReport.summary).map(([key, value]) => (
                    <div key={key} className="p-3 bg-gray-50 rounded-lg">
                      <p className="text-xs text-gray-500">{formatColumnHeader(key)}</p>
                      <p className="text-lg font-semibold text-gray-900">
                        {typeof value === 'number'
                          ? value.toLocaleString()
                          : renderReportValue(value)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Data Table */}
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-2">Data</h4>
              <div className="overflow-x-auto border rounded-lg">
                {Array.isArray(selectedReport.data) && selectedReport.data.length > 0 ? (
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        {Object.keys(selectedReport.data[0] as Record<string, unknown>).map(
                          (key) => (
                            <th
                              key={key}
                              className="px-4 py-3 text-left text-xs font-medium text-gray-500"
                            >
                              {formatColumnHeader(key)}
                            </th>
                          ),
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {(selectedReport.data as Record<string, unknown>[]).map((row, idx) => (
                          <tr key={idx}>
                            {Object.values(row).map((value, cellIdx) => (
                              <td key={cellIdx} className="px-4 py-3 text-sm text-gray-900">
                                {renderReportValue(value)}
                              </td>
                            ))}
                          </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="p-4 text-gray-500 text-center">No data available</p>
                )}
              </div>
              {Array.isArray(selectedReport.data) &&
                selectedReport.rowCount !== undefined &&
                selectedReport.rowCount > selectedReport.data.length && (
                <p className="text-sm text-gray-500 mt-2">
                  Showing the persisted {selectedReport.data.length}-row evidence preview of{' '}
                  {selectedReport.rowCount.toLocaleString()} rows. Download the qualified artifact
                  for the full dataset.
                </p>
              )}
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t">
              <Button variant="secondary" onClick={() => setShowPreviewModal(false)}>
                Close
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  void handleDownload(selectedReport);
                }}
              >
                Download Report
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default ReportsPage;
