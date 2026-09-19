/**
 * Sparkline — a trend in a KPI card's corner: no axes, no chrome, drawn by
 * recharts and painted from the theme (FE-MEDIUM-084: one chart engine).
 */
import React, { useId, useMemo } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Line,
  LineChart,
  ReferenceDot,
  XAxis,
  YAxis,
} from 'recharts';

import { colors } from '../../styles/theme';
import { NoData } from './chartSupport';

export interface SparklineChartProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  gradientFrom?: string;
  gradientTo?: string;
  strokeWidth?: number;
  showArea?: boolean;
  /** Marks the latest value. */
  showDot?: boolean;
  /** Marks the lowest value in the error colour and the highest in the success colour. */
  showMinMax?: boolean;
  animate?: boolean;
  className?: string;
  variant?: 'line' | 'bar' | 'area';
}

interface SparkPoint {
  index: number;
  value: number;
}

export const SparklineChart: React.FC<SparklineChartProps> = ({
  data,
  width = 100,
  height = 30,
  color = colors.primary[500],
  gradientFrom,
  gradientTo,
  strokeWidth = 1.5,
  showArea = true,
  showDot = true,
  showMinMax = false,
  animate = true,
  className = '',
  variant = 'area',
}) => {
  const gradientId = useId();
  const points = useMemo<SparkPoint[]>(
    () => data.map((value, index) => ({ index, value })),
    [data],
  );
  const extremes = useMemo(() => {
    if (points.length === 0) return null;
    let min = points[0]!;
    let max = points[0]!;
    for (const point of points) {
      if (point.value < min.value) min = point;
      if (point.value > max.value) max = point;
    }
    return { min, max, last: points[points.length - 1]! };
  }, [points]);

  if (points.length === 0 || extremes === null) {
    return <NoData width={width} height={height} className={className} />;
  }

  const axes = (
    <>
      <XAxis dataKey="index" type="number" domain={['dataMin', 'dataMax']} hide />
      <YAxis domain={['dataMin', 'dataMax']} hide />
    </>
  );
  const marks = (
    <>
      {showDot && (
        <ReferenceDot
          x={extremes.last.index}
          y={extremes.last.value}
          r={3}
          fill={color}
          stroke={colors.white}
          strokeWidth={1.5}
        />
      )}
      {showMinMax && (
        <>
          <ReferenceDot
            x={extremes.min.index}
            y={extremes.min.value}
            r={2.5}
            fill={colors.error[500]}
            stroke="none"
          />
          <ReferenceDot
            x={extremes.max.index}
            y={extremes.max.value}
            r={2.5}
            fill={colors.success[500]}
            stroke="none"
          />
        </>
      )}
    </>
  );
  const margin = { top: 4, right: 4, bottom: 4, left: 4 };

  if (variant === 'bar') {
    return (
      <div className={className} style={{ width, height }}>
        <BarChart data={points} width={width} height={height} margin={margin} barCategoryGap={1}>
          {axes}
          <Bar dataKey="value" fill={color} radius={[1, 1, 0, 0]} isAnimationActive={animate} />
          {marks}
        </BarChart>
      </div>
    );
  }

  if (variant === 'line' || !showArea) {
    return (
      <div className={className} style={{ width, height }}>
        <LineChart data={points} width={width} height={height} margin={margin}>
          {axes}
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={strokeWidth}
            dot={false}
            isAnimationActive={animate}
          />
          {marks}
        </LineChart>
      </div>
    );
  }

  return (
    <div className={className} style={{ width, height }}>
      <AreaChart data={points} width={width} height={height} margin={margin}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={gradientFrom ?? color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={gradientTo ?? color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        {axes}
        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={strokeWidth}
          fill={`url(#${gradientId})`}
          dot={false}
          isAnimationActive={animate}
        />
        {marks}
      </AreaChart>
    </div>
  );
};

export default SparklineChart;
