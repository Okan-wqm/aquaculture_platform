/**
 * Radial Gauge Widget Content
 *
 * Radial progress gauge with threshold zones for single sensor value.
 */

import React, { useState, useEffect } from 'react';
import { Clock } from 'lucide-react';
import { WidgetConfig } from '../types';
import { useWidgetData } from '../../../hooks/useWidgetData';

interface RadialGaugeWidgetContentProps {
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

export const RadialGaugeWidgetContent: React.FC<RadialGaugeWidgetContentProps> = ({
  config,
}) => {
  const { data, loading, error } = useWidgetData(config);
  const [, forceUpdate] = useState(0);

  // Update time display every second
  useEffect(() => {
    const interval = setInterval(() => forceUpdate((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error || !data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        {error || 'No data'}
      </div>
    );
  }

  const reading = data[0];
  const { value, unit, status, minValue = 0, maxValue = 100 } = reading;

  // Get thresholds from settings or use defaults based on range
  const thresholds = config.settings?.thresholds || {
    warning: { low: minValue + (maxValue - minValue) * 0.2, high: minValue + (maxValue - minValue) * 0.8 },
    critical: { low: minValue + (maxValue - minValue) * 0.1, high: minValue + (maxValue - minValue) * 0.9 },
  };

  // Calculate percentage
  const percentage = Math.min(100, Math.max(0, ((value - minValue) / (maxValue - minValue)) * 100));

  // SVG dimensions
  const size = 140;
  const strokeWidth = 14;
  const radius = (size - strokeWidth) / 2;
  const circumference = Math.PI * radius; // Semi-circle (180 degrees)
  const valueOffset = circumference - (percentage / 100) * circumference;

  // Determine color based on value and thresholds
  const getColor = () => {
    if (
      (thresholds.critical?.low !== undefined && value < thresholds.critical.low) ||
      (thresholds.critical?.high !== undefined && value > thresholds.critical.high)
    ) {
      return '#EF4444'; // Critical - Red
    }
    if (
      (thresholds.warning?.low !== undefined && value < thresholds.warning.low) ||
      (thresholds.warning?.high !== undefined && value > thresholds.warning.high)
    ) {
      return '#F59E0B'; // Warning - Amber
    }
    return '#10B981'; // Normal - Green
  };

  const valueColor = getColor();

  // Generate gradient stops for the background arc
  const backgroundGradientStops = [
    { offset: 0, color: '#10B981', opacity: 0.2 },    // Green (low normal)
    { offset: 20, color: '#F59E0B', opacity: 0.2 },   // Warning low
    { offset: 30, color: '#10B981', opacity: 0.2 },   // Normal zone
    { offset: 70, color: '#10B981', opacity: 0.2 },   // Normal zone
    { offset: 80, color: '#F59E0B', opacity: 0.2 },   // Warning high
    { offset: 100, color: '#EF4444', opacity: 0.2 },  // Critical high
  ];

  return (
    <div className="flex flex-col items-center justify-center h-full">
      {/* Radial Gauge SVG */}
      <div className="relative" style={{ width: size, height: size / 2 + 30 }}>
        <svg
          width={size}
          height={size / 2 + strokeWidth}
          className="overflow-visible"
        >
          {/* Background gradient definition */}
          <defs>
            <linearGradient id={`radial-bg-${config.id}`} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#EF4444" stopOpacity={0.15} />
              <stop offset="20%" stopColor="#F59E0B" stopOpacity={0.15} />
              <stop offset="35%" stopColor="#10B981" stopOpacity={0.15} />
              <stop offset="65%" stopColor="#10B981" stopOpacity={0.15} />
              <stop offset="80%" stopColor="#F59E0B" stopOpacity={0.15} />
              <stop offset="100%" stopColor="#EF4444" stopOpacity={0.15} />
            </linearGradient>
          </defs>

          {/* Background arc with zones */}
          <path
            d={`M ${strokeWidth / 2} ${size / 2} A ${radius} ${radius} 0 0 1 ${size - strokeWidth / 2} ${size / 2}`}
            fill="none"
            stroke={`url(#radial-bg-${config.id})`}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />

          {/* Value arc */}
          <path
            d={`M ${strokeWidth / 2} ${size / 2} A ${radius} ${radius} 0 0 1 ${size - strokeWidth / 2} ${size / 2}`}
            fill="none"
            stroke={valueColor}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={valueOffset}
            className="transition-all duration-500"
            style={{ transformOrigin: 'center', transform: 'rotate(180deg)' }}
          />
        </svg>

        {/* Center value display */}
        <div
          className="absolute flex flex-col items-center justify-center"
          style={{
            left: '50%',
            top: size / 2,
            transform: 'translate(-50%, -50%)',
          }}
        >
          <span
            className="text-3xl font-bold"
            style={{ color: valueColor }}
          >
            {value.toFixed(config.settings?.decimalPlaces ?? 1)}
          </span>
          <span className="text-sm text-gray-500">{unit}</span>
        </div>

        {/* Min/Max labels */}
        <div
          className="absolute flex justify-between text-xs text-gray-400"
          style={{
            left: strokeWidth / 2,
            right: strokeWidth / 2,
            top: size / 2 + 10,
          }}
        >
          <span>{minValue}</span>
          <span>{maxValue}</span>
        </div>
      </div>

      {/* Status indicator */}
      <div className="flex items-center gap-2 mt-2">
        <div
          className="w-2 h-2 rounded-full"
          style={{ backgroundColor: valueColor }}
        />
        <span className="text-xs text-gray-600 capitalize">{status}</span>
      </div>

      {/* Last update time */}
      <div className="flex items-center gap-1 text-xs text-gray-400 mt-1">
        <Clock size={10} />
        <span>{formatTimeSince(reading.timestamp)}</span>
      </div>
    </div>
  );
};

export default RadialGaugeWidgetContent;
