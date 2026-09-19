/**
 * Area Chart — one series with a gradient fill, drawn by recharts and painted
 * from the theme (FE-MEDIUM-084: one chart engine).
 */
import React, { useId } from 'react';
import {
  Area,
  AreaChart as RechartsAreaChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { useI18n } from '../../i18n';
import { chartChrome, colors } from '../../styles/theme';
import { AXIS_TICK, ChartFrame, NoData } from './chartSupport';
import { ChartTooltipContent } from './ChartTooltip';

export interface DataPoint {
  label: string;
  value: number;
}

export interface AreaChartProps {
  data: DataPoint[];
  /** A number fixes the width; leave it out to fill the parent. */
  width?: number;
  height?: number;
  color?: string;
  gradientFrom?: string;
  gradientTo?: string;
  strokeWidth?: number;
  showGrid?: boolean;
  showLabels?: boolean;
  showTooltip?: boolean;
  showDots?: boolean;
  animate?: boolean;
  className?: string;
  formatValue?: (value: number) => string;
  /** The series name the tooltip shows; defaults to the locale's "Value". */
  name?: string;
}

export const AreaChart: React.FC<AreaChartProps> = ({
  data,
  width,
  height = 200,
  color = colors.primary[500],
  gradientFrom,
  gradientTo,
  strokeWidth = 2,
  showGrid = true,
  showLabels = true,
  showTooltip = true,
  showDots = false,
  animate = true,
  className = '',
  formatValue = (value) => value.toLocaleString(),
  name,
}) => {
  const { t } = useI18n();
  const gradientId = useId();

  if (data.length === 0) {
    return <NoData width={width} height={height} className={className} />;
  }

  return (
    <ChartFrame width={width} height={height} className={className}>
      <RechartsAreaChart data={data} margin={{ top: 16, right: 16, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={gradientFrom ?? color} stopOpacity={0.4} />
            <stop offset="100%" stopColor={gradientTo ?? color} stopOpacity={0.05} />
          </linearGradient>
        </defs>
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
            cursor={{ stroke: color, strokeDasharray: '4 4' }}
            content={<ChartTooltipContent formatter={(value) => formatValue(Number(value))} />}
          />
        )}
        <Area
          type="linear"
          dataKey="value"
          name={name ?? t('chart.value')}
          stroke={color}
          strokeWidth={strokeWidth}
          fill={`url(#${gradientId})`}
          dot={showDots ? { r: 4, fill: colors.white, stroke: color, strokeWidth: 2 } : false}
          activeDot={{ r: 5, fill: color, stroke: colors.white, strokeWidth: 2 }}
          isAnimationActive={animate}
        />
      </RechartsAreaChart>
    </ChartFrame>
  );
};

export default AreaChart;
