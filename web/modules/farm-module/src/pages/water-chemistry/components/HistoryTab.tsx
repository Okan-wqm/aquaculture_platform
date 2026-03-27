/**
 * Water Quality History Tab
 *
 * Shows historical water quality measurements with statistics,
 * trend charts (Recharts), and a paginated data table.
 *
 * Uses dynamic parameter configs when available, falling back to
 * hardcoded columns (Temp, DO, pH, NH3, NO2) for backward compatibility.
 */
import React, { useState, useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import {
  useWaterQualityList,
  useWaterQualityChart,
  useWaterQualityStatistics,
  getStatusColor,
  getStatusLabel,
  getSourceLabel,
  formatParameterValue,
  type WaterQualityFilters,
  type WaterQualityStatus,
  type WaterQualityMeasurement,
} from '../../../hooks/useWaterQuality';
import { useTanksList } from '../../../hooks/useTanks';
import { useParameterConfigList, type ParameterConfig } from '../../../hooks/useParameterConfigs';

// ============================================================================
// CONSTANTS
// ============================================================================

const PAGE_SIZE = 20;

const TIME_RANGE_OPTIONS: { label: string; days: number }[] = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'OPTIMAL', label: 'Optimal' },
  { value: 'WARNING', label: 'Warning' },
  { value: 'CRITICAL', label: 'Critical' },
];

// ============================================================================
// FALLBACK HARDCODED CONFIGS (used when dynamic configs are not yet loaded)
// ============================================================================

const FALLBACK_COLUMNS: ParameterConfig[] = [
  { id: 'fb-temp', code: 'temperature', name: 'Temp', unit: '\u00B0C', dataType: 'NUMBER', precision: 1, group: 'BASIC', optimalMin: null, optimalMax: null, warningMin: null, warningMax: null, criticalMin: null, criticalMax: null, speciesLimits: null, enumValues: null, chartColor: '#3b82f6', icon: null, displayOrder: 1, isVisible: true, isRequired: false, isActive: true, chartAxisGroup: 'left', isQuickAccess: false, templateSource: null, createdAt: '', updatedAt: '' },
  { id: 'fb-do', code: 'dissolvedOxygen', name: 'DO', unit: 'mg/L', dataType: 'NUMBER', precision: 1, group: 'BASIC', optimalMin: null, optimalMax: null, warningMin: null, warningMax: null, criticalMin: null, criticalMax: null, speciesLimits: null, enumValues: null, chartColor: '#22c55e', icon: null, displayOrder: 2, isVisible: true, isRequired: false, isActive: true, chartAxisGroup: 'left', isQuickAccess: false, templateSource: null, createdAt: '', updatedAt: '' },
  { id: 'fb-ph', code: 'pH', name: 'pH', unit: '', dataType: 'NUMBER', precision: 2, group: 'BASIC', optimalMin: null, optimalMax: null, warningMin: null, warningMax: null, criticalMin: null, criticalMax: null, speciesLimits: null, enumValues: null, chartColor: '#8b5cf6', icon: null, displayOrder: 3, isVisible: true, isRequired: false, isActive: true, chartAxisGroup: 'left', isQuickAccess: false, templateSource: null, createdAt: '', updatedAt: '' },
  { id: 'fb-nh3', code: 'ammonia', name: 'NH\u2083', unit: 'mg/L', dataType: 'NUMBER', precision: 3, group: 'NITROGEN_CYCLE', optimalMin: null, optimalMax: null, warningMin: null, warningMax: null, criticalMin: null, criticalMax: null, speciesLimits: null, enumValues: null, chartColor: '#ef4444', icon: null, displayOrder: 4, isVisible: true, isRequired: false, isActive: true, chartAxisGroup: 'right', isQuickAccess: false, templateSource: null, createdAt: '', updatedAt: '' },
  { id: 'fb-no2', code: 'nitrite', name: 'NO\u2082', unit: 'mg/L', dataType: 'NUMBER', precision: 3, group: 'NITROGEN_CYCLE', optimalMin: null, optimalMax: null, warningMin: null, warningMax: null, criticalMin: null, criticalMax: null, speciesLimits: null, enumValues: null, chartColor: '#f97316', icon: null, displayOrder: 5, isVisible: true, isRequired: false, isActive: true, chartAxisGroup: 'right', isQuickAccess: false, templateSource: null, createdAt: '', updatedAt: '' },
];

