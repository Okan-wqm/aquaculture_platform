/**
 * PieChart -- Recharts-based pie / doughnut chart showing live tag values.
 *
 * Each segment corresponds to one tag's current value from the
 * realtime data provider. The chart updates automatically as
 * new values arrive (via useRealtimeData).
 *
 * Supports a `doughnut` mode toggle that renders as a ring chart.
 * Theme-aware (dark/light).
 */

import React, { useMemo, useCallback } from 'react';
import {
  PieChart as RechartsPieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { useRealtimeData } from '../../hooks/useRealtimeData';

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
  /** Segment definitions. Each segment maps to a tag value. */
  segments: PieSegmentConfig[];
  /** Render as a doughnut (ring) chart. Default: false. */
  doughnut?: boolean;
  /** Show legend below the chart. Default: true. */
  showLegend?: boolean;
  /** Show inline value labels. Default: true. */
  showLabels?: boolean;
  /** Color theme. Default: 'light'. */
  theme?: 'light' | 'dark';
  /** Additional CSS class. */
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Theme helpers                                                       */
/* ------------------------------------------------------------------ */

function getThemeColors(theme: 'light' | 'dark') {
  if (theme === 'dark') {
    return {
      tooltipBg: '#1f2937',
      tooltipBorder: '#374151',
      tooltipText: '#f3f4f6',
      labelColor: '#d1d5db',
      noDataColor: '#6b7280',
    };
  }
  return {
    tooltipBg: '#ffffff',
    tooltipBorder: '#e5e7eb',
    tooltipText: '#374151',
    labelColor: '#374151',
    noDataColor: '#9ca3af',
  };
}

/* ------------------------------------------------------------------ */
/*  Custom label renderer                                               */
/* ------------------------------------------------------------------ */

interface LabelProps {
  cx: number;
  cy: number;
  midAngle: number;
  innerRadius: number;
  outerRadius: number;
  percent: number;
  name: string;
}

function renderCustomLabel({
  cx,
  cy,
  midAngle,
  innerRadius,
  outerRadius,
  percent,
}: LabelProps): React.ReactElement | null {
  if (percent < 0.05) return null; // skip tiny slices
  const RADIAN = Math.PI / 180;
  const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);

  return (
    <text
      x={x}
      y={y}
      fill="#ffffff"
      textAnchor="middle"
      dominantBaseline="central"
      fontSize={11}
      fontWeight={600}
    >
      {(percent * 100).toFixed(0)}%
    </text>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

export const PieChart: React.FC<PieChartProps> = ({
  segments,
  doughnut = false,
  showLegend = true,
  showLabels = true,
  theme = 'light',
  className,
}) => {
  const tagIds = useMemo(() => segments.map((s) => s.tagId), [segments]);
  const { values, isConnected } = useRealtimeData(tagIds);
  const colors = getThemeColors(theme);

  /**
   * Derive numeric segment values from realtime data.
   *
   * Negative values are clamped to 0 because pie/doughnut slices represent
   * proportional areas and negative arc lengths are mathematically undefined.
   */
  const chartData = useMemo(() => {
    return segments.map((seg) => {
      const change = values[seg.tagId];
      let v = 0;
      if (change) {
        const raw =
          typeof change.value === 'number'
            ? change.value
            : parseFloat(String(change.value));
        v = isNaN(raw) || raw < 0 ? 0 : raw;
      }
      return {
        name: seg.label,
        value: v,
        color: seg.color,
        tagId: seg.tagId,
      };
    });
  }, [values, segments]);

  const totalValue = useMemo(
    () => chartData.reduce((sum, d) => sum + d.value, 0),
    [chartData],
  );

  const tooltipFormatter = useCallback(
    (value: number, name: string) => {
      const pct = totalValue > 0 ? ((value / totalValue) * 100).toFixed(1) : '0.0';
      return [`${value.toFixed(2)} (${pct}%)`, name];
    },
    [totalValue],
  );

  const allZero = totalValue === 0;

  return (
    <div className={`relative flex flex-col w-full h-full ${className ?? ''}`}>
      {!isConnected && (
        <div className="px-2 py-0.5 text-xs text-amber-600 bg-amber-50 border-b border-amber-200">
          Disconnected -- showing last known values
        </div>
      )}

      {allZero && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <span className="text-xs" style={{ color: colors.noDataColor }}>
            No data
          </span>
        </div>
      )}

      <div className="flex-1 min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <RechartsPieChart>
            <Pie
              data={chartData}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={doughnut ? '55%' : 0}
              outerRadius="80%"
              paddingAngle={segments.length > 1 ? 2 : 0}
              label={showLabels ? renderCustomLabel : false}
              labelLine={false}
              animationDuration={300}
              stroke={theme === 'dark' ? '#1f2937' : '#ffffff'}
              strokeWidth={2}
            >
              {chartData.map((entry) => (
                <Cell key={entry.tagId} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip
              formatter={tooltipFormatter}
              contentStyle={{
                backgroundColor: colors.tooltipBg,
                border: `1px solid ${colors.tooltipBorder}`,
                borderRadius: '6px',
                fontSize: '12px',
                color: colors.tooltipText,
              }}
            />
            {showLegend && (
              <Legend
                layout="horizontal"
                verticalAlign="bottom"
                align="center"
                wrapperStyle={{ fontSize: '11px', paddingTop: 8 }}
                iconType="circle"
                iconSize={8}
              />
            )}
          </RechartsPieChart>
        </ResponsiveContainer>
      </div>

      {/* Inline value labels below chart */}
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 px-2 pb-1 mt-1">
        {chartData.map((entry) => (
          <span
            key={entry.tagId}
            className="flex items-center gap-1 text-xs"
            style={{ color: colors.labelColor }}
          >
            <span
              className="inline-block h-2.5 w-2.5 rounded-full flex-shrink-0"
              style={{ background: entry.color }}
            />
            <span className="font-medium">{entry.name}:</span>
            <span className="font-mono">{entry.value.toFixed(2)}</span>
          </span>
        ))}
      </div>
    </div>
  );
};
