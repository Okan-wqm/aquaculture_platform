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
  useWaterQualityChartBySystem,
  useWaterQualityStatisticsBySystem,
  getStatusColor,
  getStatusLabel,
  getSourceLabel,
  formatParameterValue,
  type WaterQualityFilters,
  type WaterQualityStatus,
  type WaterQualityMeasurement,
} from '../../../hooks/useWaterQuality';
import { useTanksList } from '../../../hooks/useTanks';
import { useSystemList } from '../../../hooks/useSystems';
import { useParameterConfigList, type ParameterConfig } from '../../../hooks/useParameterConfigs';
import {
  Button,
  colors,
  DataTable,
  Input,
  Select,
  Spinner,
  ToggleButton,
  type DataTableColumn,
} from '@aquaculture/shared-ui';

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
  {
    id: 'fb-temp',
    code: 'temperature',
    name: 'Temp',
    unit: '\u00B0C',
    dataType: 'NUMBER',
    precision: 1,
    group: 'BASIC',
    optimalMin: null,
    optimalMax: null,
    warningMin: null,
    warningMax: null,
    criticalMin: null,
    criticalMax: null,
    speciesLimits: null,
    enumValues: null,
    chartColor: colors.info[500],
    icon: null,
    displayOrder: 1,
    isVisible: true,
    isRequired: false,
    isActive: true,
    chartAxisGroup: 'left',
    isQuickAccess: false,
    templateSource: null,
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'fb-do',
    code: 'dissolvedOxygen',
    name: 'DO',
    unit: 'mg/L',
    dataType: 'NUMBER',
    precision: 1,
    group: 'BASIC',
    optimalMin: null,
    optimalMax: null,
    warningMin: null,
    warningMax: null,
    criticalMin: null,
    criticalMax: null,
    speciesLimits: null,
    enumValues: null,
    chartColor: colors.success[500],
    icon: null,
    displayOrder: 2,
    isVisible: true,
    isRequired: false,
    isActive: true,
    chartAxisGroup: 'left',
    isQuickAccess: false,
    templateSource: null,
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'fb-ph',
    code: 'pH',
    name: 'pH',
    unit: '',
    dataType: 'NUMBER',
    precision: 2,
    group: 'BASIC',
    optimalMin: null,
    optimalMax: null,
    warningMin: null,
    warningMax: null,
    criticalMin: null,
    criticalMax: null,
    speciesLimits: null,
    enumValues: null,
    chartColor: colors.primary[700],
    icon: null,
    displayOrder: 3,
    isVisible: true,
    isRequired: false,
    isActive: true,
    chartAxisGroup: 'left',
    isQuickAccess: false,
    templateSource: null,
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'fb-nh3',
    code: 'ammonia',
    name: 'NH\u2083',
    unit: 'mg/L',
    dataType: 'NUMBER',
    precision: 3,
    group: 'NITROGEN_CYCLE',
    optimalMin: null,
    optimalMax: null,
    warningMin: null,
    warningMax: null,
    criticalMin: null,
    criticalMax: null,
    speciesLimits: null,
    enumValues: null,
    chartColor: colors.error[500],
    icon: null,
    displayOrder: 4,
    isVisible: true,
    isRequired: false,
    isActive: true,
    chartAxisGroup: 'right',
    isQuickAccess: false,
    templateSource: null,
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'fb-no2',
    code: 'nitrite',
    name: 'NO\u2082',
    unit: 'mg/L',
    dataType: 'NUMBER',
    precision: 3,
    group: 'NITROGEN_CYCLE',
    optimalMin: null,
    optimalMax: null,
    warningMin: null,
    warningMax: null,
    criticalMin: null,
    criticalMax: null,
    speciesLimits: null,
    enumValues: null,
    chartColor: colors.accent[600],
    icon: null,
    displayOrder: 5,
    isVisible: true,
    isRequired: false,
    isActive: true,
    chartAxisGroup: 'right',
    isQuickAccess: false,
    templateSource: null,
    createdAt: '',
    updatedAt: '',
  },
];

/** Maps parameter codes to the fixed statistics API fields */
const STAT_FIELD_MAP: Record<
  string,
  'avgTemperature' | 'avgDO' | 'avgPH' | 'avgAmmonia' | 'avgNitrite'
