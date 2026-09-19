/**
 * Numeric Widget Component
 * Displays sensor value as a large number with unit and trend indicator
 */

import React from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { SensorReading, SensorStatus } from '../../../store/scadaViewerStore';

interface NumericWidgetProps {
  reading: SensorReading;
  size?: 'sm' | 'md' | 'lg';
  showTrend?: boolean;
  showLabel?: boolean;
  className?: string;
}

const sizeConfig = {
  sm: {
    valueSize: 'text-lg',
    unitSize: 'text-xs',
    labelSize: 'text-xs',
    iconSize: 12,
    padding: 'p-2',
  },
  md: {
    valueSize: 'text-2xl',
    unitSize: 'text-sm',
    labelSize: 'text-xs',
    iconSize: 16,
    padding: 'p-3',
  },
  lg: {
    valueSize: 'text-4xl',
    unitSize: 'text-base',
    labelSize: 'text-sm',
    iconSize: 20,
    padding: 'p-4',
  },
};

const statusColors: Record<SensorStatus, { bg: string; text: string; border: string }> = {
  normal: {
    bg: 'bg-success-50 dark:bg-success-900/20',
    text: 'text-success-700 dark:text-success-300',
    border: 'border-success-200 dark:border-success-800',
  },
  warning: {
    bg: 'bg-warning-50 dark:bg-warning-900/20',
    text: 'text-warning-700 dark:text-warning-300',
    border: 'border-warning-200 dark:border-warning-800',
  },
  critical: {
    bg: 'bg-error-50 dark:bg-error-900/20',
    text: 'text-error-700 dark:text-error-300',
    border: 'border-error-200 dark:border-error-800',
  },
  offline: {
    bg: 'bg-gray-50 dark:bg-gray-800',
    text: 'text-gray-500 dark:text-gray-400',
    border: 'border-gray-200 dark:border-gray-700',
  },
};

const trendColors = {
  up: 'text-success-500',
  down: 'text-error-500',
  stable: 'text-gray-500 dark:text-gray-400',
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

  const TrendIcon =
    reading.trend === 'up' ? TrendingUp : reading.trend === 'down' ? TrendingDown : Minus;

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
        <div className={`${config.labelSize} text-gray-500 dark:text-gray-400 mb-1 capitalize`}>
          {reading.type.replace('_', ' ')}
        </div>
      )}

      {/* Value with trend */}
      <div className="flex items-center gap-1">
        <span className={`${config.valueSize} font-bold ${colors.text}`}>
          {reading.value.toFixed(1)}
        </span>
        <span className={`${config.unitSize} text-gray-500 dark:text-gray-400`}>
          {reading.unit}
        </span>
        {showTrend && (
          <TrendIcon size={config.iconSize} className={`${trendColors[reading.trend]} ml-1`} />
        )}
      </div>

      {/* Status indicator */}
      <div className="flex items-center gap-1 mt-1">
        <div
          className={`w-2 h-2 rounded-full ${
            reading.status === 'normal'
              ? 'bg-success-500'
              : reading.status === 'warning'
                ? 'bg-warning-500 animate-pulse'
                : reading.status === 'critical'
                  ? 'bg-error-500 animate-pulse'
                  : 'bg-gray-400'
          }`}
        />
        <span className={`${config.labelSize} ${colors.text} capitalize`}>{reading.status}</span>
      </div>
    </div>
  );
};

export default NumericWidget;
