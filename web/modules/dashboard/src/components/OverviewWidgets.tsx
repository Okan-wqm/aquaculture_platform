/**
 * Overview Widgets Bileseni
 *
 * Dashboard ana sayfasinda gosterilen ozet widget'lari.
 * Gercek API verileri @tanstack/react-query + graphqlClient ile cekilir.
 */

import React, { useMemo } from 'react';
import { Card, Badge, formatNumber } from '@aquaculture/shared-ui';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  useTodaysTasks,
  useStorageOverview,
  useCriticalWaterQuality,
  useTaskStats,
} from '../hooks/useDashboardData';
import type {
  DashboardTask,
  LowStockAlert,
  WaterQualityMeasurement,
  TaskStats,
} from '../hooks/useDashboardData';

// ============================================================================
// Static Config (module-level for PERF-H4, PERF-M3)
// ============================================================================

const waterQualityLabels: Record<string, string> = {
  ph: 'pH',
  dissolvedOxygen: 'Oksijen',
  temperature: 'Sicaklik',
  salinity: 'Tuzluluk',
};

const waterQualityUnits: Record<string, string> = {
  ph: '',
  dissolvedOxygen: 'mg/L',
  temperature: '\u00B0C',
  salinity: 'ppt',
};

const waterQualityRanges: Record<string, { min: number; max: number }> = {
  ph: { min: 6.5, max: 8.5 },
  dissolvedOxygen: { min: 5.0, max: 12.0 },
  temperature: { min: 18.0, max: 28.0 },
  salinity: { min: 28.0, max: 36.0 },
};

// PERF-M1: Tooltip style hoisted to module scope to avoid new object on every render
const tooltipStyle = {
  backgroundColor: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
};

// ============================================================================
// Skeleton Components
// ============================================================================

const WidgetSkeleton: React.FC = () => (
  <Card className="p-4">
    <div className="animate-pulse">
      <div className="flex items-center justify-between mb-4">
        <div className="h-4 bg-gray-200 rounded w-1/3" />
        <div className="h-5 bg-gray-200 rounded-full w-16" />
      </div>
      <div className="space-y-3">
        <div className="h-3 bg-gray-200 rounded w-full" />
        <div className="h-3 bg-gray-200 rounded w-3/4" />
        <div className="h-3 bg-gray-200 rounded w-1/2" />
      </div>
    </div>
  </Card>
);

const ErrorWidget: React.FC<{ title: string; onRetry: () => void }> = ({ title, onRetry }) => (
  <Card className="p-4">
    <div className="text-center py-4">
      <h3 className="text-sm font-medium text-gray-500 mb-2">{title}</h3>
      <p className="text-xs text-red-500 mb-2">Veri yuklenemedi</p>
      <button
        type="button"
        onClick={onRetry}
        className="text-xs text-primary-600 font-medium hover:underline"
      >
        Tekrar Dene
      </button>
    </div>
  </Card>
);

const EmptyWidget: React.FC<{ title: string; message: string }> = ({ title, message }) => (
  <Card className="p-4">
    <div className="text-center py-4">
      <h3 className="text-sm font-medium text-gray-500 mb-2">{title}</h3>
      <p className="text-xs text-gray-500">{message}</p>
    </div>
  </Card>
);

// ============================================================================
// Task Stats Widget
// ============================================================================

