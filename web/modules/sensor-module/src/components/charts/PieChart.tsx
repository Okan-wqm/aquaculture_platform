/**
 * PieChart — Chart.js-based pie chart showing live tag values.
 *
 * Each segment corresponds to one tag's current value from the
 * realtime data provider.  The chart updates automatically as
 * new values arrive (via useRealtimeData).
 *
 * Data labels use Chart.js plugin 'chartjs-plugin-datalabels' if
 * available, falling back to the built-in tooltip.
 */

import React, { useEffect, useRef, useMemo } from 'react';
import {
  Chart,
  PieController,
  ArcElement,
  Tooltip,
  Legend,
  type ChartConfiguration,
} from 'chart.js';
import { useRealtimeData } from '../../hooks/useRealtimeData';

/* ---- Register Chart.js tree-shaken modules ---- */
Chart.register(PieController, ArcElement, Tooltip, Legend);

/* ------------------------------------------------------------------ */
/*  Props                                                               */
/* ------------------------------------------------------------------ */

export interface PieSegmentConfig {
  /** Tag to read the live value from. */
  tagId: string;
  /** Display name for the segment. */
  label: string;
  /** CSS colour string. */
  color: string;
}

export interface PieChartProps {
  segments: PieSegmentConfig[];
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

export const PieChart: React.FC<PieChartProps> = ({ segments, className }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart<'pie'> | null>(null);

  const tagIds = useMemo(() => segments.map((s) => s.tagId), [segments]);
  const { values, isConnected } = useRealtimeData(tagIds);

  /* ---- Derive numeric segment values ---- */

  const segmentValues = useMemo<number[]>(() => {
    return segments.map((seg) => {
      const change = values[seg.tagId];
      if (!change) return 0;
      const v =
        typeof change.value === 'number'
          ? change.value
          : parseFloat(String(change.value));
      return isNaN(v) || v < 0 ? 0 : v;
    });
  }, [values, segments]);

  const totalValue = useMemo(
    () => segmentValues.reduce((a, b) => a + b, 0),
    [segmentValues],
  );

  /* ---- Create Chart.js instance ---- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const colors = segments.map((s) => s.color);
    const labels = segments.map((s) => s.label);

    const config: ChartConfiguration<'pie'> = {
      type: 'pie',
      data: {
        labels,
        datasets: [
          {
            data: segmentValues,
            backgroundColor: colors,
            borderColor: '#fff',
            borderWidth: 2,
            hoverOffset: 6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              padding: 12,
              usePointStyle: true,
              pointStyleWidth: 10,
              font: { size: 12 },
            },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const val = ctx.parsed;
                const pct = totalValue > 0
                  ? ((val / totalValue) * 100).toFixed(1)
                  : '0.0';
                return ` ${ctx.label}: ${val.toFixed(2)} (${pct}%)`;
              },
            },
          },
        },
        animation: { duration: 200 },
      },
    };

    chartRef.current = new Chart(canvas, config);

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
    // Recreate only when segment config (labels / colors) changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments]);

  /* ---- Update data live ---- */

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    chart.data.datasets[0].data = segmentValues;
    chart.update('active');
  }, [segmentValues]);

  /* ---- Render ---- */

  const allZero = totalValue === 0;

  return (
    <div className={`relative flex flex-col w-full h-full ${className ?? ''}`}>
      {!isConnected && (
        <div className="px-2 py-0.5 text-xs text-amber-600 bg-amber-50 border-b border-amber-200">
          Disconnected — showing last known values
        </div>
      )}

      {allZero && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <span className="text-xs text-gray-400">No data</span>
        </div>
      )}

      <div className="flex-1 min-h-0 relative">
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>

      {/* Inline value labels below chart */}
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 px-2 pb-1 mt-1">
        {segments.map((seg, i) => (
          <span key={seg.tagId} className="flex items-center gap-1 text-xs text-gray-700">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: seg.color }}
            />
            <span className="font-medium">{seg.label}:</span>
            <span className="font-mono">
              {segmentValues[i] != null ? segmentValues[i].toFixed(2) : '—'}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
};
