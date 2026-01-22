/**
 * Reports Page
 *
 * Rapor olusturma ve indirme sayfasi.
 * Tenant, Financial, Usage ve System raporlari.
 * Uses real API data from backend reports service.
 */

import React, { useState, useCallback } from 'react';
import { Card, Button, Badge, Modal, Input } from '@aquaculture/shared-ui';
import { useAsyncData } from '../hooks/useAsyncData';

// ============================================================================
// API Configuration
// ============================================================================

const API_BASE_URL = import.meta.env.VITE_ADMIN_API_URL || '/api';

// Simple fetch wrapper
const apiFetch = async <T,>(endpoint: string, options?: RequestInit): Promise<T> => {
  const token = localStorage.getItem('access_token');
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'API Error' }));
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  return response.json();
};

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

type ReportFormat = 'json' | 'csv' | 'excel' | 'pdf';

interface ReportDefinition {
  type: ReportType;
  name: string;
  description: string;
  category: string;
  icon: React.ReactNode;
  endpoint: string;
}

interface GeneratedReport {
  id: string;
  type: ReportType;
  format: ReportFormat;
  title: string;
  generatedAt: string;
  status: 'pending' | 'ready' | 'failed';
  downloadUrl?: string;
  data?: unknown;
  summary?: Record<string, unknown>;
}

interface ReportApiResponse {
  data: unknown[];
  summary: Record<string, unknown>;
  metadata?: {
    generatedAt: string;
    reportType: string;
    format: string;
  };
}

// Helper function to convert report type to CSV export type
const getReportTypeForExport = (reportType: ReportType): string => {
  switch (reportType) {
    case 'tenant_overview':
    case 'tenant_churn':
      return 'tenants';
    case 'financial_revenue':
      return 'revenue';
    case 'financial_payments':
      return 'payments';
    case 'usage_modules':
    case 'usage_features':
      return 'users';
    default:
      return 'tenants';
  }
};

// ============================================================================
// Report Definitions
// ============================================================================

