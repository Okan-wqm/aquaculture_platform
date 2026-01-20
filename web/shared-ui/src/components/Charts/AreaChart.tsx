/**
 * Area Chart Component
 * SVG-based area chart with gradient fill
 */

import React, { useMemo, useState } from 'react';
import { ChartTooltip } from './ChartTooltip';

export interface DataPoint {
  label: string;
  value: number;
}

export interface AreaChartProps {
  data: DataPoint[];
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
}

export const AreaChart: React.FC<AreaChartProps> = ({
  data,
  width = 400,
  height = 200,
  color = '#3B82F6',
  gradientFrom,
  gradientTo,
  strokeWidth = 2,
  showGrid = true,
  showLabels = true,
  showTooltip = true,
  showDots = false,
  animate = true,
  className = '',
  formatValue = (v) => v.toLocaleString(),
}) => {
  const [tooltipData, setTooltipData] = useState<{
    visible: boolean;
    x: number;
    y: number;
    label: string;
    value: number;
  }>({ visible: false, x: 0, y: 0, label: '', value: 0 });

  const padding = { top: 20, right: 20, bottom: showLabels ? 40 : 20, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const gradientId = useMemo(() => `area-gradient-${Math.random().toString(36).substr(2, 9)}`, []);

  const { points, path, areaPath, yTicks, minValue, maxValue } = useMemo(() => {
    if (!data || data.length === 0) {
      return { points: [], path: '', areaPath: '', yTicks: [], minValue: 0, maxValue: 0 };
    }

    const values = data.map((d) => d.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;

    // Add padding to range
    const paddedMin = min - range * 0.1;
    const paddedMax = max + range * 0.1;
    const paddedRange = paddedMax - paddedMin;

    const pts = data.map((d, i) => ({
      x: padding.left + (i / (data.length - 1)) * chartWidth,
      y: padding.top + (1 - (d.value - paddedMin) / paddedRange) * chartHeight,
      label: d.label,
      value: d.value,
    }));

    const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

    const areaD = [
      ...pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`),
      `L ${pts[pts.length - 1].x} ${padding.top + chartHeight}`,
      `L ${pts[0].x} ${padding.top + chartHeight}`,
      'Z',
    ].join(' ');

    // Generate Y axis ticks
    const tickCount = 5;
    const ticks = Array.from({ length: tickCount }, (_, i) => {
      const value = paddedMin + (paddedRange * (tickCount - 1 - i)) / (tickCount - 1);
      const y = padding.top + (i / (tickCount - 1)) * chartHeight;
      return { value: Math.round(value), y };
    });

    return { points: pts, path: pathD, areaPath: areaD, yTicks: ticks, minValue: min, maxValue: max };
  }, [data, chartWidth, chartHeight, padding]);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!showTooltip || points.length === 0) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;

    // Find closest point
    let closestPoint = points[0];
    let minDist = Math.abs(mouseX - points[0].x);

    points.forEach((p) => {
      const dist = Math.abs(mouseX - p.x);
      if (dist < minDist) {
        minDist = dist;
        closestPoint = p;
      }
    });

    if (minDist < 30) {
      setTooltipData({
        visible: true,
        x: closestPoint.x,
        y: closestPoint.y,
        label: closestPoint.label,
        value: closestPoint.value,
      });
    } else {
      setTooltipData((prev) => ({ ...prev, visible: false }));
    }
  };

  const handleMouseLeave = () => {
    setTooltipData((prev) => ({ ...prev, visible: false }));
  };

  if (!data || data.length === 0) {
    return (
      <div className={`flex items-center justify-center ${className}`} style={{ width, height }}>
        <span className="text-gray-400 text-sm">No data available</span>
      </div>
    );
  }

  return (
    <div className={`relative ${className}`}>
      <svg
        width={width}
        height={height}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={gradientFrom || color} stopOpacity="0.4" />
            <stop offset="100%" stopColor={gradientTo || color} stopOpacity="0.05" />
          </linearGradient>
        </defs>

        {/* Grid lines */}
        {showGrid && (
          <g className="text-gray-200">
            {yTicks.map((tick, i) => (
              <line
                key={i}
                x1={padding.left}
                y1={tick.y}
                x2={width - padding.right}
                y2={tick.y}
                stroke="currentColor"
                strokeDasharray="4,4"
              />
            ))}
          </g>
        )}

        {/* Y axis labels */}
        <g className="text-gray-500 text-xs">
          {yTicks.map((tick, i) => (
            <text
              key={i}
              x={padding.left - 8}
              y={tick.y}
              textAnchor="end"
              dominantBaseline="middle"
              fill="currentColor"
            >
              {formatValue(tick.value)}
            </text>
          ))}
        </g>

        {/* X axis labels */}
        {showLabels && (
          <g className="text-gray-500 text-xs">
            {points.map((p, i) => (
              // Show every nth label to prevent overlap
              (data.length <= 7 || i % Math.ceil(data.length / 7) === 0) && (
                <text
                  key={i}
                  x={p.x}
                  y={height - padding.bottom + 20}
                  textAnchor="middle"
                  fill="currentColor"
                >
                  {p.label}
                </text>
              )
            ))}
          </g>
        )}

        {/* Area */}
        <path
          d={areaPath}
          fill={`url(#${gradientId})`}
          className={animate ? 'transition-all duration-500' : ''}
        />

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

        {/* Dots */}
        {showDots &&
          points.map((p, i) => (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={4}
              fill="white"
              stroke={color}
              strokeWidth={2}
            />
          ))}

        {/* Tooltip indicator line and dot */}
        {tooltipData.visible && (
          <>
            <line
              x1={tooltipData.x}
              y1={padding.top}
              x2={tooltipData.x}
              y2={height - padding.bottom}
              stroke={color}
              strokeWidth={1}
              strokeDasharray="4,4"
              opacity={0.5}
            />
            <circle
              cx={tooltipData.x}
              cy={tooltipData.y}
              r={6}
              fill="white"
              stroke={color}
              strokeWidth={2}
            />
          </>
        )}
      </svg>

      {/* Tooltip */}
      <ChartTooltip
        visible={tooltipData.visible}
        x={tooltipData.x}
        y={tooltipData.y}
        title={tooltipData.label}
        items={[{ label: 'Value', value: formatValue(tooltipData.value), color }]}
      />
    </div>
  );
};

export default AreaChart;
