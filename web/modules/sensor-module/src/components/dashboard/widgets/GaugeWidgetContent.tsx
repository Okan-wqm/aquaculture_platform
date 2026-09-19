/**
 * Gauge Widget Content
 *
 * Circular gauge for displaying single sensor value.
 */

import React, { useState, useEffect } from 'react';
import { Clock } from 'lucide-react';
import { WidgetConfig } from '../types';
import { useWidgetData } from '../../../hooks/useWidgetData';
import { colors as themeColors, Spinner } from '@aquaculture/shared-ui';

interface GaugeWidgetContentProps {
  config: WidgetConfig;
}

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

export const GaugeWidgetContent: React.FC<GaugeWidgetContentProps> = ({ config }) => {
  const { data, loading, error } = useWidgetData(config);
  const [, forceUpdate] = useState(0);

  // Update time display every second
  useEffect(() => {
    const interval = setInterval(() => forceUpdate(n => n + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error || !data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400 text-sm">
        {error || 'No data'}
      </div>
    );
  }

  const reading = data[0];
  const { value, unit, status, minValue = 0, maxValue = 100 } = reading;

  // Calculate percentage
  const percentage = Math.min(100, Math.max(0, ((value - minValue) / (maxValue - minValue)) * 100));

  // Calculate arc parameters
  const size = 120;
  const strokeWidth = 12;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference * 0.75; // 270 degree arc

  // Status colors
  const statusColors = {
    normal: { stroke: themeColors.success[500], bg: themeColors.success[100] },
    warning: { stroke: themeColors.warning[500], bg: themeColors.warning[100] },
    critical: { stroke: themeColors.error[500], bg: themeColors.error[100] },
    offline: { stroke: themeColors.gray[400], bg: themeColors.neutral[100] },
  };

  const colors = statusColors[status] || statusColors.normal;

  return (
    <div className="flex flex-col items-center justify-center h-full">
      {/* Gauge SVG */}
      <div className="relative">
        <svg width={size} height={size} className="transform -rotate-135">
          {/* Background arc */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={themeColors.neutral[200]}
            strokeWidth={strokeWidth}
            strokeDasharray={`${circumference * 0.75} ${circumference}`}
            strokeLinecap="round"
          />
          {/* Value arc */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={colors.stroke}
            strokeWidth={strokeWidth}
            strokeDasharray={`${circumference * 0.75} ${circumference}`}
            strokeDashoffset={offset}
            strokeLinecap="round"
            className="transition-all duration-500"
          />
        </svg>

        {/* Center value */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {value.toFixed(config.settings?.decimalPlaces ?? 1)}
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">{unit}</span>
        </div>
      </div>

      {/* Status and timestamp */}
      <div className="mt-2 flex items-center gap-2">
        <div
          className="w-2 h-2 rounded-full"
          style={{ backgroundColor: colors.stroke }}
        />
        <span className="text-xs text-gray-600 dark:text-gray-400 capitalize">{status}</span>
      </div>

      {/* Last update time */}
      <div className="mt-1 flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
        <Clock size={10} />
        <span>{formatTimeSince(reading.timestamp)}</span>
      </div>

      {/* Min/Max labels */}
      <div className="flex justify-between w-full mt-1 px-4 text-xs text-gray-500 dark:text-gray-400">
        <span>{minValue}</span>
        <span>{maxValue}</span>
      </div>
    </div>
  );
};

export default GaugeWidgetContent;