const reportDefinitions: ReportDefinition[] = [
  {
    type: 'tenant_overview',
    name: 'Tenant Ozeti',
    description: 'Tum tenant\'larin durumu, planlari ve metrikleri',
    category: 'Tenant',
    endpoint: '/reports/tenant-overview',
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
    endpoint: '/reports/churn-analysis',
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
    endpoint: '/reports/revenue',
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
    endpoint: '/reports/payments',
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
    endpoint: '/reports/module-usage',
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
    endpoint: '/reports/feature-usage',
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
    endpoint: '/reports/system-performance',
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
            Rapor Olustur
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
  onDownload: (report: GeneratedReport, format: ReportFormat) => void;
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
            {report.status === 'pending' ? 'Hazirlaniyor' : report.status === 'ready' ? 'Hazir' : 'Basarisiz'}
          </Badge>
        </div>
        <p className="text-sm text-gray-500">
          {new Date(report.generatedAt).toLocaleString('tr-TR')}
        </p>
      </div>
      {report.status === 'ready' && (
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => onView(report)}>
            Goruntule
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onDownload(report, 'csv')}>
            CSV
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onDownload(report, 'excel')}>
            Excel
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onDownload(report, 'pdf')}>
            PDF
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

  const handleOpenGenerateModal = (type: ReportType) => {
    setSelectedReportType(type);
    setShowGenerateModal(true);
    setError(null);
  };

  const handleGenerateReport = useCallback(async () => {
    if (!selectedReportType) return;

    setGenerating(true);
    setError(null);

    try {
      const reportDef = reportDefinitions.find(r => r.type === selectedReportType);
      if (!reportDef) throw new Error('Report definition not found');

      // Call the backend API to generate the report
      const response = await apiFetch<ReportApiResponse>('/reports/generate', {
        method: 'POST',
        body: JSON.stringify({
          type: selectedReportType,
          format: selectedFormat,
          startDate: dateRange.startDate,
          endDate: dateRange.endDate,
        }),
      });

      const newReport: GeneratedReport = {
        id: `rpt_${Date.now()}`,
        type: selectedReportType,
        format: selectedFormat,
        title: reportDef.name,
        generatedAt: new Date().toISOString(),
        status: 'ready',
        data: response.data,
        summary: response.summary,
      };

      setGeneratedReports(prev => [newReport, ...prev]);
      setShowGenerateModal(false);
      setSelectedReportType(null);
    } catch (err) {
      console.error('Failed to generate report:', err);
      setError(err instanceof Error ? err.message : 'Rapor olusturulamadi');
    } finally {
      setGenerating(false);
    }
  }, [selectedReportType, selectedFormat, dateRange]);

  const handleQuickReport = useCallback(async (type: ReportType, format: ReportFormat = 'json') => {
    const reportDef = reportDefinitions.find(r => r.type === type);
    if (!reportDef) return;

    try {
      const response = await apiFetch<ReportApiResponse>(`${reportDef.endpoint}?format=${format}`);

      const newReport: GeneratedReport = {
        id: `rpt_${Date.now()}`,
        type,
        format,
        title: reportDef.name,
        generatedAt: new Date().toISOString(),
        status: 'ready',
        data: response.data,
        summary: response.summary,
      };

      setGeneratedReports(prev => [newReport, ...prev]);
    } catch (err) {
      console.error('Failed to generate quick report:', err);
      alert(`Rapor olusturulamadi: ${err instanceof Error ? err.message : 'Bilinmeyen hata'}`);
    }
  }, []);

  const handleDownload = async (report: GeneratedReport, format: ReportFormat) => {
    const data = report.data as unknown[];
    let content: string;
    let mimeType: string;
    let extension: string;

    switch (format) {
      case 'csv':
        if (data && data.length > 0) {
          const firstRow = data[0] as Record<string, unknown>;
          const headers = Object.keys(firstRow);
          const rows = data.map(row => {
            const r = row as Record<string, unknown>;
            return headers.map(h => String(r[h] ?? '')).join(',');
          });
          content = [headers.join(','), ...rows].join('\n');
        } else {
          content = '';
        }
        mimeType = 'text/csv';
        extension = 'csv';
        break;
      case 'json':
        content = JSON.stringify({ data: report.data, summary: report.summary }, null, 2);
        mimeType = 'application/json';
        extension = 'json';
        break;
      case 'excel':
        // Excel format - use CSV export as fallback (backend doesn't support excel natively)
        try {
          const csvExportUrl = `${API_BASE_URL}/reports/export/csv?type=${getReportTypeForExport(report.type)}`;
          window.open(csvExportUrl, '_blank');
          return;
        } catch {
          alert('Excel formatı için CSV indirme kullanılıyor.');
          return;
        }
      case 'pdf':
        // For PDF, use the correct backend endpoint with reportType as path param
        try {
          const pdfExportUrl = `${API_BASE_URL}/reports/export/pdf/${report.type}`;
          window.open(pdfExportUrl, '_blank');
          return;
        } catch {
          alert('PDF formatı için sunucu tarafli islem gereklidir.');
          return;
        }
      default:
        return;
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${report.title.replace(/\s+/g, '_')}_${Date.now()}.${extension}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleViewReport = (report: GeneratedReport) => {
    setSelectedReport(report);
    setShowPreviewModal(true);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Raporlar</h1>
          <p className="text-gray-500 mt-1">Detayli raporlar olusturun ve indirin</p>
        </div>
      </div>

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
            {cat === 'all' ? 'Tumunu Goster' : cat}
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
        <Card title="Son Olusturulan Raporlar">
          <div className="divide-y">
            {generatedReports.map(report => (
              <ReportHistoryItem
                key={report.id}
                report={report}
                onDownload={handleDownload}
                onView={handleViewReport}
              />
            ))}
          </div>
        </Card>
      )}

      {/* Quick Export Section */}
      <Card title="Hizli Export">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <button
            onClick={() => handleQuickReport('tenant_overview', 'csv')}
            className="p-4 border-2 border-dashed border-gray-200 rounded-lg hover:border-blue-400 hover:bg-blue-50 transition-colors text-center"
          >
            <svg className="w-8 h-8 mx-auto text-gray-400 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p className="text-sm font-medium text-gray-700">Tenant CSV</p>
          </button>
          <button
            onClick={() => handleQuickReport('financial_revenue', 'csv')}
            className="p-4 border-2 border-dashed border-gray-200 rounded-lg hover:border-green-400 hover:bg-green-50 transition-colors text-center"
          >
            <svg className="w-8 h-8 mx-auto text-gray-400 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm font-medium text-gray-700">Gelir CSV</p>
          </button>
          <button
            onClick={() => handleQuickReport('usage_modules', 'csv')}
            className="p-4 border-2 border-dashed border-gray-200 rounded-lg hover:border-purple-400 hover:bg-purple-50 transition-colors text-center"
          >
            <svg className="w-8 h-8 mx-auto text-gray-400 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            <p className="text-sm font-medium text-gray-700">Kullanim CSV</p>
          </button>
          <button
            onClick={() => handleQuickReport('system_performance', 'csv')}
            className="p-4 border-2 border-dashed border-gray-200 rounded-lg hover:border-orange-400 hover:bg-orange-50 transition-colors text-center"
          >
            <svg className="w-8 h-8 mx-auto text-gray-400 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
            </svg>
            <p className="text-sm font-medium text-gray-700">Performans CSV</p>
          </button>
        </div>
      </Card>

      {/* Generate Report Modal */}
      {showGenerateModal && selectedReportType && (
        <Modal
          isOpen={showGenerateModal}
          onClose={() => setShowGenerateModal(false)}
          title="Rapor Olustur"
        >
          <div className="space-y-4">
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                {error}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Rapor Turu
              </label>
              <p className="text-gray-900 font-medium">
                {reportDefinitions.find(r => r.type === selectedReportType)?.name}
              </p>
              <p className="text-sm text-gray-500">
                {reportDefinitions.find(r => r.type === selectedReportType)?.description}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Baslangic Tarihi
                </label>
                <Input
                  type="date"
                  value={dateRange.startDate}
                  onChange={(e) => setDateRange(prev => ({ ...prev, startDate: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Bitis Tarihi
                </label>
                <Input
                  type="date"
                  value={dateRange.endDate}
                  onChange={(e) => setDateRange(prev => ({ ...prev, endDate: e.target.value }))}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Format
              </label>
              <div className="flex gap-2">
                {(['json', 'csv', 'excel', 'pdf'] as ReportFormat[]).map((format) => (
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
                Iptal
              </Button>
              <Button variant="primary" onClick={handleGenerateReport} disabled={generating}>
                {generating ? 'Olusturuluyor...' : 'Rapor Olustur'}
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
          title={`Rapor: ${selectedReport.title}`}
          size="xl"
        >
          <div className="space-y-4">
            {/* Summary */}
            {selectedReport.summary && Object.keys(selectedReport.summary).length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-2">Ozet</h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {Object.entries(selectedReport.summary).map(([key, value]) => (
                    <div key={key} className="p-3 bg-gray-50 rounded-lg">
                      <p className="text-xs text-gray-500">{key.replace(/([A-Z])/g, ' $1').trim()}</p>
                      <p className="text-lg font-semibold text-gray-900">
                        {typeof value === 'number' ? value.toLocaleString() : String(value)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Data Table */}
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-2">Veri</h4>
              <div className="overflow-x-auto border rounded-lg">
                {Array.isArray(selectedReport.data) && selectedReport.data.length > 0 ? (
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        {Object.keys(selectedReport.data[0] as Record<string, unknown>).map((key) => (
                          <th
                            key={key}
                            className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase"
                          >
                            {key}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {(selectedReport.data as Record<string, unknown>[]).slice(0, 10).map((row, idx) => (
                        <tr key={idx}>
                          {Object.values(row).map((value, cellIdx) => (
                            <td key={cellIdx} className="px-4 py-3 text-sm text-gray-900">
                              {String(value ?? '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="p-4 text-gray-500 text-center">Veri bulunamadi</p>
                )}
              </div>
              {Array.isArray(selectedReport.data) && selectedReport.data.length > 10 && (
                <p className="text-sm text-gray-500 mt-2">
                  Ilk 10 kayit gosteriliyor. Tumu icin raporu indirin.
                </p>
              )}
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t">
              <Button variant="secondary" onClick={() => setShowPreviewModal(false)}>
                Kapat
              </Button>
              <Button variant="primary" onClick={() => handleDownload(selectedReport, 'csv')}>
                CSV Indir
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default ReportsPage;