interface TaskStatsWidgetProps {
  stats: TaskStats | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

const TaskStatsWidget: React.FC<TaskStatsWidgetProps> = ({ stats, isLoading, isError, refetch }) => {
  // Build simple chart data from stats.
  // Hook must run on every render (Rules of Hooks) — placed before the early
  // returns below; guarded against undefined `stats` (loading/empty states).
  const chartData = useMemo(
    () =>
      stats
        ? [
            { day: 'Tamamlanan', value: stats.completedToday },
            { day: 'Bekleyen', value: stats.totalToday - stats.completedToday },
            { day: 'Geciken', value: stats.overdueCount },
            { day: 'Yaklasan', value: stats.upcomingCount },
          ]
        : [],
    [stats],
  );

  if (isLoading) return <WidgetSkeleton />;
  if (isError) return <ErrorWidget title="Gorev Istatistikleri" onRetry={refetch} />;
  if (!stats) return <EmptyWidget title="Gorev Istatistikleri" message="Henuz gorev verisi yok" />;

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-medium text-gray-500">Gorev Ozeti</h3>
          <p className="text-2xl font-bold text-gray-900">
            {formatNumber(stats.totalToday)} gorev
          </p>
        </div>
        <Badge variant={stats.completionRate > 70 ? 'success' : stats.completionRate > 40 ? 'warning' : 'error'}>
          %{stats.completionRate.toFixed(0)} tamamlandı
        </Badge>
      </div>
      <ResponsiveContainer width="100%" height={80}>
        <LineChart data={chartData}>
          <XAxis dataKey="day" hide />
          <YAxis hide domain={['dataMin - 1', 'dataMax + 1']} />
          <Tooltip
            contentStyle={tooltipStyle}
            content={({ active, payload }) => {
              if (active && payload && payload.length) {
                return (
                  <div className="bg-white shadow-lg rounded-lg px-3 py-2 text-sm">
                    <p className="font-medium">{String(payload[0].payload.day)}</p>
                    <p className="text-primary-600">{payload[0].value} gorev</p>
                  </div>
                );
              }
              return null;
            }}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke="#0073e6"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: '#0073e6' }}
          />
        </LineChart>
      </ResponsiveContainer>
    </Card>
  );
};

// ============================================================================
// Water Quality Widget
// ============================================================================

