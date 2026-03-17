/**
 * BarChart -- Recharts-based bar chart for aggregated SCADA tag data.
 *
 * Queries historical data via useTrendData, applies DaqAggregation,
 * and renders as vertical or horizontal bars with optional stacking.
 * Responsive via Recharts ResponsiveContainer.
 *
 * Theme-aware: adapts grid/axis colours based on a `theme` prop.
 */

import React, { useMemo } from 'react';
import {
  BarChart as RechartsBarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { useTrendData, type TrendTimeRange } from '../../hooks/useTrendData';
import type {
  ChartTimeRange,
  DaqAggregation,
  HistoricalDataPoint,
} from '../../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_COLORS = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#06b6d4',
  '#f97316',
  '#84cc16',
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Compute a single aggregate value from a series of data points.
 */
function aggregatePoints(
  points: HistoricalDataPoint[],
  fn: DaqAggregation['function'],
): number {
  const nums = points
    .map((p) => (typeof p.value === 'number' ? p.value : parseFloat(String(p.value))))
    .filter((v) => !isNaN(v));

  if (nums.length === 0) return 0;

  switch (fn) {
    case 'min':
      return Math.min(...nums);
    case 'max':
      return Math.max(...nums);
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'avg':
    default:
      return nums.reduce((a, b) => a + b, 0) / nums.length;
  }
}

/* ------------------------------------------------------------------ */
/*  Theme helpers                                                       */
/* ------------------------------------------------------------------ */

interface ThemeColors {
  gridColor: string;
  axisColor: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
}

function getThemeColors(theme: 'light' | 'dark'): ThemeColors {
  if (theme === 'dark') {
    return {
      gridColor: 'rgba(255,255,255,0.1)',
      axisColor: '#9ca3af',
      tooltipBg: '#1f2937',
      tooltipBorder: '#374151',
      tooltipText: '#f3f4f6',
    };
  }
  return {
    gridColor: 'rgba(0,0,0,0.06)',
    axisColor: '#6b7280',
    tooltipBg: '#ffffff',
    tooltipBorder: '#e5e7eb',
    tooltipText: '#374151',
  };
}

/* ------------------------------------------------------------------ */
/*  Props                                                               */
/* ------------------------------------------------------------------ */

export interface BarChartSeries {
  tagId: string;
  label: string;
  color?: string;
}

export interface BarChartProps {
  /** Data series definitions. Each series becomes a bar group. */
  series: BarChartSeries[];
  /** Bar orientation. Default: 'vertical'. */
  orientation?: 'vertical' | 'horizontal';
  /** Stack bars on top of each other. Default: false. */
  stacked?: boolean;
  /** Time range for data query. Default: 'last1h'. */
  timeRange?: ChartTimeRange | { from: Date; to: Date };
  /** Aggregation applied to historical data. */
  aggregation?: DaqAggregation;
  /** Color theme. Default: 'light'. */
  theme?: 'light' | 'dark';
  /** Show legend. Default: true. */
  showLegend?: boolean;
  /** Show grid lines. Default: true. */
  showGrid?: boolean;
  /** Additional CSS class. */
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

export const BarChart: React.FC<BarChartProps> = ({
  series,
  orientation = 'vertical',
  stacked = false,
  timeRange = 'last1h',
  aggregation = { function: 'avg', interval: '1h' },
  theme = 'light',
  showLegend = true,
  showGrid = true,
  className,
}) => {
  const tagIds = useMemo(() => series.map((s) => s.tagId), [series]);

  const trendRange = useMemo<TrendTimeRange>(() => {
    if (typeof timeRange === 'object' && 'from' in timeRange) {
      return timeRange as { from: Date; to: Date };
    }
    return timeRange as ChartTimeRange;
  }, [timeRange]);

  const { data, isLoading, error } = useTrendData(tagIds, trendRange, {
    aggregation,
  });

  const colors = getThemeColors(theme);

  /** Resolve bar colors, falling back to defaults. */
  const resolvedColors = useMemo<string[]>(
    () =>
      series.map(
        (s, i) => s.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length],
      ),
    [series],
  );

  /** Build the flat recharts data array. */
  const chartData = useMemo(() => {
    // Single-row summary: each series aggregated to one value
    const row: Record<string, string | number> = { name: 'Value' };
    series.forEach((s) => {
      const pts = data[s.tagId] ?? [];
      row[s.label] = aggregatePoints(pts, aggregation.function);
    });
    return [row];
  }, [data, series, aggregation.function]);

  const isHorizontal = orientation === 'horizontal';
  const stackId = stacked ? 'stack' : undefined;

  return (
    <div className={`relative flex flex-col w-full h-full ${className ?? ''}`}>
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/60 dark:bg-gray-900/60 z-10">
          <span className="text-xs text-gray-500 animate-pulse">Loading...</span>
        </div>
      )}
      {error && (
        <div className="px-3 py-1 text-xs text-red-600 bg-red-50 border-b border-red-200">
          {error}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <RechartsBarChart
            data={chartData}
            layout={isHorizontal ? 'vertical' : 'horizontal'}
            margin={{ top: 8, right: 12, left: 0, bottom: 4 }}
          >
            {showGrid && (
              <CartesianGrid
                strokeDasharray="3 3"
                stroke={colors.gridColor}
                vertical={!isHorizontal}
                horizontal={isHorizontal || true}
              />
            )}
            {isHorizontal ? (
              <>
                <XAxis
                  type="number"
                  tick={{ fontSize: 11, fill: colors.axisColor }}
                  axisLine={{ stroke: colors.gridColor }}
                  tickLine={{ stroke: colors.gridColor }}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fontSize: 11, fill: colors.axisColor }}
                  axisLine={{ stroke: colors.gridColor }}
                  tickLine={{ stroke: colors.gridColor }}
                  width={60}
                />
              </>
            ) : (
              <>
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 11, fill: colors.axisColor }}
                  axisLine={{ stroke: colors.gridColor }}
                  tickLine={{ stroke: colors.gridColor }}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: colors.axisColor }}
                  axisLine={{ stroke: colors.gridColor }}
                  tickLine={{ stroke: colors.gridColor }}
                  width={50}
                />
              </>
            )}
            <Tooltip
              contentStyle={{
                backgroundColor: colors.tooltipBg,
                border: `1px solid ${colors.tooltipBorder}`,
                borderRadius: '6px',
                fontSize: '12px',
                color: colors.tooltipText,
              }}
              cursor={{ fill: 'rgba(14, 165, 233, 0.08)' }}
            />
            {showLegend && series.length > 1 && (
              <Legend
                wrapperStyle={{ fontSize: '11px' }}
                iconType="rect"
                iconSize={10}
              />
            )}
            {series.map((s, i) => (
              <Bar
                key={s.tagId}
                dataKey={s.label}
                fill={resolvedColors[i]}
                stackId={stackId}
                radius={stacked ? 0 : [4, 4, 0, 0]}
                maxBarSize={40}
              />
            ))}
          </RechartsBarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
