/**
 * Line Chart — one or more series over shared labels, drawn by recharts and
 * painted from the theme palette (FE-MEDIUM-084: one chart engine).
 */
import React, { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart as RechartsLineChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { chartChrome, colors } from '../../styles/theme';
import { toRows } from './BarChart';
import { AXIS_TICK, ChartFrame, NoData, seriesColor } from './chartSupport';
import { ChartLegend } from './ChartLegend';
import { ChartTooltipContent } from './ChartTooltip';

export interface LineDataset {
  label: string;
  data: number[];
  color?: string;
  strokeWidth?: number;
  dashed?: boolean;
}

export interface LineChartProps {
  labels: string[];
  datasets: LineDataset[];
  /** A number fixes the width; leave it out to fill the parent. */
  width?: number;
  height?: number;
  showGrid?: boolean;
  showLabels?: boolean;
  showTooltip?: boolean;
  showDots?: boolean;
  showLegend?: boolean;
  animate?: boolean;
  className?: string;
  formatValue?: (value: number) => string;
}

export const LineChart: React.FC<LineChartProps> = ({
  labels,
  datasets,
  width,
  height = 200,
  showGrid = true,
  showLabels = true,
  showTooltip = true,
  showDots = true,
  showLegend = true,
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

  return (
    <div className={className}>
      {showLegend && <ChartLegend items={legend} className="mb-2" />}
      <ChartFrame width={width} height={height}>
        <RechartsLineChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
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
            minTickGap={24}
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
              cursor={{ stroke: chartChrome.axis, strokeDasharray: '4 4' }}
              content={<ChartTooltipContent formatter={(value) => formatValue(Number(value))} />}
            />
          )}
          {datasets.map((dataset, index) => {
            const color = seriesColor(dataset.color, index);
            return (
              <Line
                key={dataset.label}
                type="linear"
                dataKey={dataset.label}
                name={dataset.label}
                stroke={color}
                strokeWidth={dataset.strokeWidth ?? 2}
                strokeDasharray={dataset.dashed ? '8 4' : undefined}
                dot={showDots ? { r: 3, fill: colors.white, stroke: color, strokeWidth: 2 } : false}
                activeDot={{ r: 5, fill: color, stroke: colors.white, strokeWidth: 2 }}
                isAnimationActive={animate}
              />
            );
          })}
        </RechartsLineChart>
      </ChartFrame>
    </div>
  );
};

export default LineChart;
