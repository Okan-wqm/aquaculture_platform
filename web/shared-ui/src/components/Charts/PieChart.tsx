/**
 * Pie Chart — a share of a whole, drawn by recharts and painted from the
 * theme palette (FE-MEDIUM-084: one chart engine). `innerRadius` above zero
 * makes it a ring; DonutChart wraps that with a centre slot.
 */
import React, { useMemo } from 'react';
import { Cell, Pie, PieChart as RechartsPieChart, Tooltip } from 'recharts';

import { colors } from '../../styles/theme';
import { NoData, seriesColor } from './chartSupport';
import { ChartLegend } from './ChartLegend';
import { ChartTooltipContent } from './ChartTooltip';

export interface PieDataItem {
  label: string;
  value: number;
  color?: string;
}

export interface PieChartProps {
  data: PieDataItem[];
  size?: number;
  /** 0 draws a pie; above 0 leaves a hole of that radius. */
  innerRadius?: number;
  showLabels?: boolean;
  showPercentages?: boolean;
  showLegend?: boolean;
  showTooltip?: boolean;
  animate?: boolean;
  className?: string;
  formatValue?: (value: number) => string;
}

interface SliceLabelProps {
  x?: number;
  y?: number;
  percent?: number;
  value?: number;
}

export const PieChart: React.FC<PieChartProps> = ({
  data,
  size = 200,
  innerRadius = 0,
  showLabels = false,
  showPercentages = true,
  showLegend = true,
  showTooltip = true,
  animate = true,
  className = '',
  formatValue = (value) => value.toLocaleString(),
}) => {
  const total = useMemo(() => data.reduce((sum, item) => sum + item.value, 0), [data]);
  const legend = useMemo(
    () =>
      data.map((item, index) => ({
        label: item.label,
        color: seriesColor(item.color, index),
        value: formatValue(item.value),
        percentage: total > 0 ? Math.round((item.value / total) * 100) : 0,
      })),
    [data, formatValue, total],
  );

  if (data.length === 0 || total <= 0) {
    return <NoData width={size} height={size} className={className} />;
  }

  const renderLabel = ({
    x = 0,
    y = 0,
    percent = 0,
    value = 0,
  }: SliceLabelProps): React.ReactElement => (
    <text
      x={x}
      y={y}
      fill={colors.white}
      textAnchor="middle"
      dominantBaseline="central"
      fontSize={12}
      fontWeight={500}
    >
      {showPercentages ? `${Math.round(percent * 100)}%` : formatValue(value)}
    </text>
  );

  return (
    <div className={`flex flex-col items-center gap-3 ${className}`}>
      <RechartsPieChart width={size} height={size}>
        <Pie
          data={data}
          dataKey="value"
          nameKey="label"
          cx="50%"
          cy="50%"
          innerRadius={innerRadius}
          outerRadius={size / 2 - 10}
          paddingAngle={data.length > 1 ? 1 : 0}
          stroke={colors.white}
          label={showLabels ? renderLabel : false}
          labelLine={false}
          isAnimationActive={animate}
        >
          {data.map((item, index) => (
            <Cell key={item.label} fill={seriesColor(item.color, index)} />
          ))}
        </Pie>
        {showTooltip && (
          <Tooltip
            content={<ChartTooltipContent formatter={(value) => formatValue(Number(value))} />}
          />
        )}
      </RechartsPieChart>
      {showLegend && (
        <ChartLegend
          items={legend}
          showPercentages={showPercentages}
          showValues={!showPercentages}
        />
      )}
    </div>
  );
};

export default PieChart;
