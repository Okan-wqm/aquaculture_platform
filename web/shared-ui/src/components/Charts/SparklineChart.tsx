/**
 * Sparkline Chart Component
 * Compact inline chart for use in tables and cards
 */

import React, { useMemo } from 'react';

export interface SparklineChartProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  gradientFrom?: string;
  gradientTo?: string;
  strokeWidth?: number;
  showArea?: boolean;
  showDot?: boolean;
  showMinMax?: boolean;
  animate?: boolean;
  className?: string;
  variant?: 'line' | 'bar' | 'area';
}

export const SparklineChart: React.FC<SparklineChartProps> = ({
  data,
  width = 100,
  height = 32,
  color = '#3B82F6',
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
  const gradientId = useMemo(() => `sparkline-gradient-${Math.random().toString(36).substr(2, 9)}`, []);

  const { points, path, areaPath, minIndex, maxIndex, barWidth } = useMemo(() => {
    if (!data || data.length < 2) {
      return { points: [], path: '', areaPath: '', minIndex: -1, maxIndex: -1, barWidth: 0 };
    }

    const padding = 2;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;

    const bWidth = (width - padding * 2) / data.length - 1;

    const pts = data.map((value, index) => {
      const x = padding + (index / (data.length - 1)) * (width - padding * 2);
      const y = padding + (1 - (value - min) / range) * (height - padding * 2);
      return { x, y, value };
    });

    const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

    const areaD = [
      ...pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`),
      `L ${pts[pts.length - 1].x} ${height - padding}`,
      `L ${pts[0].x} ${height - padding}`,
      'Z',
    ].join(' ');

    const minIdx = data.indexOf(min);
    const maxIdx = data.indexOf(max);

    return { points: pts, path: pathD, areaPath: areaD, minIndex: minIdx, maxIndex: maxIdx, barWidth: bWidth };
  }, [data, width, height]);

  if (!data || data.length < 2) {
    return <div className={className} style={{ width, height }} />;
  }

  if (variant === 'bar') {
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const padding = 2;

    return (
      <svg width={width} height={height} className={className}>
        {data.map((value, index) => {
          const barHeight = ((value - min) / range) * (height - padding * 2);
          const x = padding + index * (barWidth + 1);
          const y = height - padding - barHeight;

          return (
            <rect
              key={index}
              x={x}
              y={y}
              width={barWidth}
              height={barHeight}
              fill={color}
              rx={1}
              className={animate ? 'transition-all duration-300' : ''}
            />
          );
        })}
      </svg>
    );
  }

  return (
    <svg width={width} height={height} className={`overflow-visible ${className}`}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={gradientFrom || color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={gradientTo || color} stopOpacity="0.05" />
        </linearGradient>
      </defs>

      {/* Area fill */}
      {showArea && variant === 'area' && (
        <path
          d={areaPath}
          fill={`url(#${gradientId})`}
          className={animate ? 'transition-all duration-500' : ''}
        />
      )}

      {/* Line */}
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={animate ? 'transition-all duration-500' : ''}
      />

      {/* Min/Max dots */}
      {showMinMax && (
        <>
          {minIndex >= 0 && (
            <circle
              cx={points[minIndex].x}
              cy={points[minIndex].y}
              r={3}
              fill="#EF4444"
              className={animate ? 'transition-all duration-300' : ''}
            />
          )}
          {maxIndex >= 0 && (
            <circle
              cx={points[maxIndex].x}
              cy={points[maxIndex].y}
              r={3}
              fill="#10B981"
              className={animate ? 'transition-all duration-300' : ''}
            />
          )}
        </>
      )}

      {/* End dot */}
      {showDot && points.length > 0 && (
        <circle
          cx={points[points.length - 1].x}
          cy={points[points.length - 1].y}
          r={3}
          fill={color}
          className={animate ? 'transition-all duration-300' : ''}
        />
      )}
    </svg>
  );
};

export default SparklineChart;
