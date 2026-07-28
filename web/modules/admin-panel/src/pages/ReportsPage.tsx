/**
 * Reports Page
 *
 * Rapor olusturma ve indirme sayfasi.
 * Tenant, Financial, Usage ve System raporlari.
 * Uses real API data from backend reports service.
 */

import { Card, Button, Badge, Modal, Input } from '@aquaculture/shared-ui';
import React, { useCallback, useEffect, useState } from 'react';

import { reportsApi, type ReportExecution as ApiReportExecution } from '../services/adminApi';

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

interface ReportDefinition {
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
    'created', 'updated', 'deleted', 'storage', 'revenue', 'amount',
    'count', 'total', 'active', 'status', 'tenant', 'module', 'plan',
    'distribution', 'monthly', 'annual', 'daily', 'weekly', 'churn',
    'growth', 'rate', 'date', 'time', 'name', 'type', 'used', 'free',
    'paid', 'pending', 'overdue', 'refund', 'net', 'gross', 'avg',
    'average', 'max', 'min', 'percent', 'ratio', 'price', 'cost',
    'user', 'email', 'phone', 'address', 'region', 'country', 'city',
    'subscription', 'invoice', 'payment', 'billing', 'period', 'start',
    'end', 'last', 'first', 'login', 'session', 'duration', 'feature',
    'adoption', 'usage', 'byte', 'bytes', 'connections', 'jobs',
    'queued', 'error', 'uptime', 'response', 'calls', 'today', 'month',
    'week', 'year', 'day', 'at', 'by', 'per', 'this', 'new',
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
    .replace(/([a-z])([A-Z])/g, '$1 $2')         // camelCase boundary
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')   // ACRONYM followed by Word
    .replace(/_/g, ' ')                            // snake_case separator
    .split(/\s+/)
    .filter(Boolean);

