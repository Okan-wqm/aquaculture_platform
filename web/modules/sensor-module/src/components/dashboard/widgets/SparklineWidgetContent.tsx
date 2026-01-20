/**
 * Sparkline Widget Content
 *
 * Compact trend line with current value.
 */

import React, { useState, useEffect } from 'react';
import { TrendingUp, TrendingDown, Minus, Clock } from 'lucide-react';

// Format time since last reading
// Bug #5 fix: Handle both Date objects and ISO strings
function formatTimeSince(dateInput: Date | string): string {
  const now = new Date();
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;

  // Check for invalid date
  if (isNaN(date.getTime())) {
    return 'Unknown';
  }

  const diff = now.getTime() - date.getTime();

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m ago`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s ago`;
  return `${seconds}s ago`;
}
import { WidgetConfig } from '../types';
import { useWidgetData } from '../../../hooks/useWidgetData';

interface SparklineWidgetContentProps {
  config: WidgetConfig;
}

export const SparklineWidgetContent: React.FC<SparklineWidgetContentProps> = ({
  config,
}) => {
  const { data, history, loading, error } = useWidgetData(config);
  const [, forceUpdate] = useState(0);

  // Update time display every second
  useEffect(() => {
    const interval = setInterval(() => forceUpdate((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin w-6 h-6 border-2 border-cyan-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error || !data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-xs">
        {error || 'No data'}
      </div>
    );
  }

  const reading = data[0];
  const { value, unit, status } = reading;

  // Get last 30 readings for sparkline
  const sparklineData = history?.slice(-30) || [];

  // Calculate trend
  const trend = (() => {
    if (sparklineData.length < 2) return 'stable';
    const recent = sparklineData.slice(-5);
    const older = sparklineData.slice(-10, -5);
    if (recent.length === 0 || older.length === 0) return 'stable';

    const recentAvg = recent.reduce((a, b) => a + b.value, 0) / recent.length;
    const olderAvg = older.reduce((a, b) => a + b.value, 0) / older.length;

    if (recentAvg > olderAvg * 1.02) return 'up';
    if (recentAvg < olderAvg * 0.98) return 'down';
    return 'stable';
  })();

  // Status colors
  const statusColors = {
    normal: 'text-green-600',
    warning: 'text-yellow-600',
    critical: 'text-red-600',
    offline: 'text-gray-500',
  };

  // SVG sparkline
  const width = 100;
  const height = 30;
  const padding = 2;

  // Bug #4 fix: Filter out NaN values and handle empty arrays
  const validValues = sparklineData
    .map((d) => d.value)
    .filter((v) => v !== undefined && !Number.isNaN(v));

  // If no valid values, don't render sparkline
  const hasValidData = validValues.length >= 2;
  const min = hasValidData ? Math.min(...validValues) : 0;
  const max = hasValidData ? Math.max(...validValues) : 100;
  const range = max - min || 1;

  const points = hasValidData
    ? sparklineData
        .filter((d) => d.value !== undefined && !Number.isNaN(d.value))
        .map((d, i, arr) => {
          // Avoid division by zero when only one point
          const xRatio = arr.length > 1 ? i / (arr.length - 1) : 0.5;
          const x = padding + xRatio * (width - padding * 2);
          const y = height - padding - ((d.value - min) / range) * (height - padding * 2);
          return `${x},${y}`;
        })
        .join(' ')
    : '';

  const TrendIcon = trend === 'up' ? TrendingUp : trend === 'down' ? TrendingDown : Minus;

  return (
    <div className="flex flex-col h-full px-2">
      <div className="flex items-center justify-between flex-1">
        {/* Value and trend */}
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold text-gray-900">
              {value.toFixed(config.settings?.decimalPlaces ?? 1)}
            </span>
            <span className="text-xs text-gray-500">{unit}</span>
          </div>
          <div className={`flex items-center gap-1 ${statusColors[status] || 'text-gray-500'}`}>
            <TrendIcon size={14} />
            <span className="text-xs capitalize">{status}</span>
          </div>
        </div>

        {/* Sparkline - Bug #4 fix: Only render with valid data */}
        {hasValidData && points && (
          <svg width={width} height={height} className="flex-shrink-0">
            {/* Gradient fill */}
            <defs>
              <linearGradient id={`gradient-${config.id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#0EA5E9" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#0EA5E9" stopOpacity={0} />
              </linearGradient>
            </defs>

            {/* Area fill */}
            <polygon
              points={`${padding},${height - padding} ${points} ${width - padding},${height - padding}`}
              fill={`url(#gradient-${config.id})`}
            />

            {/* Line */}
            <polyline
              points={points}
              fill="none"
              stroke="#0EA5E9"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            {/* Current value dot */}
            {validValues.length > 0 && (
              <circle
                cx={width - padding}
                cy={
                  height -
                  padding -
                  ((validValues[validValues.length - 1] - min) / range) *
                    (height - padding * 2)
                }
                r={3}
                fill="#0EA5E9"
              />
            )}
          </svg>
        )}
      </div>
      {/* Last update time */}
      <div className="flex items-center justify-center gap-1 text-xs text-gray-400 pt-1 border-t border-gray-100 mt-1">
        <Clock size={10} />
        <span>{formatTimeSince(reading.timestamp)}</span>
      </div>
    </div>
  );
};

export default SparklineWidgetContent;
