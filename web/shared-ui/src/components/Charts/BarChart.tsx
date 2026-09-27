/**
 * Bar Chart — grouped or stacked series over shared labels, drawn by recharts
 * and painted from the theme palette (FE-MEDIUM-084: one chart engine).
 */
import React, { useMemo } from 'react';
import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  LabelList,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { chartChrome } from '../../styles/theme';
import { AXIS_TICK, ChartFrame, NoData, seriesColor } from './chartSupport';
import { ChartLegend } from './ChartLegend';
import { ChartTooltipContent } from './ChartTooltip';

export interface BarDataset {
  label: string;
  data: number[];
  color?: string;
}

export interface BarChartProps {
  labels: string[];
  datasets: BarDataset[];
  /** A number fixes the width; leave it out to fill the parent. */
  width?: number;
  height?: number;
  showGrid?: boolean;
  showLabels?: boolean;
  showTooltip?: boolean;
  showLegend?: boolean;
  showValues?: boolean;
  stacked?: boolean;
  barRadius?: number;
  animate?: boolean;
  className?: string;
  formatValue?: (value: number) => string;
}

/** One row per label, one column per dataset: the shape recharts reads. */
export function toRows(
  labels: string[],
  datasets: BarDataset[],
): Array<Record<string, string | number>> {
  return labels.map((label, index) => {
    const row: Record<string, string | number> = { label };
    for (const dataset of datasets) row[dataset.label] = dataset.data[index] ?? 0;
    return row;
  });
}

export const BarChart: React.FC<BarChartProps> = ({
  labels,
  datasets,
  width,
  height = 200,
  showGrid = true,
  showLabels = true,
  showTooltip = true,
  showLegend = true,
  showValues = false,
  stacked = false,
  barRadius = 4,
  animate = true,
  className = '',
  formatValue = (value) => value.toLocaleString(),
}) => {
  const rows = useMemo(() => toRows(labels, datasets), [labels, datasets]);
  const legend = useMemo(
    () =>
      datasets.map((dataset, index) => ({
        label: dataset.label,
        color: seriesColor(dataset.color, index),
      })),
    [datasets],
  );

  if (labels.length === 0 || datasets.length === 0) {
    return <NoData width={width} height={height} className={className} />;
  }

  const radius: [number, number, number, number] = [barRadius, barRadius, 0, 0];
  return (
    <div className={className}>
      {showLegend && <ChartLegend items={legend} className="mb-2" />}
      <ChartFrame width={width} height={height}>
        <RechartsBarChart
          data={rows}
          margin={{ top: showValues ? 20 : 8, right: 16, bottom: 0, left: 0 }}
        >
          {showGrid && (
            <CartesianGrid strokeDasharray="4 4" stroke={chartChrome.grid} vertical={false} />
          )}
          <XAxis
            dataKey="label"
            hide={!showLabels}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: chartChrome.axis }}
            interval="preserveStartEnd"
            minTickGap={16}
          />
          <YAxis
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={formatValue}
          />
          {showTooltip && (
            <Tooltip
              cursor={{ fill: chartChrome.grid, fillOpacity: 0.4 }}
              content={<ChartTooltipContent formatter={(value) => formatValue(Number(value))} />}
            />
          )}
          {datasets.map((dataset, index) => (
            <Bar
              key={dataset.label}
              dataKey={dataset.label}
              name={dataset.label}
              fill={seriesColor(dataset.color, index)}
              stackId={stacked ? 'stack' : undefined}
              radius={stacked && index < datasets.length - 1 ? 0 : radius}
              isAnimationActive={animate}
            >
              {showValues && (
                <LabelList
                  dataKey={dataset.label}
                  position="top"
                  formatter={formatValue}
                  style={AXIS_TICK}
                />
              )}
            </Bar>
          ))}
        </RechartsBarChart>
      </ChartFrame>
    </div>
  );
};

export default BarChart;