> = {
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
  // View mode: individual tank or aggregate system
  const [viewMode, setViewMode] = useState<'tank' | 'system'>('tank');
  const [selectedTankId, setSelectedTankId] = useState('');
  const [selectedSystemId, setSelectedSystemId] = useState('');
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
  const { data: systemsData } = useSystemList();
  const systems = systemsData?.items ?? [];

  // Active selection depends on view mode
  const activeId = viewMode === 'tank' ? selectedTankId : selectedSystemId;

  // Dynamic parameter configs with fallback
  const { data: paramConfigs } = useParameterConfigList({ isActive: true });
  const visibleConfigs = useMemo(() => {
    const configs = (paramConfigs ?? [])
      .filter((c: ParameterConfig) => c.isVisible && c.dataType === 'NUMBER')
      .sort((a: ParameterConfig, b: ParameterConfig) => a.displayOrder - b.displayOrder);
    return configs.length > 0 ? configs : FALLBACK_COLUMNS;
  }, [paramConfigs]);

  // Tank-level hooks (only active in tank mode)
  const tankStatsQuery = useWaterQualityStatistics(
    viewMode === 'tank' ? selectedTankId || null : null,
    days,
  );
  const tankChartQuery = useWaterQualityChart(
    viewMode === 'tank' ? selectedTankId || null : null,
    viewMode === 'tank' && selectedTankId ? fromDate : null,
    viewMode === 'tank' && selectedTankId ? toDate : null,
  );

  // System-level hooks (only active in system mode)
  const systemStatsQuery = useWaterQualityStatisticsBySystem(
    viewMode === 'system' ? selectedSystemId || null : null,
    days,
  );
  const systemChartQuery = useWaterQualityChartBySystem(
    viewMode === 'system' ? selectedSystemId || null : null,
    viewMode === 'system' && selectedSystemId ? fromDate : null,
    viewMode === 'system' && selectedSystemId ? toDate : null,
  );

  // Unified references for the rest of the component
  const statisticsQuery = viewMode === 'tank' ? tankStatsQuery : systemStatsQuery;
  const chartQuery = viewMode === 'tank' ? tankChartQuery : systemChartQuery;

  const listFilters = useMemo<WaterQualityFilters>(
    () => ({
      ...(viewMode === 'tank'
        ? { tankId: selectedTankId || undefined }
        : { systemId: selectedSystemId || undefined }),
      status: (statusFilter as WaterQualityStatus) || undefined,
      fromDate: fromDate.toISOString(),
      toDate: toDate.toISOString(),
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    [viewMode, selectedTankId, selectedSystemId, statusFilter, fromDate, toDate, page],
  );

  const listQuery = useWaterQualityList(listFilters);

  // Tank name lookup
  const tankMap = useMemo(() => {
    const map: Record<string, string> = {};
    tanks.forEach((t) => {
      map[t.id] = t.name || t.code;
    });
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

  // The parameter columns come from the visible configs; the rest are fixed.
  type MeasurementRow = NonNullable<NonNullable<typeof listQuery.data>['items']>[number];
  const historyColumns: DataTableColumn<MeasurementRow>[] = [
    {
      key: 'measuredAt',
      header: 'Date',
      render: (_value, m) => (
        <span className="whitespace-nowrap text-gray-900 dark:text-gray-100">
          {formatDate(m.measuredAt)}
        </span>
      ),
    },
    {
      key: 'tankId',
      header: 'Tank',
      render: (_value, m) => (
        <span className="whitespace-nowrap text-gray-900 dark:text-gray-100">
          {m.tankId ? tankMap[m.tankId] || m.tankId.slice(0, 8) : '-'}
        </span>
      ),
    },
    ...visibleConfigs.map(
      (config: ParameterConfig): DataTableColumn<MeasurementRow> => ({
        key: config.code,
        header: `${config.name} ${config.unit ? `(${config.unit})` : ''}`.trim(),
        align: 'right',
        render: (_value, m) => {
          const val = resolveParameterValue(m, config.code);
          return (
            <span className="whitespace-nowrap text-gray-900 dark:text-gray-100">
              {val != null ? Number(val).toFixed(config.precision) : '-'}
            </span>
          );
        },
      }),
    ),
    {
      key: 'overallStatus',
      header: 'Status',
      render: (_value, m) => (
        <span
          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(m.overallStatus)}`}
        >
          {getStatusLabel(m.overallStatus)}
        </span>
      ),
    },
    {
      key: 'source',
      header: 'Source',
      render: (_value, m) => (
        <span className="whitespace-nowrap text-gray-500 dark:text-gray-400">
          {getSourceLabel(m.source)}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Filter Bar */}
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
        <div className="flex flex-wrap items-center gap-4">
          {/* View Mode Toggle */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              View
            </label>
            <div className="flex rounded-md shadow-sm">
              <ToggleButton
                onClick={() => {
                  setViewMode('tank');
                  setSelectedSystemId('');
                }}
                pressed={viewMode === 'tank'}
                className="px-3 py-2 text-sm font-medium rounded-l-md border"
                pressedClassName="bg-info-600 text-white border-info-600"
                idleClassName="bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                Tank
              </ToggleButton>
              <ToggleButton
                onClick={() => {
                  setViewMode('system');
                  setSelectedTankId('');
                }}
                pressed={viewMode === 'system'}
                className="px-3 py-2 text-sm font-medium rounded-r-md border-t border-b border-r"
                pressedClassName="bg-info-600 text-white border-info-600"
                idleClassName="bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                System
              </ToggleButton>
            </div>
          </div>

          {/* Tank / System Select */}
          <div>
            {viewMode === 'tank' ? (
              <Select
                label="Tank"
                value={selectedTankId}
                onChange={handleTankChange}
                className="min-w-[200px]"
                options={[
                  { value: '', label: 'All Tanks' },
                  ...tanks.map((t) => ({ value: t.id, label: t.name || t.code })),
                ]}
              />
            ) : (
              <Select
                label="System"
                value={selectedSystemId}
                onChange={(e) => {
                  setSelectedSystemId(e.target.value);
                  setPage(1);
                }}
                className="min-w-[200px]"
                options={[
                  { value: '', label: 'Select System...' },
                  ...systems.map(
                    (s: { id: string; name: string; code?: string; type?: string }) => ({
                      value: s.id,
                      label: `${s.name}${s.type ? ` (${s.type})` : ''}`,
                    }),
                  ),
                ]}
              />
            )}
          </div>

          {/* Time Range Buttons */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Time Range
            </label>
            <div className="flex items-center space-x-1">
              {TIME_RANGE_OPTIONS.map((opt) => (
                <ToggleButton
                  key={opt.days}
                  onClick={() => handleTimeRange(opt.days)}
                  pressed={!customRange && days === opt.days}
                  className="px-3 py-1.5 text-sm font-medium rounded-md border"
                  pressedClassName="bg-info-600 text-white border-info-600"
                  idleClassName="bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  {opt.label}
                </ToggleButton>
              ))}
              <ToggleButton
                onClick={() => setCustomRange(true)}
                pressed={customRange}
                className="px-3 py-1.5 text-sm font-medium rounded-md border"
                pressedClassName="bg-info-600 text-white border-info-600"
                idleClassName="bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                Custom
              </ToggleButton>
            </div>
          </div>

          {/* Custom Date Inputs */}
          {customRange && (
            <div className="flex items-center space-x-2">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  From
                </label>
                <Input
                  type="date"
                  value={customFrom}
                  onChange={(e) => {
                    setCustomFrom(e.target.value);
                    setPage(1);
                  }}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  To
                </label>
                <Input
                  type="date"
                  value={customTo}
                  onChange={(e) => {
                    setCustomTo(e.target.value);
                    setPage(1);
                  }}
                />
              </div>
            </div>
          )}

          {/* Status Filter */}
          <div>
            <Select
              label="Status"
              value={statusFilter}
              onChange={handleStatusChange}
              className="min-w-[140px]"
              options={STATUS_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
            />
          </div>
        </div>
      </div>

      {/* Statistics Cards */}
      {activeId && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {statCards.map((config: ParameterConfig) => {
            const statField = STAT_FIELD_MAP[config.code];
            const statValue = statField && stats ? stats[statField] : null;
            return (
              <div key={config.code} className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
                <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
                  Avg {config.name}
                </p>
                <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                  {statValue != null
                    ? `${statValue.toFixed(config.precision)} ${config.unit}`
                    : '-'}
                </p>
              </div>
            );
          })}
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Measurements</p>
            <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
              {stats?.measurementCount ?? 0}
            </p>
            <div className="flex items-center space-x-2 mt-1">
              {stats != null && stats.criticalCount > 0 && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200">
                  {stats.criticalCount} critical
                </span>
              )}
              {stats != null && stats.warningCount > 0 && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200">
                  {stats.warningCount} warning
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Trend Chart */}
      {activeId && (
        <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
            Water Quality Trends
          </h3>
          {chartQuery.isLoading ? (
            <div className="flex items-center justify-center h-64">
              <Spinner size="xl" />
            </div>
          ) : chartData.length === 0 ? (
            <div className="flex items-center justify-center h-64 text-gray-500 dark:text-gray-400">
              No chart data available for the selected period.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={350}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis
                  yAxisId="left"
                  label={
                    leftAxisLabel
                      ? {
                          value: leftAxisLabel,
                          angle: -90,
                          position: 'insideLeft',
                          style: { fontSize: 11 },
                        }
                      : undefined
                  }
                />
                {hasRightAxis && (
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    label={
                      rightAxisLabel
                        ? {
                            value: rightAxisLabel,
                            angle: 90,
                            position: 'insideRight',
                            style: { fontSize: 11 },
                          }
                        : undefined
                    }
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
      <div className="bg-white dark:bg-gray-900 shadow rounded-lg overflow-hidden">
        {listQuery.isLoading ? (
          <div className="flex items-center justify-center h-64">
            <Spinner size="xl" />
          </div>
        ) : listQuery.error ? (
          <div className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg p-4 m-4">
            <p className="text-error-800 dark:text-error-200">
              Failed to load measurements: {(listQuery.error as Error).message}
            </p>
          </div>
        ) : (
          <>
            <DataTable<MeasurementRow>
              data={listQuery.data?.items ?? []}
              columns={historyColumns}
              keyExtractor={(m) => m.id}
              emptyMessage="No water quality measurements found for the selected filters."
              searchable={false}
              sortable={false}
              stickyHeader={false}
            />

            {/* Pagination */}
            {totalItems > PAGE_SIZE && (
              <div className="bg-white dark:bg-gray-900 px-4 py-3 flex items-center justify-between border-t border-gray-200 dark:border-gray-700">
                <div className="text-sm text-gray-700 dark:text-gray-300">
                  Showing {currentPageStart} to {currentPageEnd} of {totalItems} records
                </div>
                <div className="flex space-x-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPage((p) => p + 1)}
                    disabled={!hasNextPage}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
