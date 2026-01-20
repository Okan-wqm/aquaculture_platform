/**
 * Numeric Widget Component
 * Displays sensor value as a large number with unit and trend indicator
 */

import React from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { SensorReading, SensorStatus } from '../../../store/scadaStore';

interface NumericWidgetProps {
  reading: SensorReading;
  size?: 'sm' | 'md' | 'lg';
  showTrend?: boolean;
  showLabel?: boolean;
  className?: string;
}

const sizeConfig = {
  sm: { valueSize: 'text-lg', unitSize: 'text-xs', labelSize: 'text-xs', iconSize: 12, padding: 'p-2' },
  md: { valueSize: 'text-2xl', unitSize: 'text-sm', labelSize: 'text-xs', iconSize: 16, padding: 'p-3' },
  lg: { valueSize: 'text-4xl', unitSize: 'text-base', labelSize: 'text-sm', iconSize: 20, padding: 'p-4' },
};

const statusColors: Record<SensorStatus, { bg: string; text: string; border: string }> = {
  normal: { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200' },
  warning: { bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-200' },
  critical: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
  offline: { bg: 'bg-gray-50', text: 'text-gray-500', border: 'border-gray-200' },
};

const trendColors = {
  up: 'text-green-500',
  down: 'text-red-500',
  stable: 'text-gray-400',
};

export const NumericWidget: React.FC<NumericWidgetProps> = ({
  reading,
  size = 'md',
  showTrend = true,
  showLabel = true,
  className = '',
}) => {
  const config = sizeConfig[size];
  const colors = statusColors[reading.status];

  const TrendIcon = reading.trend === 'up' ? TrendingUp : reading.trend === 'down' ? TrendingDown : Minus;

  return (
    <div
      className={`
        rounded-lg border ${colors.border} ${colors.bg}
        ${config.padding} ${className}
        flex flex-col items-center justify-center
        transition-all duration-300
      `}
    >
      {/* Label */}
      {showLabel && (
        <div className={`${config.labelSize} text-gray-500 mb-1 capitalize`}>
          {reading.type.replace('_', ' ')}
        </div>
      )}

      {/* Value with trend */}
      <div className="flex items-center gap-1">
        <span className={`${config.valueSize} font-bold ${colors.text}`}>
          {reading.value.toFixed(1)}
        </span>
        <span className={`${config.unitSize} text-gray-500`}>{reading.unit}</span>
        {showTrend && (
          <TrendIcon
            size={config.iconSize}
            className={`${trendColors[reading.trend]} ml-1`}
          />
        )}
      </div>

      {/* Status indicator */}
      <div className="flex items-center gap-1 mt-1">
        <div
          className={`w-2 h-2 rounded-full ${
            reading.status === 'normal'
              ? 'bg-green-500'
              : reading.status === 'warning'
              ? 'bg-yellow-500 animate-pulse'
              : reading.status === 'critical'
              ? 'bg-red-500 animate-pulse'
              : 'bg-gray-400'
          }`}
        />
        <span className={`${config.labelSize} ${colors.text} capitalize`}>
          {reading.status}
        </span>
      </div>
    </div>
  );
};

export default NumericWidget;
