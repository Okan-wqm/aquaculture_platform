/**
 * BarChart — Chart.js-based bar chart for aggregated SCADA tag data.
 *
 * Queries historical data via useTrendData, applies DaqAggregation,
 * and renders as vertical or horizontal bars.  The chart is responsive
 * via the Chart.js built-in ResizeObserver integration.
 */

import React, { useEffect, useRef, useMemo } from 'react';
import {
  Chart,
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
  type ChartConfiguration,
  type ChartDataset,
} from 'chart.js';
import { useTrendData, type TrendTimeRange } from '../../hooks/useTrendData';
import type {
  ChartTimeRange,
  DaqAggregation,
  HistoricalDataPoint,
} from '../../types/scada-runtime.types';

/* ---- Register Chart.js tree-shaken modules ---- */
Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Compute a single aggregate value from a series of data points.
 * When a DaqAggregation is provided the points are pre-aggregated by
 * the backend; we reduce to a scalar for each bar.
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
/*  Props                                                               */
/* ------------------------------------------------------------------ */

export interface BarChartProps {
  /** Tag IDs whose values are fetched and rendered as bars. */
  tagIds: string[];
  /** Human-readable label for each bar (must align with tagIds). */
  labels: string[];
  orientation?: 'vertical' | 'horizontal';
  timeRange?: ChartTimeRange | { from: Date; to: Date };
  aggregation?: DaqAggregation;
  /** Bar fill colors. Cycles through defaults when not provided. */
  colors?: string[];
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

export const BarChart: React.FC<BarChartProps> = ({
  tagIds,
  labels,
  orientation = 'vertical',
  timeRange = 'last1h',
  aggregation = { function: 'avg', interval: '1h' },
  colors,
  className,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  // Resolve timeRange to TrendTimeRange
  const trendRange = useMemo<TrendTimeRange>(() => {
    if (typeof timeRange === 'object' && 'from' in timeRange) {
      return timeRange as { from: Date; to: Date };
    }
    return timeRange as ChartTimeRange;
  }, [timeRange]);

  const { data, isLoading, error } = useTrendData(tagIds, trendRange, {
    aggregation,
  });

  // Compute bar values whenever data changes
  const barValues = useMemo<number[]>(() => {
    return tagIds.map((id) => {
      const pts = data[id] ?? [];
      return aggregatePoints(pts, aggregation.function);
    });
  }, [data, tagIds, aggregation.function]);

  // Resolve colors
  const resolvedColors = useMemo<string[]>(() => {
    return tagIds.map((_, i) =>
      colors?.[i] ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length],
    );
  }, [tagIds, colors]);

  /* ---- Create Chart.js instance ---- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const isHorizontal = orientation === 'horizontal';
    const indexAxis: 'x' | 'y' = isHorizontal ? 'y' : 'x';

    const dataset: ChartDataset<'bar'> = {
      label: 'Value',
      data: barValues,
      backgroundColor: resolvedColors,
      borderColor: resolvedColors.map((c) => c + 'cc'),
      borderWidth: 1,
      borderRadius: 4,
    };

    const config: ChartConfiguration<'bar'> = {
      type: 'bar',
      data: {
        labels,
        datasets: [dataset],
      },
      options: {
        indexAxis,
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${ctx.formattedValue}`,
            },
          },
        },
        scales: {
          x: {
            grid: { color: 'rgba(0,0,0,0.06)' },
            ticks: { color: '#666' },
          },
          y: {
            grid: { color: 'rgba(0,0,0,0.06)' },
            ticks: { color: '#666' },
            beginAtZero: true,
          },
        },
        animation: { duration: 300 },
      },
    };

    chartRef.current = new Chart(canvas, config);

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
    // Recreate when orientation changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orientation, labels, resolvedColors]);

  /* ---- Update data without recreating ---- */

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    chart.data.datasets[0].data = barValues;
    chart.data.datasets[0].backgroundColor = resolvedColors;
    chart.data.datasets[0].borderColor = resolvedColors.map((c) => c + 'cc') as string[];
    chart.update('active');
  }, [barValues, resolvedColors]);

  /* ---- Render ---- */

  return (
    <div className={`relative flex flex-col w-full h-full ${className ?? ''}`}>
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/60 z-10">
          <span className="text-xs text-gray-500 animate-pulse">Loading…</span>
        </div>
      )}
      {error && (
        <div className="px-3 py-1 text-xs text-red-600 bg-red-50 border-b border-red-200">
          {error}
        </div>
      )}
      <div className="flex-1 min-h-0 relative">
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>
    </div>
  );
};