/** Maps parameter codes to the fixed statistics API fields */
const STAT_FIELD_MAP: Record<string, 'avgTemperature' | 'avgDO' | 'avgPH' | 'avgAmmonia' | 'avgNitrite'> = {
  temperature: 'avgTemperature',
  dissolvedOxygen: 'avgDO',
  pH: 'avgPH',
  ammonia: 'avgAmmonia',
  nitrite: 'avgNitrite',
};

// ============================================================================
// HELPERS
// ============================================================================

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

function formatShortDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

/**
 * Resolve a parameter value from a measurement, checking both the
 * top-level shorthand fields and the nested `parameters` JSONB.
 */
function resolveParameterValue(m: WaterQualityMeasurement, code: string): number | null {
  // Top-level shorthand fields
  const topLevel = m[code as keyof WaterQualityMeasurement];
  if (topLevel != null && typeof topLevel === 'number') return topLevel;

  // Nested parameters JSONB
  const params = m.parameters as Record<string, unknown> | undefined;
  if (params) {
    const nested = params[code];
    if (nested != null && typeof nested === 'number') return nested;
  }

  return null;
}

// ============================================================================
// COMPONENT
// ============================================================================

export const HistoryTab: React.FC = () => {
  // Filter state
  const [selectedTankId, setSelectedTankId] = useState('');
  const [days, setDays] = useState(30);
  const [customRange, setCustomRange] = useState(false);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);

  // Date calculation
  const fromDate = useMemo(() => {
    if (customRange && customFrom) return new Date(customFrom);
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d;
  }, [days, customRange, customFrom]);

  const toDate = useMemo(() => {
    if (customRange && customTo) return new Date(customTo);
    return new Date();
  }, [customRange, customTo]);

  // Data hooks
  const { data: tanksData } = useTanksList();
  const tanks = tanksData?.items ?? [];

  // Dynamic parameter configs with fallback
  const { data: paramConfigs } = useParameterConfigList({ isActive: true });
  const visibleConfigs = useMemo(() => {
    const configs = (paramConfigs ?? [])
      .filter((c: ParameterConfig) => c.isVisible && c.dataType === 'NUMBER')
      .sort((a: ParameterConfig, b: ParameterConfig) => a.displayOrder - b.displayOrder);
    return configs.length > 0 ? configs : FALLBACK_COLUMNS;
  }, [paramConfigs]);

  const statisticsQuery = useWaterQualityStatistics(
    selectedTankId || null,
    days,
  );

  const chartQuery = useWaterQualityChart(
    selectedTankId || null,
    selectedTankId ? fromDate : null,
    selectedTankId ? toDate : null,
  );

  const listFilters = useMemo<WaterQualityFilters>(() => ({
    tankId: selectedTankId || undefined,
    status: (statusFilter as WaterQualityStatus) || undefined,
    fromDate: fromDate.toISOString(),
    toDate: toDate.toISOString(),
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  }), [selectedTankId, statusFilter, fromDate, toDate, page]);

  const listQuery = useWaterQualityList(listFilters);

  // Tank name lookup
  const tankMap = useMemo(() => {
    const map: Record<string, string> = {};
    tanks.forEach((t) => { map[t.id] = t.name || t.code; });
    return map;
  }, [tanks]);

  // Chart data transformation - flatten parameters into top-level keys
  const chartData = useMemo(() => {
    if (!chartQuery.data || !Array.isArray(chartQuery.data)) return [];
    return chartQuery.data.map((m: WaterQualityMeasurement) => {
      const flat: Record<string, string | number | null> = {
        date: formatShortDate(m.measuredAt),
      };
      for (const config of visibleConfigs) {
        flat[config.code] = resolveParameterValue(m, config.code);
      }
      return flat;
    });
  }, [chartQuery.data, visibleConfigs]);

  // Build Y-axis labels from visible configs
  const leftAxisLabel = useMemo(() => {
    return visibleConfigs
      .filter((c: ParameterConfig) => c.chartAxisGroup !== 'right')
      .map((c: ParameterConfig) => `${c.name}${c.unit ? ` (${c.unit})` : ''}`)
      .join(' / ');
  }, [visibleConfigs]);

  const rightAxisLabel = useMemo(() => {
    return visibleConfigs
      .filter((c: ParameterConfig) => c.chartAxisGroup === 'right')
      .map((c: ParameterConfig) => `${c.name}${c.unit ? ` (${c.unit})` : ''}`)
      .join(' / ');
  }, [visibleConfigs]);

  const hasRightAxis = visibleConfigs.some((c: ParameterConfig) => c.chartAxisGroup === 'right');

  // Statistics card configs (visible params that have stat mappings, max 4)
  const statCards = useMemo(() => {
    return visibleConfigs
      .filter((c: ParameterConfig) => STAT_FIELD_MAP[c.code] != null)
      .slice(0, 4);
  }, [visibleConfigs]);

  // Pagination helpers
  const totalItems = listQuery.data?.total ?? 0;
  const currentPageStart = totalItems === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const currentPageEnd = Math.min(page * PAGE_SIZE, totalItems);
  const hasNextPage = listQuery.data?.hasNextPage ?? false;

  // Handlers
  const handleTankChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedTankId(e.target.value);
    setPage(1);
  };

  const handleTimeRange = (d: number) => {
    setDays(d);
    setCustomRange(false);
    setPage(1);
  };

  const handleStatusChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setStatusFilter(e.target.value);
    setPage(1);
  };

  // Statistics data
  const stats = statisticsQuery.data;

  return (
    <div className="space-y-6">
      {/* Filter Bar */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex flex-wrap items-center gap-4">
          {/* Tank Select */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Tank</label>
            <select
              value={selectedTankId}
              onChange={handleTankChange}
              className="block w-full min-w-[200px] rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            >
              <option value="">All Tanks</option>
              {tanks.map((t) => (
                <option key={t.id} value={t.id}>{t.name || t.code}</option>
              ))}
            </select>
          </div>

          {/* Time Range Buttons */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Time Range</label>
            <div className="flex items-center space-x-1">
              {TIME_RANGE_OPTIONS.map((opt) => (
                <button
                  key={opt.days}
                  onClick={() => handleTimeRange(opt.days)}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md border ${
                    !customRange && days === opt.days
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
              <button
                onClick={() => setCustomRange(true)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md border ${
                  customRange
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                }`}
              >
                Custom
              </button>
            </div>
          </div>

          {/* Custom Date Inputs */}
          {customRange && (
            <div className="flex items-center space-x-2">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">From</label>
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => { setCustomFrom(e.target.value); setPage(1); }}
                  className="rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">To</label>
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => { setCustomTo(e.target.value); setPage(1); }}
                  className="rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                />
              </div>
            </div>
          )}

          {/* Status Filter */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
            <select
              value={statusFilter}
              onChange={handleStatusChange}
              className="block w-full min-w-[140px] rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Statistics Cards */}
      {selectedTankId && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {statCards.map((config: ParameterConfig) => {
            const statField = STAT_FIELD_MAP[config.code];
            const statValue = statField && stats ? stats[statField] : null;
            return (
              <div key={config.code} className="bg-white rounded-lg shadow p-4">
                <p className="text-sm font-medium text-gray-500">
                  Avg {config.name}
                </p>
                <p className="text-2xl font-semibold text-gray-900">
                  {statValue != null
                    ? `${statValue.toFixed(config.precision)} ${config.unit}`
                    : '-'}
                </p>
              </div>
            );
          })}
          <div className="bg-white rounded-lg shadow p-4">
            <p className="text-sm font-medium text-gray-500">Measurements</p>
            <p className="text-2xl font-semibold text-gray-900">
              {stats?.measurementCount ?? 0}
            </p>
            <div className="flex items-center space-x-2 mt-1">
              {stats != null && stats.criticalCount > 0 && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                  {stats.criticalCount} critical
                </span>
              )}
              {stats != null && stats.warningCount > 0 && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                  {stats.warningCount} warning
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Trend Chart */}
      {selectedTankId && (
        <div className="bg-white rounded-lg shadow p-4">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Water Quality Trends</h3>
          {chartQuery.isLoading ? (
            <div className="flex items-center justify-center h-64">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
            </div>
          ) : chartData.length === 0 ? (
            <div className="flex items-center justify-center h-64 text-gray-500">
              No chart data available for the selected period.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={350}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis
                  yAxisId="left"
                  label={leftAxisLabel ? { value: leftAxisLabel, angle: -90, position: 'insideLeft', style: { fontSize: 11 } } : undefined}
                />
                {hasRightAxis && (
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    label={rightAxisLabel ? { value: rightAxisLabel, angle: 90, position: 'insideRight', style: { fontSize: 11 } } : undefined}
                  />
                )}
                <Tooltip />
                <Legend />
                {visibleConfigs.map((config: ParameterConfig) => (
                  <Line
                    key={config.code}
                    yAxisId={config.chartAxisGroup === 'right' ? 'right' : 'left'}
                    type="monotone"
                    dataKey={config.code}
                    name={`${config.name}${config.unit ? ` (${config.unit})` : ''}`}
                    stroke={config.chartColor}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      )}

      {/* Data Table */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        {listQuery.isLoading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
          </div>
        ) : listQuery.error ? (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 m-4">
            <p className="text-red-800">
              Failed to load measurements: {(listQuery.error as Error).message}
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tank</th>
                    {visibleConfigs.map((config: ParameterConfig) => (
                      <th key={config.code} className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                        {config.name} {config.unit ? `(${config.unit})` : ''}
                      </th>
                    ))}
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Source</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {listQuery.data?.items?.length === 0 && (
                    <tr>
                      <td colSpan={visibleConfigs.length + 4} className="px-4 py-12 text-center text-gray-500">
                        No water quality measurements found for the selected filters.
                      </td>
                    </tr>
                  )}
                  {listQuery.data?.items?.map((m) => (
                    <tr key={m.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                        {formatDate(m.measuredAt)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                        {m.tankId ? (tankMap[m.tankId] || m.tankId.slice(0, 8)) : '-'}
                      </td>
                      {visibleConfigs.map((config: ParameterConfig) => {
                        const val = resolveParameterValue(m, config.code);
                        return (
                          <td key={config.code} className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                            {val != null ? Number(val).toFixed(config.precision) : '-'}
                          </td>
                        );
                      })}
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(m.overallStatus)}`}>
                          {getStatusLabel(m.overallStatus)}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                        {getSourceLabel(m.source)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalItems > PAGE_SIZE && (
              <div className="bg-white px-4 py-3 flex items-center justify-between border-t border-gray-200">
                <div className="text-sm text-gray-700">
                  Showing {currentPageStart} to {currentPageEnd} of {totalItems} records
                </div>
                <div className="flex space-x-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="px-3 py-1 border border-gray-300 rounded-md text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => setPage((p) => p + 1)}
                    disabled={!hasNextPage}
                    className="px-3 py-1 border border-gray-300 rounded-md text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
