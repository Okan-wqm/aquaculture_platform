/**
 * Schema Statistics Component
 *
 * Displays statistics dashboard for a database schema including:
 * - Total tables, size, rows estimates
 * - Data vs Index size ratio (CSS pie chart)
 * - Largest tables (CSS bar chart)
 * - Table categories breakdown
 * - Quick actions
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Card, Button, Alert } from '@aquaculture/shared-ui';
import { getAccessToken } from '@platform/shared-ui/utils/api-client';

// ============================================================================
// Types
// ============================================================================

export interface SchemaStatisticsProps {
  schema: string;
  schemaType: 'system' | 'tenant';
}

interface TableStatistic {
  tableName: string;
  sizeBytes: number;
  rowCount: number;
  dataSizeBytes: number;
  indexSizeBytes: number;
}

interface SchemaStatisticsData {
  schemaName: string;
  totalTables: number;
  totalSizeBytes: number;
  totalRowsEstimate: number;
  dataSizeBytes: number;
  indexSizeBytes: number;
  tables: TableStatistic[];
}

interface TableCategory {
  pattern: string;
  displayName: string;
  count: number;
  tables: string[];
}

// ============================================================================
// API Functions
// ============================================================================

const API_BASE = '/api/database/explorer';

const getAuthHeader = (): Record<string, string> => {
  const token = getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

async function fetchSchemaStatistics(schema: string): Promise<SchemaStatisticsData> {
  const response = await fetch(`${API_BASE}/schemas/${schema}/statistics`, {
    credentials: 'include',
    headers: { ...getAuthHeader() },
  });
  if (!response.ok) {
    throw new Error('Failed to fetch schema statistics');
  }
  const json = await response.json();
  return json && json.data ? json.data : json;
}

// ============================================================================
// Utility Functions
// ============================================================================

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
};

const formatNumber = (num: number): string => {
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(1)}M`;
  }
  if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}K`;
  }
  return num.toLocaleString();
};

const detectTableCategories = (tables: TableStatistic[]): TableCategory[] => {
  const patterns: { regex: RegExp; displayName: string; pattern: string }[] = [
    { regex: /^users?_/i, displayName: 'User Tables', pattern: 'users_*' },
    { regex: /^sensors?_/i, displayName: 'Sensor Tables', pattern: 'sensors_*' },
    { regex: /^farms?_/i, displayName: 'Farm Tables', pattern: 'farms_*' },
    { regex: /^batche?s?_/i, displayName: 'Batch Tables', pattern: 'batches_*' },
    { regex: /^audit_/i, displayName: 'Audit Tables', pattern: 'audit_*' },
    { regex: /^log_|_logs?$/i, displayName: 'Log Tables', pattern: '*_logs' },
    { regex: /^alert_|_alerts?$/i, displayName: 'Alert Tables', pattern: 'alerts_*' },
    { regex: /^config_|_config$/i, displayName: 'Config Tables', pattern: 'config_*' },
    { regex: /^tenant_/i, displayName: 'Tenant Tables', pattern: 'tenant_*' },
    { regex: /^_/i, displayName: 'System Tables', pattern: '_*' },
  ];

  const categoryMap = new Map<string, TableCategory>();
  const categorizedTables = new Set<string>();

  patterns.forEach(({ regex, displayName, pattern }) => {
    const matchingTables = tables.filter(
      (t) => regex.test(t.tableName) && !categorizedTables.has(t.tableName)
    );
    if (matchingTables.length > 0) {
      matchingTables.forEach((t) => categorizedTables.add(t.tableName));
      categoryMap.set(pattern, {
        pattern,
        displayName,
        count: matchingTables.length,
        tables: matchingTables.map((t) => t.tableName),
      });
    }
  });

  // Add uncategorized tables
  const uncategorized = tables.filter((t) => !categorizedTables.has(t.tableName));
  if (uncategorized.length > 0) {
    categoryMap.set('other', {
      pattern: 'other',
      displayName: 'Other Tables',
      count: uncategorized.length,
      tables: uncategorized.map((t) => t.tableName),
    });
  }

  return Array.from(categoryMap.values()).sort((a, b) => b.count - a.count);
};

// ============================================================================
// Sub-Components
// ============================================================================

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ReactNode;
  color: 'blue' | 'green' | 'purple' | 'yellow';
}

const StatCard: React.FC<StatCardProps> = ({ title, value, subtitle, icon, color }) => {
  const colorStyles = {
    blue: 'bg-blue-50 text-blue-600',
    green: 'bg-green-50 text-green-600',
    purple: 'bg-purple-50 text-purple-600',
    yellow: 'bg-yellow-50 text-yellow-600',
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-gray-500">{title}</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
          {subtitle && <p className="mt-1 text-xs text-gray-400">{subtitle}</p>}
        </div>
        <div className={`p-2 rounded-lg ${colorStyles[color]}`}>{icon}</div>
      </div>
    </div>
  );
};

interface PieChartProps {
  dataPercent: number;
  indexPercent: number;
  dataSizeFormatted: string;
  indexSizeFormatted: string;
}

const DataIndexPieChart: React.FC<PieChartProps> = ({
  dataPercent,
  indexPercent,
  dataSizeFormatted,
  indexSizeFormatted,
}) => {
  // CSS conic-gradient for pie chart
  const gradient = `conic-gradient(
    #3b82f6 0deg ${dataPercent * 3.6}deg,
    #10b981 ${dataPercent * 3.6}deg 360deg
  )`;

  return (
    <div className="flex items-center gap-6">
      <div
        className="w-24 h-24 rounded-full relative"
        style={{ background: gradient }}
        role="img"
        aria-label={`Data: ${dataPercent.toFixed(1)}%, Index: ${indexPercent.toFixed(1)}%`}
      >
        <div className="absolute inset-3 bg-white rounded-full flex items-center justify-center">
          <span className="text-xs font-medium text-gray-600">Ratio</span>
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-blue-500"></div>
          <span className="text-sm text-gray-600">
            Data: {dataSizeFormatted} ({dataPercent.toFixed(1)}%)
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-green-500"></div>
          <span className="text-sm text-gray-600">
            Index: {indexSizeFormatted} ({indexPercent.toFixed(1)}%)
          </span>
        </div>
      </div>
    </div>
  );
};

interface BarChartProps {
  tables: TableStatistic[];
}

const LargestTablesBarChart: React.FC<BarChartProps> = ({ tables }) => {
  const topTables = [...tables].sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 5);
  const maxSize = topTables[0]?.sizeBytes || 1;

  return (
    <div className="space-y-3">
      {topTables.map((table, index) => {
        const percentage = (table.sizeBytes / maxSize) * 100;
        const colors = [
          'bg-blue-500',
          'bg-blue-400',
          'bg-blue-300',
          'bg-blue-200',
          'bg-blue-100',
        ];

        return (
          <div key={table.tableName} className="group">
            <div className="flex items-center justify-between mb-1">
              <span
                className="text-sm font-medium text-gray-700 truncate max-w-[180px]"
                title={table.tableName}
              >
                {index + 1}. {table.tableName}
              </span>
              <span className="text-xs text-gray-500">{formatBytes(table.sizeBytes)}</span>
            </div>
            <div className="relative h-6 bg-gray-100 rounded-full overflow-hidden">
              <div
                className={`absolute inset-y-0 left-0 ${colors[index]} rounded-full transition-all duration-500 ease-out`}
                style={{ width: `${percentage}%` }}
              ></div>
              <div className="absolute inset-0 flex items-center justify-end pr-2">
                <span className="text-xs text-gray-600 font-medium">
                  {formatNumber(table.rowCount)} rows
                </span>
              </div>
            </div>
          </div>
        );
      })}
      {topTables.length === 0 && (
        <p className="text-sm text-gray-500 text-center py-4">No tables found</p>
      )}
    </div>
  );
};

interface CategoryListProps {
  categories: TableCategory[];
}

const TableCategoriesList: React.FC<CategoryListProps> = ({ categories }) => {
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

  const categoryColors: Record<string, string> = {
    'users_*': 'bg-blue-100 text-blue-700',
    'sensors_*': 'bg-green-100 text-green-700',
    'farms_*': 'bg-yellow-100 text-yellow-700',
    'batches_*': 'bg-purple-100 text-purple-700',
    'audit_*': 'bg-red-100 text-red-700',
    '*_logs': 'bg-orange-100 text-orange-700',
    'alerts_*': 'bg-pink-100 text-pink-700',
    'config_*': 'bg-indigo-100 text-indigo-700',
    'tenant_*': 'bg-cyan-100 text-cyan-700',
    '_*': 'bg-gray-100 text-gray-700',
    other: 'bg-slate-100 text-slate-700',
  };

  return (
    <div className="space-y-2">
      {categories.map((category) => (
        <div key={category.pattern} className="border border-gray-200 rounded-lg overflow-hidden">
          <button
            onClick={() =>
              setExpandedCategory(expandedCategory === category.pattern ? null : category.pattern)
            }
            className="w-full flex items-center justify-between p-3 hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <span
                className={`px-2 py-1 text-xs font-medium rounded ${
                  categoryColors[category.pattern] || 'bg-gray-100 text-gray-700'
                }`}
              >
                {category.count}
              </span>
              <span className="text-sm font-medium text-gray-700">{category.displayName}</span>
            </div>
            <svg
              className={`w-4 h-4 text-gray-400 transition-transform ${
                expandedCategory === category.pattern ? 'rotate-180' : ''
              }`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {expandedCategory === category.pattern && (
            <div className="px-3 pb-3 pt-1 bg-gray-50">
              <div className="flex flex-wrap gap-1">
                {category.tables.map((tableName) => (
                  <span
                    key={tableName}
                    className="px-2 py-0.5 text-xs bg-white border border-gray-200 rounded text-gray-600"
                  >
                    {tableName}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
      {categories.length === 0 && (
        <p className="text-sm text-gray-500 text-center py-4">No categories detected</p>
      )}
    </div>
  );
};

// ============================================================================
// Loading Skeleton
// ============================================================================

const LoadingSkeleton: React.FC = () => (
  <div className="animate-pulse space-y-6">
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="bg-white rounded-lg border border-gray-200 p-4 h-24">
          <div className="h-4 bg-gray-200 rounded w-1/2 mb-2"></div>
          <div className="h-6 bg-gray-200 rounded w-3/4"></div>
        </div>
      ))}
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="bg-white rounded-lg border border-gray-200 p-4 h-48">
        <div className="h-4 bg-gray-200 rounded w-1/3 mb-4"></div>
        <div className="h-24 bg-gray-200 rounded"></div>
      </div>
      <div className="bg-white rounded-lg border border-gray-200 p-4 h-48">
        <div className="h-4 bg-gray-200 rounded w-1/3 mb-4"></div>
        <div className="h-24 bg-gray-200 rounded"></div>
      </div>
    </div>
  </div>
);

// ============================================================================
// Icons
// ============================================================================

const TableIcon: React.FC<{ className?: string }> = ({ className = 'w-5 h-5' }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
    />
  </svg>
);

const DatabaseIcon: React.FC<{ className?: string }> = ({ className = 'w-5 h-5' }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"
    />
  </svg>
);

const ChartBarIcon: React.FC<{ className?: string }> = ({ className = 'w-5 h-5' }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
    />
  </svg>
);

const DocumentIcon: React.FC<{ className?: string }> = ({ className = 'w-5 h-5' }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
    />
  </svg>
);

const ViewListIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M4 6h16M4 10h16M4 14h16M4 18h16"
    />
  </svg>
);

const TerminalIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
    />
  </svg>
);

const DownloadIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
    />
  </svg>
);

// ============================================================================
// Main Component
// ============================================================================

export const SchemaStatistics: React.FC<SchemaStatisticsProps> = ({ schema, schemaType }) => {
  const [statistics, setStatistics] = useState<SchemaStatisticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadStatistics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchSchemaStatistics(schema);
      setStatistics(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load schema statistics');
    } finally {
      setLoading(false);
    }
  }, [schema]);

  useEffect(() => {
    loadStatistics();
  }, [loadStatistics]);

  // Calculate derived values
  const totalSize = statistics?.totalSizeBytes || 0;
  const dataSize = statistics?.dataSizeBytes || 0;
  const indexSize = statistics?.indexSizeBytes || 0;
  const dataPercent = totalSize > 0 ? (dataSize / totalSize) * 100 : 0;
  const indexPercent = totalSize > 0 ? (indexSize / totalSize) * 100 : 0;

  const categories = statistics ? detectTableCategories(statistics.tables) : [];

  // Event handlers for quick actions
  const handleViewAllTables = () => {
    // Navigate to tables view - this would typically use router
    window.location.hash = `#/database/explorer?schema=${schema}`;
  };

  const handleRunQuery = () => {
    // Navigate to query runner - placeholder
    window.location.hash = `#/database/query?schema=${schema}`;
  };

  const handleExportSchema = () => {
    // Export schema - not yet implemented
    console.warn(`Export schema not yet implemented for schema: ${schema}`);
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Schema Statistics</h2>
            <p className="text-sm text-gray-500">{schema}</p>
          </div>
        </div>
        <LoadingSkeleton />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Schema Statistics</h2>
            <p className="text-sm text-gray-500">{schema}</p>
          </div>
        </div>
        <Alert type="error" dismissible onDismiss={() => setError(null)}>
          {error}
        </Alert>
        <Button onClick={loadStatistics} variant="outline">
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-gray-900">Schema Statistics</h2>
            <span
              className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                schemaType === 'system'
                  ? 'bg-purple-100 text-purple-700'
                  : 'bg-blue-100 text-blue-700'
              }`}
            >
              {schemaType}
            </span>
          </div>
          <p className="text-sm text-gray-500 font-mono">{schema}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={loadStatistics}>
          <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          Refresh
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Total Tables"
          value={statistics?.totalTables || 0}
          subtitle={`in ${schema}`}
          icon={<TableIcon />}
          color="blue"
        />
        <StatCard
          title="Total Size"
          value={formatBytes(totalSize)}
          subtitle="data + indexes"
          icon={<DatabaseIcon />}
          color="green"
        />
        <StatCard
          title="Total Rows"
          value={formatNumber(statistics?.totalRowsEstimate || 0)}
          subtitle="estimated"
          icon={<ChartBarIcon />}
          color="purple"
        />
        <StatCard
          title="Categories"
          value={categories.length}
          subtitle="table patterns"
          icon={<DocumentIcon />}
          color="yellow"
        />
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Data vs Index Size */}
        <Card title="Data vs Index Size" padding="md">
          <DataIndexPieChart
            dataPercent={dataPercent}
            indexPercent={indexPercent}
            dataSizeFormatted={formatBytes(dataSize)}
            indexSizeFormatted={formatBytes(indexSize)}
          />
        </Card>

        {/* Largest Tables */}
        <Card title="Largest Tables" subtitle="Top 5 by size" padding="md">
          <LargestTablesBarChart tables={statistics?.tables || []} />
        </Card>

        {/* Table Categories */}
        <Card title="Table Categories" subtitle="Grouped by naming pattern" padding="md">
          <TableCategoriesList categories={categories} />
        </Card>

        {/* Quick Actions */}
        <Card title="Quick Actions" padding="md">
          <div className="space-y-3">
            <Button
              variant="outline"
              fullWidth
              onClick={handleViewAllTables}
              leftIcon={<ViewListIcon />}
            >
              View All Tables
            </Button>
            <Button
              variant="outline"
              fullWidth
              onClick={handleRunQuery}
              leftIcon={<TerminalIcon />}
            >
              Run Query
            </Button>
            <Button
              variant="outline"
              fullWidth
              onClick={handleExportSchema}
              leftIcon={<DownloadIcon />}
            >
              Export Schema
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
};

export default SchemaStatistics;
