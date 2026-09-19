/**
 * Reports Page
 *
 * Rapor olusturma ve indirme sayfasi.
 * Tenant, Financial, Usage ve System raporlari.
 * Uses real API data from backend reports service.
 */

import { Card, Button, Badge, DataTable, Modal, Input, PageHeader } from '@aquaculture/shared-ui';
import React, { useCallback, useState } from 'react';

import { reportsApi, type ReportExecution as ApiReportExecution } from '../services/adminApi';
import { adminKeys, useAdminMutation, useAdminQuery } from '../hooks';
import { QueryFailureNotice } from '../components';
import { saveBlob } from '../services/blob-client';
import {
  Building2,
  ChartColumn,
  CreditCard,
  DollarSign,
  FileText,
  LayoutGrid,
  Sparkles,
  TrendingUp,
} from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

type ReportType =
  | 'tenant_overview'
  | 'tenant_churn'
  | 'financial_revenue'
  | 'financial_payments'
  | 'usage_modules'
  | 'usage_features'
  | 'system_performance';

type ReportFormat = 'json' | 'csv' | 'pdf';

/**
 * A card in this page's report picker — a UI catalogue entry, not the API's
 * `ReportDefinition` row (which carries `schedule`, `recipients`, `runCount`
 * and no icon). The name collided with that contract schema, which is how a
 * REST response came to be typed as the wrong shape in ADMIN-HIGH-110; renamed
 * rather than allowlisted, so the collision stops existing (ADMIN-HIGH-115).
 */
interface ReportPickerCard {
  type: ReportType;
  name: string;
  description: string;
  category: string;
  icon: React.ReactNode;
}

interface GeneratedReport {
  id: string;
  type: ReportType;
  format: ReportFormat;
  title: string;
  generatedAt: string;
  status: 'pending' | 'ready' | 'failed';
  data?: unknown;
  summary?: Record<string, unknown>;
  rowCount?: number;
  fileSizeBytes?: number;
}

/** How often to re-read while an execution is still running. */
const PENDING_POLL_MS = 5_000;

const mapExecutionStatus = (status: ApiReportExecution['status']): GeneratedReport['status'] => {
  if (status === 'completed') return 'ready';
  if (status === 'failed') return 'failed';
  return 'pending';
};

const mapExecutionToReport = (execution: ApiReportExecution): GeneratedReport => ({
  id: execution.id,
  type: execution.reportType,
  format: execution.format,
  title: execution.reportName,
  generatedAt: execution.createdAt,
  status: mapExecutionStatus(execution.status),
  summary: execution.summary,
  rowCount: execution.rowCount,
  fileSizeBytes: execution.fileSizeBytes,
});

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

const reportDefinitions: ReportPickerCard[] = [
  {
    type: 'tenant_overview',
    name: 'Tenant Overview',
    description: 'Status, plans, and metrics for all tenants',
    category: 'Tenant',
    icon: <Building2 className="w-6 h-6" aria-hidden="true" />,
  },
  {
    type: 'tenant_churn',
    name: 'Churn Analizi',
    description: "Iptal eden tenant'lar ve nedenleri",
    category: 'Tenant',
    icon: <TrendingUp className="w-6 h-6" aria-hidden="true" />,
  },
  {
    type: 'financial_revenue',
    name: 'Gelir Raporu',
    description: 'Gunluk gelir, abonelik ve iadeler',
    category: 'Financial',
    icon: <DollarSign className="w-6 h-6" aria-hidden="true" />,
  },
  {
    type: 'financial_payments',
    name: 'Odeme Raporu',
    description: 'Fatura ve odeme durumlari',
    category: 'Financial',
    icon: <CreditCard className="w-6 h-6" aria-hidden="true" />,
  },
  {
    type: 'usage_modules',
    name: 'Modul Kullanimi',
    description: 'Her modulun kullanim istatistikleri',
    category: 'Usage',
    icon: <LayoutGrid className="w-6 h-6" aria-hidden="true" />,
  },
  {
    type: 'usage_features',
    name: 'Feature Adoption',
    description: 'Ozellik benimseme oranlari',
    category: 'Usage',
    icon: <ChartColumn className="w-6 h-6" aria-hidden="true" />,
  },
  {
    type: 'system_performance',
    name: 'Sistem Performansi',
    description: 'API performansi, uptime ve hata oranlari',
    category: 'System',
    icon: <ChartColumn className="w-6 h-6" aria-hidden="true" />,
  },
];

// ============================================================================
// Report Card Component
// ============================================================================

interface ReportCardProps {
  report: ReportPickerCard;
  onGenerate: (type: ReportType) => void;
}