interface WaterQualityWidgetProps {
  measurements: WaterQualityMeasurement[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

const WaterQualityWidget: React.FC<WaterQualityWidgetProps> = ({
  measurements,
  isLoading,
  isError,
  refetch,
}) => {
  // Derive aggregate water quality from measurements.
  // Hook must run on every render (Rules of Hooks) — placed before the early
  // returns below; returns null for the empty-measurements case.
  const waterData = useMemo(() => {
    if (measurements.length === 0) return null;

    // Average across all critical measurements
    const avg = (key: keyof WaterQualityMeasurement): number | null => {
      const values = measurements
        .map((m) => m[key])
        .filter((v): v is number => typeof v === 'number');
      if (values.length === 0) return null;
      return values.reduce((a, b) => a + b, 0) / values.length;
    };

    return {
      // salinity is not part of the criticalWaterQuality aggregate
      // (WaterQualityMeasurement has no salinity field) — omit it.
      ph: avg('pH'),
      dissolvedOxygen: avg('dissolvedOxygen'),
      temperature: avg('temperature'),
    };
  }, [measurements]);

  if (isLoading) return <WidgetSkeleton />;
  if (isError) return <ErrorWidget title="Su Kalitesi" onRetry={refetch} />;

  if (!waterData) {
    return <EmptyWidget title="Su Kalitesi" message="Kritik su kalitesi verisi yok" />;
  }

  const entries = Object.entries(waterData).filter(
    (entry): entry is [string, number] => entry[1] !== null,
  );

  const warningCount = entries.filter(([key, value]) => {
    const range = waterQualityRanges[key];
    if (!range) return false;
    return value < range.min || value > range.max;
  }).length;

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-gray-500">Su Kalitesi</h3>
        <Badge variant={warningCount > 0 ? 'warning' : 'success'}>
          {warningCount > 0 ? `${warningCount} Uyari` : 'Normal'}
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {entries.map(([key, value]) => {
          const range = waterQualityRanges[key];
          const isWarning = range ? (value < range.min || value > range.max) : false;
          const progress = range
            ? Math.max(0, Math.min(((value - range.min) / (range.max - range.min)) * 100, 100))
            : 50;

          return (
            <div key={key} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500">{waterQualityLabels[key] ?? key}</span>
                <span className={`font-medium ${isWarning ? 'text-yellow-600' : 'text-gray-900'}`}>
                  {value.toFixed(1)} {waterQualityUnits[key] ?? ''}
                </span>
              </div>
              <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    isWarning ? 'bg-yellow-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
};

// ============================================================================
// Tasks Widget
// ============================================================================

interface TasksWidgetProps {
  tasks: DashboardTask[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

const TasksWidget: React.FC<TasksWidgetProps> = ({ tasks, isLoading, isError, refetch }) => {
  if (isLoading) return <WidgetSkeleton />;
  if (isError) return <ErrorWidget title="Aktif Gorevler" onRetry={refetch} />;

  if (tasks.length === 0) {
    return <EmptyWidget title="Aktif Gorevler" message="Bugun icin gorev yok" />;
  }

  // Show first 3 tasks
  const displayTasks = tasks.slice(0, 3);

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-gray-500">Aktif Gorevler</h3>
        {/* BUG-M3: replaced <span> fake link with an accessible <button> */}
        <button
          type="button"
          className="text-xs text-primary-600 font-medium hover:underline"
          onClick={() => { /* TODO: navigate to /tasks */ }}
        >
          Tumunu Gor
        </button>
      </div>
      <div className="space-y-3">
        {displayTasks.map((task) => (
          <div key={task.id} className="flex items-center justify-between text-sm">
            <div className="flex items-center">
              <div
                className={`w-2 h-2 rounded-full mr-2 ${
                  task.status === 'COMPLETED'
                    ? 'bg-green-500'
                    : task.status === 'IN_PROGRESS'
                    ? 'bg-yellow-500'
                    : task.status === 'OVERDUE'
                    ? 'bg-red-500'
                    : 'bg-gray-300'
                }`}
              />
              <span className={task.status === 'COMPLETED' ? 'text-gray-500 line-through' : 'text-gray-700'}>
                {task.title}
              </span>
            </div>
            <span className="text-gray-500 text-xs">
              {task.dueTime ?? task.priority}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
};

// ============================================================================
// Stock Widget
// ============================================================================

interface StockWidgetProps {
  overview: {
    lowStockAlertCount: number;
    lowStockAlerts: LowStockAlert[];
  } | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

const StockWidget: React.FC<StockWidgetProps> = ({ overview, isLoading, isError, refetch }) => {
  if (isLoading) return <WidgetSkeleton />;
  if (isError) return <ErrorWidget title="Stok Durumu" onRetry={refetch} />;

  if (!overview || overview.lowStockAlerts.length === 0) {
    return <EmptyWidget title="Stok Durumu" message="Stok verisi yok veya tum stoklar yeterli" />;
  }

  const displayAlerts = overview.lowStockAlerts.slice(0, 3);

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-gray-500">Stok Durumu</h3>
        <Badge variant={overview.lowStockAlertCount > 0 ? 'error' : 'success'}>
          {overview.lowStockAlertCount > 0
            ? `${overview.lowStockAlertCount} Kritik`
            : 'Normal'}
        </Badge>
      </div>
      <div className="space-y-3">
        {displayAlerts.map((stock) => {
          const percentage = stock.minStock > 0
            ? (stock.currentQuantity / stock.minStock) * 100
            : 0;
          const isLow = percentage < 100;

          return (
            <div key={stock.itemId} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500">{stock.itemName}</span>
                <span className={`font-medium ${isLow ? 'text-red-600' : 'text-gray-900'}`}>
                  {stock.currentQuantity.toFixed(0)} / {stock.minStock.toFixed(0)} {stock.unit}
                </span>
              </div>
              <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    isLow ? 'bg-red-500' : percentage < 150 ? 'bg-yellow-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${Math.min(percentage, 100)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
};

// ============================================================================
// Overview Widgets
// ============================================================================

const OverviewWidgets: React.FC = () => {
  const taskStatsQuery = useTaskStats();
  const todaysTasksQuery = useTodaysTasks();
  const storageQuery = useStorageOverview();
  const waterQualityQuery = useCriticalWaterQuality();

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Gorev Istatistikleri -- Mini Chart */}
      <TaskStatsWidget
        stats={taskStatsQuery.data}
        isLoading={taskStatsQuery.isLoading}
        isError={taskStatsQuery.isError}
        refetch={taskStatsQuery.refetch}
      />

      {/* Su Kalitesi Ozeti */}
      <WaterQualityWidget
        measurements={waterQualityQuery.data ?? []}
        isLoading={waterQualityQuery.isLoading}
        isError={waterQualityQuery.isError}
        refetch={waterQualityQuery.refetch}
      />

      {/* Aktif Gorevler */}
      <TasksWidget
        tasks={todaysTasksQuery.data ?? []}
        isLoading={todaysTasksQuery.isLoading}
        isError={todaysTasksQuery.isError}
        refetch={todaysTasksQuery.refetch}
      />

      {/* Stok Durumu */}
      <StockWidget
        overview={storageQuery.data}
        isLoading={storageQuery.isLoading}
        isError={storageQuery.isError}
        refetch={storageQuery.refetch}
      />
    </div>
  );
};

// PERF-M4: React.memo prevents re-render when parent re-renders due to context changes
export default React.memo(OverviewWidgets);
