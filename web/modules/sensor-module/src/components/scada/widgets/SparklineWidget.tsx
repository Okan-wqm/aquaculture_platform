/**
 * Sparkline Widget Component
 * Displays sensor value trend as a mini line chart
 */

import React, { useMemo } from 'react';
import { SensorReading, SensorStatus } from '../../../store/scadaStore';

interface SparklineWidgetProps {
  reading: SensorReading;
  width?: number;
  height?: number;
  showValue?: boolean;
  showLabel?: boolean;
  className?: string;
}

const statusColors: Record<SensorStatus, string> = {
  normal: '#22c55e',
  warning: '#eab308',
  critical: '#ef4444',
  offline: '#6b7280',
};

export const SparklineWidget: React.FC<SparklineWidgetProps> = ({
  reading,
  width = 120,
  height = 40,
  showValue = true,
  showLabel = true,
  className = '',
}) => {
  const { history, value, unit, status, minValue, maxValue, type } = reading;

  // Generate path from history data
  const { path, areaPath } = useMemo(() => {
    if (history.length < 2) {
      return { path: '', areaPath: '' };
    }

    const padding = 4;
    const chartWidth = width - padding * 2;
    const chartHeight = height - padding * 2;

    // Find min/max from history for scaling
    const values = history.map((h) => h.value);
    const dataMin = Math.min(...values, minValue);
    const dataMax = Math.max(...values, maxValue);
    const range = dataMax - dataMin || 1;

    // Generate points
    const points = history.map((point, index) => {
      const x = padding + (index / (history.length - 1)) * chartWidth;
      const y = padding + chartHeight - ((point.value - dataMin) / range) * chartHeight;
      return { x, y };
    });

    // Create SVG path
    const linePath = points.reduce((acc, point, index) => {
      if (index === 0) return `M ${point.x} ${point.y}`;
      return `${acc} L ${point.x} ${point.y}`;
    }, '');

    // Create area path (for gradient fill)
    const area = `${linePath} L ${points[points.length - 1].x} ${height - padding} L ${padding} ${height - padding} Z`;

    return { path: linePath, areaPath: area };
  }, [history, width, height, minValue, maxValue]);

  const color = statusColors[status];

  return (
    <div className={`flex flex-col ${className}`}>
      {showLabel && (
        <div className="text-xs text-gray-500 mb-1 capitalize">
          {type.replace('_', ' ')}
        </div>
      )}

      <div className="flex items-center gap-2">
        {/* Sparkline SVG */}
        <svg width={width} height={height} className="overflow-visible">
          {/* Gradient definition */}
          <defs>
            <linearGradient id={`gradient-${reading.sensorId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.3" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Area fill */}
          {areaPath && (
            <path
              d={areaPath}
              fill={`url(#gradient-${reading.sensorId})`}
              className="transition-all duration-500"
            />
          )}

          {/* Line */}
          {path && (
            <path
              d={path}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="transition-all duration-500"
            />
          )}

          {/* Current value dot */}
          {history.length > 0 && (
            <circle
              cx={width - 4}
              cy={
                4 +
                (height - 8) -
                ((history[history.length - 1]?.value - minValue) / (maxValue - minValue || 1)) *
                  (height - 8)
              }
              r={3}
              fill={color}
              stroke="white"
              strokeWidth={1.5}
              className="transition-all duration-500"
            />
          )}
        </svg>

        {/* Current value */}
        {showValue && (
          <div className="flex flex-col items-end">
            <span className="text-sm font-semibold text-gray-900">
              {value.toFixed(1)}
            </span>
            <span className="text-xs text-gray-500">{unit}</span>
          </div>
        )}
      </div>

      {/* Status indicator */}
      <div className="flex items-center gap-1 mt-1">
        <div
          className={`w-1.5 h-1.5 rounded-full ${
            status === 'normal'
              ? 'bg-green-500'
              : status === 'warning'
              ? 'bg-yellow-500 animate-pulse'
              : status === 'critical'
              ? 'bg-red-500 animate-pulse'
              : 'bg-gray-400'
          }`}
        />
        <span className="text-xs text-gray-400 capitalize">{status}</span>
      </div>
    </div>
  );
};

export default SparklineWidget;