const ReportCard: React.FC<ReportCardProps> = ({ report, onGenerate }) => {
  const categoryColors: Record<string, string> = {
    Tenant: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
    Financial: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
    Usage: 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
    System: 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
  };

  return (
    <Card className="hover:shadow-lg transition-shadow">
      <div className="flex items-start gap-4">
        <div className="p-3 bg-gray-100 dark:bg-gray-800 rounded-lg text-gray-600 dark:text-gray-400">
          {report.icon}
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">{report.name}</h3>
            <span
              className={`px-2 py-0.5 rounded text-xs font-medium ${categoryColors[report.category]}`}
            >
              {report.category}
            </span>
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{report.description}</p>
          <Button variant="primary" size="sm" onClick={() => onGenerate(report.type)}>
            Generate Report
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
  };

  return (
    <div className="flex items-center justify-between p-4 border-b last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-800">
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-gray-900 dark:text-gray-100">{report.title}</span>
          <Badge variant={statusColors[report.status] as 'success' | 'warning' | 'error'}>
            {report.status === 'pending'
              ? 'Generating'
              : report.status === 'ready'
                ? 'Ready'
                : 'Failed'}
          </Badge>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {new Date(report.generatedAt).toLocaleString()}
          {report.rowCount !== undefined ? ` - ${report.rowCount.toLocaleString()} rows` : ''}
        </p>
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
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [selectedReportType, setSelectedReportType] = useState<ReportType | null>(null);
  const [selectedReport, setSelectedReport] = useState<GeneratedReport | null>(null);
  const [dateRange, setDateRange] = useState({
    startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    endDate: new Date().toISOString().split('T')[0],
  });
  const [selectedFormat, setSelectedFormat] = useState<ReportFormat>('json');

  const categories = ['all', 'Tenant', 'Financial', 'Usage', 'System'];

  const filteredReports =
    activeCategory === 'all'
      ? reportDefinitions
      : reportDefinitions.filter((r) => r.category === activeCategory);

  const handleOpenGenerateModal = (type: ReportType): void => {
    setSelectedReportType(type);
    setShowGenerateModal(true);
  };

  // ==========================================================================
  // Read (ADMIN-HIGH-121)
  //
  // A queued execution used to sit on screen as "pending" until the operator
  // reloaded the page: the list was fetched once, and generating a report
  // unshifted the POST's own response — whatever status it carried at that
  // instant — into local state. `refetchInterval` re-reads while anything is
  // still running, so a report that finishes says so.
  // ==========================================================================

  const executionsQuery = useAdminQuery(
    adminKeys.reports.list(),
    ({ signal }) => reportsApi.getReportExecutions({ page: 1, limit: 20 }, signal),
    {
      refetchInterval: (query) =>
        (query.state.data?.data ?? []).some(
          (execution) => mapExecutionStatus(execution.status) === 'pending',
        )
          ? PENDING_POLL_MS
          : false,
    },
  );

  const generatedReports: GeneratedReport[] = (executionsQuery.data?.data ?? []).map(
    mapExecutionToReport,
  );

  // ==========================================================================
  // Writes (ADMIN-HIGH-121)
  // ==========================================================================

  const runReport = useAdminMutation<
    ApiReportExecution,
    {
      reportType: ReportType;
      reportName: string;
      format: ReportFormat;
      startDate: string;
      endDate: string;
    }
  >((input) => reportsApi.executeReport(input), {
    invalidateKeys: [adminKeys.reports.all()],
  });

  const downloadMutation = useAdminMutation<void, GeneratedReport>(async (report) => {
    const { blob, filename } = await reportsApi.downloadReport(report.id);
    const extension = report.format === 'pdf' ? 'pdf' : report.format === 'csv' ? 'csv' : 'json';
    const downloadName =
      filename || `${report.title.replace(/\s+/g, '_')}_${report.id}.${extension}`;

    saveBlob(blob, downloadName);
  });

  const generating = runReport.isPending;
  const queryErrors = [executionsQuery.error, runReport.error, downloadMutation.error];

  const loadReportHistory = (): void => {
    void executionsQuery.refetch();
  };

  const handleGenerateReport = useCallback(async (): Promise<void> => {
    if (!selectedReportType) return;

    const reportDef = reportDefinitions.find((r) => r.type === selectedReportType);
    if (!reportDef) return;

    try {
      await runReport.mutateAsync({
        reportType: selectedReportType,
        reportName: reportDef.name,
        format: selectedFormat,
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
      });
      setShowGenerateModal(false);
      setSelectedReportType(null);
    } catch {
      // `runReport.error` carries it; the modal stays open.
    }
  }, [selectedReportType, selectedFormat, dateRange, runReport]);

  const handleQuickReport = useCallback(
    async (type: ReportType, format: ReportFormat = 'json'): Promise<void> => {
      const reportDef = reportDefinitions.find((r) => r.type === type);
      if (!reportDef) return;

      const endDate = new Date();
      const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      try {
        await runReport.mutateAsync({
          reportType: type,
          reportName: reportDef.name,
          format,
          startDate: startDate.toISOString().split('T')[0] ?? '',
          endDate: endDate.toISOString().split('T')[0] ?? '',
        });
      } catch {
        // Reported through `runReport.error`.
      }
    },
    [runReport],
  );

  const handleDownload = async (report: GeneratedReport): Promise<void> => {
    try {
      await downloadMutation.mutateAsync(report);
    } catch {
      // Reported through `downloadMutation.error`.
    }
  };

  const handleViewReport = (report: GeneratedReport): void => {
    setSelectedReport(report);
    setShowPreviewModal(true);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader title="Reports" description="Generate and download detailed reports" />

      {/* A failed history read, a refused execution, or a download the server
          would not produce — each named, with a retry. */}
      <QueryFailureNotice
        errors={queryErrors}
        hasContent={executionsQuery.data !== undefined}
        onRetry={loadReportHistory}
      />

      {/* Category Tabs */}
      <div className="flex flex-wrap gap-2">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeCategory === cat
                ? 'bg-info-600 text-white'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
          >
            {cat === 'all' ? 'All' : cat}
          </button>
        ))}
      </div>

      {/* Report Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredReports.map((report) => (
          <ReportCard key={report.type} report={report} onGenerate={handleOpenGenerateModal} />
        ))}
      </div>

      {/* Generated Reports History */}
      {generatedReports.length > 0 && (
        <Card title="Recently Generated Reports">
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
        </Card>
      )}

      {/* Quick Export Section */}
      <Card title="Quick Export">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <button
            onClick={() => {
              void handleQuickReport('tenant_overview', 'csv');
            }}
            className="p-4 border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-lg hover:border-info-400 hover:bg-info-50 transition-colors text-center"
          >
            <FileText
              className="w-8 h-8 mx-auto text-gray-500 dark:text-gray-400 mb-2"
              aria-hidden="true"
            />
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Tenant CSV</p>
          </button>
          <button
            onClick={() => {
              void handleQuickReport('financial_revenue', 'csv');
            }}
            className="p-4 border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-lg hover:border-success-400 hover:bg-success-50 transition-colors text-center"
          >
            <DollarSign
              className="w-8 h-8 mx-auto text-gray-500 dark:text-gray-400 mb-2"
              aria-hidden="true"
            />
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Revenue CSV</p>
          </button>
          <button
            onClick={() => {
              void handleQuickReport('usage_modules', 'csv');
            }}
            className="p-4 border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-lg hover:border-accent-400 hover:bg-accent-50 transition-colors text-center"
          >
            <ChartColumn
              className="w-8 h-8 mx-auto text-gray-500 dark:text-gray-400 mb-2"
              aria-hidden="true"
            />
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Usage CSV</p>
          </button>
          <button
            onClick={() => {
              void handleQuickReport('system_performance', 'csv');
            }}
            className="p-4 border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-lg hover:border-accent-400 hover:bg-accent-50 transition-colors text-center"
          >
            <Sparkles
              className="w-8 h-8 mx-auto text-gray-500 dark:text-gray-400 mb-2"
              aria-hidden="true"
            />
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Performance CSV</p>
          </button>
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
            {runReport.error && (
              <div className="p-3 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg text-error-700 dark:text-error-300 text-sm">
                {runReport.error.message}
              </div>
            )}

            <div>
              <p className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Report Type
              </p>
              <p className="text-gray-900 dark:text-gray-100 font-medium">
                {reportDefinitions.find((r) => r.type === selectedReportType)?.name}
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {reportDefinitions.find((r) => r.type === selectedReportType)?.description}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="report-start-date"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
                >
                  Start Date
                </label>
                <Input
                  id="report-start-date"
                  type="date"
                  value={dateRange.startDate}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                    setDateRange((prev) => ({ ...prev, startDate: event.currentTarget.value }))
                  }
                />
              </div>
              <div>
                <label
                  htmlFor="report-end-date"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
                >
                  End Date
                </label>
                <Input
                  id="report-end-date"
                  type="date"
                  value={dateRange.endDate}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                    setDateRange((prev) => ({ ...prev, endDate: event.currentTarget.value }))
                  }
                />
              </div>
            </div>

            <div>
              <p className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Format
              </p>
              <div className="flex gap-2">
                {(['json', 'csv', 'pdf'] as ReportFormat[]).map((format) => (
                  <button
                    key={format}
                    onClick={() => setSelectedFormat(format)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      selectedFormat === format
                        ? 'bg-info-600 text-white'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
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
                disabled={generating}
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
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Summary
                </h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {Object.entries(selectedReport.summary).map(([key, value]) => (
                    <div key={key} className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {formatColumnHeader(key)}
                      </p>
                      <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
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
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Data</h4>
              {Array.isArray(selectedReport.data) && selectedReport.data.length > 0 ? (
                <DataTable<Record<string, unknown>>
                  data={(selectedReport.data as Record<string, unknown>[]).slice(0, 10)}
                  columns={Object.keys(selectedReport.data[0] as Record<string, unknown>).map(
                    (key) => ({
                      key,
                      header: formatColumnHeader(key),
                      render: (_value: unknown, row: Record<string, unknown>) =>
                        renderReportValue(row[key]),
                    }),
                  )}
                  keyExtractor={(row) => JSON.stringify(row)}
                  searchable={false}
                  sortable={false}
                  stickyHeader={false}
                  compact
                  className="border rounded-lg shadow-none"
                />
              ) : (
                <div className="border rounded-lg">
                  <p className="p-4 text-gray-500 dark:text-gray-400 text-center">
                    No data available
                  </p>
                </div>
              )}
              {Array.isArray(selectedReport.data) && selectedReport.data.length > 10 && (
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
                  Showing first 10 records. Download the report for all data.
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