  return words.map(w => {
    const lower = w.toLowerCase();
    if (ABBREVIATIONS.has(lower)) return w.toUpperCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(' ');
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
    return value.map(v => renderReportValue(v)).join(', ');
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

const reportDefinitions: ReportDefinition[] = [
  {
    type: 'tenant_overview',
    name: 'Tenant Overview',
    description: 'Status, plans, and metrics for all tenants',
    category: 'Tenant',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
      </svg>
    ),
  },
  {
    type: 'tenant_churn',
    name: 'Churn Analizi',
    description: 'Iptal eden tenant\'lar ve nedenleri',
    category: 'Tenant',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" />
      </svg>
    ),
  },
  {
    type: 'financial_revenue',
    name: 'Gelir Raporu',
    description: 'Gunluk gelir, abonelik ve iadeler',
    category: 'Financial',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    type: 'financial_payments',
    name: 'Odeme Raporu',
    description: 'Fatura ve odeme durumlari',
    category: 'Financial',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
      </svg>
    ),
  },
  {
    type: 'usage_modules',
    name: 'Modul Kullanimi',
    description: 'Her modulun kullanim istatistikleri',
    category: 'Usage',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
      </svg>
    ),
  },
  {
    type: 'usage_features',
    name: 'Feature Adoption',
    description: 'Ozellik benimseme oranlari',
    category: 'Usage',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
  {
    type: 'system_performance',
    name: 'Sistem Performansi',
    description: 'API performansi, uptime ve hata oranlari',
    category: 'System',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
];

// ============================================================================
// Report Card Component
// ============================================================================

interface ReportCardProps {
  report: ReportDefinition;
  onGenerate: (type: ReportType) => void;
}

const ReportCard: React.FC<ReportCardProps> = ({ report, onGenerate }) => {
  const categoryColors: Record<string, string> = {
    Tenant: 'bg-blue-100 text-blue-800',
    Financial: 'bg-green-100 text-green-800',
    Usage: 'bg-purple-100 text-purple-800',
    System: 'bg-orange-100 text-orange-800',
  };

  return (
    <Card className="hover:shadow-lg transition-shadow">
      <div className="flex items-start gap-4">
        <div className="p-3 bg-gray-100 rounded-lg text-gray-600">
          {report.icon}
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-semibold text-gray-900">{report.name}</h3>
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${categoryColors[report.category]}`}>
              {report.category}
            </span>
          </div>
          <p className="text-sm text-gray-500 mb-4">{report.description}</p>
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
    <div className="flex items-center justify-between p-4 border-b last:border-b-0 hover:bg-gray-50">
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-gray-900">{report.title}</span>
          <Badge variant={statusColors[report.status] as 'success' | 'warning' | 'error'}>
            {report.status === 'pending' ? 'Generating' : report.status === 'ready' ? 'Ready' : 'Failed'}
          </Badge>
        </div>
        <p className="text-sm text-gray-500">
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

/** Executions per history page. */
const HISTORY_PAGE_SIZE = 20;

const ReportsPage: React.FC = () => {
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [generatedReports, setGeneratedReports] = useState<GeneratedReport[]>([]);
  // The history endpoint is paginated end to end — the page just discarded the
  // metadata and pinned itself to the first 20, making the 21st execution
  // unreachable even while its download link stayed valid (APA-148).
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [selectedReportType, setSelectedReportType] = useState<ReportType | null>(null);
  const [selectedReport, setSelectedReport] = useState<GeneratedReport | null>(null);
  const [dateRange, setDateRange] = useState({
    startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    endDate: new Date().toISOString().split('T')[0],
  });
  const [selectedFormat, setSelectedFormat] = useState<ReportFormat>('json');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const categories = ['all', 'Tenant', 'Financial', 'Usage', 'System'];

  const filteredReports = activeCategory === 'all'
    ? reportDefinitions
    : reportDefinitions.filter(r => r.category === activeCategory);

  const handleOpenGenerateModal = (type: ReportType): void => {
    setSelectedReportType(type);
    setShowGenerateModal(true);
    setError(null);
  };

  const loadReportHistory = useCallback(async () => {
    try {
      const response = await reportsApi.getReportExecutions({
        page: historyPage,
        limit: HISTORY_PAGE_SIZE,
      });
      setGeneratedReports(response.data.map(mapExecutionToReport));
      setHistoryTotal(response.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load report history');
    }
  }, [historyPage]);

  useEffect(() => {
    void loadReportHistory();
  }, [loadReportHistory]);

  const handleGenerateReport = useCallback(async () => {
    if (!selectedReportType) return;

    setGenerating(true);
    setError(null);

    try {
      const reportDef = reportDefinitions.find(r => r.type === selectedReportType);
      if (!reportDef) throw new Error('Report definition not found');

      const execution = await reportsApi.executeReport({
        reportType: selectedReportType,
        reportName: reportDef.name,
        format: selectedFormat,
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
      });

      // Return to page 1, where the server puts the newest execution, and let
      // the reload refresh both the rows and the total. Splicing it into the
      // page the user happens to be on desynchronises the list from the count.
      if (historyPage === 1) {
        void loadReportHistory();
      } else {
        setHistoryPage(1);
      }
      setShowGenerateModal(false);
      setSelectedReportType(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate report');
    } finally {
      setGenerating(false);
    }
  }, [selectedReportType, selectedFormat, dateRange, historyPage, loadReportHistory]);

  const handleQuickReport = useCallback(async (type: ReportType, format: ReportFormat = 'json') => {
    const reportDef = reportDefinitions.find(r => r.type === type);
    if (!reportDef) return;

    try {
      const endDate = new Date();
      const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const execution = await reportsApi.executeReport({
        reportType: type,
        reportName: reportDef.name,
        format,
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
      });

      if (historyPage === 1) {
        void loadReportHistory();
      } else {
        setHistoryPage(1);
      }
    } catch (err) {
      setError(`Failed to generate report: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [historyPage, loadReportHistory]);

  const handleDownload = async (report: GeneratedReport): Promise<void> => {
    try {
      const { blob, filename } = await reportsApi.downloadReport(report.id);
      const extension = report.format === 'pdf' ? 'pdf' : report.format === 'csv' ? 'csv' : 'json';
      const downloadName = filename || `${report.title.replace(/\s+/g, '_')}_${report.id}.${extension}`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = downloadName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
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
          <svg className="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
          </svg>
          <p className="text-sm text-red-700 flex-1">{error}</p>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      )}

      {/* Category Tabs */}
      <div className="flex flex-wrap gap-2">
        {categories.map(cat => (
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
        {filteredReports.map(report => (
          <ReportCard
            key={report.type}
            report={report}
            onGenerate={handleOpenGenerateModal}
          />
        ))}
      </div>

      {/* Generated Reports History */}
      {generatedReports.length > 0 && (
        <Card title="Recently Generated Reports">
          <div className="divide-y">
            {generatedReports.map(report => (
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
          {historyTotal > HISTORY_PAGE_SIZE && (
            <div className="flex items-center justify-between pt-4 mt-2 border-t text-sm">
              <span className="text-gray-500">
                {(historyPage - 1) * HISTORY_PAGE_SIZE + 1}-
                {Math.min(historyPage * HISTORY_PAGE_SIZE, historyTotal)} / {historyTotal}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setHistoryPage((p) => Math.max(1, p - 1))}
                  disabled={historyPage === 1}
                  className="px-3 py-1 rounded border disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
                >
                  Previous
                </button>
                <button
                  type="button"
                  onClick={() => setHistoryPage((p) => p + 1)}
                  disabled={historyPage * HISTORY_PAGE_SIZE >= historyTotal}
                  className="px-3 py-1 rounded border disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Quick Export Section */}
      <Card title="Quick Export">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <button
            onClick={() => {
              void handleQuickReport('tenant_overview', 'csv');
            }}
            className="p-4 border-2 border-dashed border-gray-200 rounded-lg hover:border-blue-400 hover:bg-blue-50 transition-colors text-center"
          >
            <svg className="w-8 h-8 mx-auto text-gray-500 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p className="text-sm font-medium text-gray-700">Tenant CSV</p>
          </button>
          <button
            onClick={() => {
              void handleQuickReport('financial_revenue', 'csv');
            }}
            className="p-4 border-2 border-dashed border-gray-200 rounded-lg hover:border-green-400 hover:bg-green-50 transition-colors text-center"
          >
            <svg className="w-8 h-8 mx-auto text-gray-500 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm font-medium text-gray-700">Revenue CSV</p>
          </button>
          <button
            onClick={() => {
              void handleQuickReport('usage_modules', 'csv');
            }}
            className="p-4 border-2 border-dashed border-gray-200 rounded-lg hover:border-purple-400 hover:bg-purple-50 transition-colors text-center"
          >
            <svg className="w-8 h-8 mx-auto text-gray-500 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            <p className="text-sm font-medium text-gray-700">Usage CSV</p>
          </button>
          <button
            onClick={() => {
              void handleQuickReport('system_performance', 'csv');
            }}
            className="p-4 border-2 border-dashed border-gray-200 rounded-lg hover:border-orange-400 hover:bg-orange-50 transition-colors text-center"
          >
            <svg className="w-8 h-8 mx-auto text-gray-500 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
            </svg>
            <p className="text-sm font-medium text-gray-700">Performance CSV</p>
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
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                {error}
              </div>
            )}

            <div>
              <p className="block text-sm font-medium text-gray-700 mb-2">
                Report Type
              </p>
              <p className="text-gray-900 font-medium">
                {reportDefinitions.find(r => r.type === selectedReportType)?.name}
              </p>
              <p className="text-sm text-gray-500">
                {reportDefinitions.find(r => r.type === selectedReportType)?.description}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="report-start-date" className="block text-sm font-medium text-gray-700 mb-2">
                  Start Date
                </label>
                <Input
                  id="report-start-date"
                  type="date"
                  value={dateRange.startDate}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                    setDateRange(prev => ({ ...prev, startDate: event.currentTarget.value }))
                  }
                />
              </div>
              <div>
                <label htmlFor="report-end-date" className="block text-sm font-medium text-gray-700 mb-2">
                  End Date
                </label>
                <Input
                  id="report-end-date"
                  type="date"
                  value={dateRange.endDate}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                    setDateRange(prev => ({ ...prev, endDate: event.currentTarget.value }))
                  }
                />
              </div>
            </div>

            <div>
              <p className="block text-sm font-medium text-gray-700 mb-2">
                Format
              </p>
              <div className="flex gap-2">
                {(['json', 'csv', 'pdf'] as ReportFormat[]).map((format) => (
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
                <h4 className="text-sm font-medium text-gray-700 mb-2">Summary</h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {Object.entries(selectedReport.summary).map(([key, value]) => (
                    <div key={key} className="p-3 bg-gray-50 rounded-lg">
                      <p className="text-xs text-gray-500">{formatColumnHeader(key)}</p>
                      <p className="text-lg font-semibold text-gray-900">
                        {typeof value === 'number' ? value.toLocaleString() : renderReportValue(value)}
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
                        {Object.keys(selectedReport.data[0] as Record<string, unknown>).map((key) => (
                          <th
                            key={key}
                            className="px-4 py-3 text-left text-xs font-medium text-gray-500"
                          >
                            {formatColumnHeader(key)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {(selectedReport.data as Record<string, unknown>[]).slice(0, 10).map((row, idx) => (
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
              {Array.isArray(selectedReport.data) && selectedReport.data.length > 10 && (
                <p className="text-sm text-gray-500 mt-2">
                  Showing first 10 records. Download the report for all data.
                </p>
              )}
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t">
              <Button variant="secondary" onClick={() => setShowPreviewModal(false)}>
                Close
              </Button>
              <Button variant="primary" onClick={() => {
                void handleDownload(selectedReport);
              }}>
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
