/**
 * Water Quality Gauge Widget
 *
 * Displays water quality parameters with circular gauge visualization.
 * Shows overall status and key parameters (temperature, DO, pH, ammonia, nitrite).
 */

import React, { useMemo } from 'react';
import { Card, Badge, chartChrome, colors, formatRelativeTime } from '@aquaculture/shared-ui';
import { CircleAlert, Lightbulb, TriangleAlert } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

export type WaterQualityStatus = 'OPTIMAL' | 'ACCEPTABLE' | 'WARNING' | 'CRITICAL' | 'UNKNOWN';

export interface WaterQualityData {
  id: string;
  tankId?: string;
  tankName?: string;
  measuredAt: string;
  temperature?: number;
  dissolvedOxygen?: number;
  pH?: number;
  ammonia?: number;
  nitrite?: number;
  overallStatus: WaterQualityStatus;
  hasAlarm?: boolean;
}

export interface WaterQualityGaugeProps {
  /** Water quality data */
  data?: WaterQualityData | null;
  /** Loading state */
  isLoading?: boolean;
  /** Error message */
  error?: string | null;
  /** Tank name to display */
  tankName?: string;
  /** Callback when widget is clicked */
  onClick?: () => void;
  /** Show compact view */
  compact?: boolean;
  /** Custom class name */
  className?: string;
}

// ============================================================================
// Status Configuration
// ============================================================================

const statusConfig: Record<
  WaterQualityStatus,
  {
    color: string;
    bgColor: string;
    borderColor: string;
    label: string;
    badgeVariant: 'success' | 'warning' | 'error' | 'info' | 'default';
  }
> = {
  OPTIMAL: {
    color: 'text-success-600 dark:text-success-400',
    bgColor: 'bg-success-50 dark:bg-success-900/20',
    borderColor: 'border-success-200 dark:border-success-800',
    label: 'Optimal',
    badgeVariant: 'success',
  },
  ACCEPTABLE: {
    color: 'text-info-600 dark:text-info-400',
    bgColor: 'bg-info-50 dark:bg-info-900/20',
    borderColor: 'border-info-200 dark:border-info-800',
    label: 'Kabul Edilebilir',
    badgeVariant: 'info',
  },
  WARNING: {
    color: 'text-warning-600 dark:text-warning-400',
    bgColor: 'bg-warning-50 dark:bg-warning-900/20',
    borderColor: 'border-warning-200 dark:border-warning-800',
    label: 'Dikkat',
    badgeVariant: 'warning',
  },
  CRITICAL: {
    color: 'text-error-600 dark:text-error-400',
    bgColor: 'bg-error-50 dark:bg-error-900/20',
    borderColor: 'border-error-200 dark:border-error-800',
    label: 'Kritik',
    badgeVariant: 'error',
  },
  UNKNOWN: {
    color: 'text-gray-600 dark:text-gray-400',
    bgColor: 'bg-gray-50 dark:bg-gray-800',
    borderColor: 'border-gray-200 dark:border-gray-700',
    label: 'Bilinmiyor',
    badgeVariant: 'default',
  },
};

// ============================================================================
// Parameter Configuration
// ============================================================================

interface ParameterConfig {
  key: keyof Pick<
    WaterQualityData,
    'temperature' | 'dissolvedOxygen' | 'pH' | 'ammonia' | 'nitrite'
  >;
  label: string;
  unit: string;
  optimalMin: number;
  optimalMax: number;
  criticalMin: number;
  criticalMax: number;
  decimals: number;
}

const parameters: ParameterConfig[] = [
  {
    key: 'temperature',
    label: 'Sıcaklık',
    unit: '°C',
    optimalMin: 12,
    optimalMax: 18,
    criticalMin: 5,
    criticalMax: 25,
    decimals: 1,
  },
  {
    key: 'dissolvedOxygen',
    label: 'Oksijen',
    unit: 'mg/L',
    optimalMin: 7,
    optimalMax: 12,
    criticalMin: 5,
    criticalMax: 15,
    decimals: 1,
  },
  {
    key: 'pH',
    label: 'pH',
    unit: '',
    optimalMin: 6.5,
    optimalMax: 8.5,
    criticalMin: 6.0,
    criticalMax: 9.0,
    decimals: 2,
  },
  {
    key: 'ammonia',
    label: 'Amonyak',
    unit: 'mg/L',
    optimalMin: 0,
    optimalMax: 0.02,
    criticalMin: 0,
    criticalMax: 0.05,
    decimals: 3,
  },
  {
    key: 'nitrite',
    label: 'Nitrit',
    unit: 'mg/L',
    optimalMin: 0,
    optimalMax: 0.1,
    criticalMin: 0,
    criticalMax: 0.5,
    decimals: 3,
  },
];

// ============================================================================
// Helper Functions
// ============================================================================

function getParameterStatus(
  value: number | undefined,
  config: ParameterConfig,
): WaterQualityStatus {
  // BUG-L4: type is number | undefined; null check is dead code — removed
  if (value === undefined) return 'UNKNOWN';

  if (value < config.criticalMin || value > config.criticalMax) {
    return 'CRITICAL';
  }
  if (value < config.optimalMin || value > config.optimalMax) {
    return 'WARNING';
  }
  return 'OPTIMAL';
}

function calculateGaugePercent(value: number | undefined, config: ParameterConfig): number {
  // BUG-L4: null is not in the type union — removed dead null check
  if (value === undefined) return 0;

  const range = config.criticalMax - config.criticalMin;
  const normalizedValue = Math.max(config.criticalMin, Math.min(config.criticalMax, value));
  return ((normalizedValue - config.criticalMin) / range) * 100;
}

// ============================================================================
// Circular Gauge Component
// ============================================================================

interface CircularGaugeProps {
  value: number | undefined;
  status: WaterQualityStatus;
  size?: number;
}

const CircularGauge: React.FC<CircularGaugeProps> = ({ value, status, size = 80 }) => {
  const config = statusConfig[status];
  const strokeWidth = 6;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const percent = value !== undefined ? Math.min(100, Math.max(0, value)) : 0;
  const strokeDashoffset = circumference - (percent / 100) * circumference;

  const strokeColor = {
    OPTIMAL: colors.success[500],
    ACCEPTABLE: colors.info[500],
    WARNING: colors.warning[500],
    CRITICAL: colors.error[500],
    UNKNOWN: colors.neutral[400],
  }[status];

  return (
    <svg width={size} height={size} className="transform -rotate-90">
      {/* Background circle */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={chartChrome.grid}
        strokeWidth={strokeWidth}
      />
      {/* Progress circle */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={strokeDashoffset}
        strokeLinecap="round"
        className="transition-all duration-500"
      />
    </svg>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const WaterQualityGauge: React.FC<WaterQualityGaugeProps> = ({
  data,
  isLoading = false,
  error = null,
  tankName,
  onClick,
  compact = false,
  className = '',
}) => {
  // Overall status config
  const status = data?.overallStatus || 'UNKNOWN';
  const config = statusConfig[status];

  // Parameter values with status
  const parameterValues = useMemo(() => {
    if (!data) return [];

    return parameters.map((param) => {
      const value = data[param.key];
      const paramStatus = getParameterStatus(value, param);
      const percent = calculateGaugePercent(value, param);

      return {
        ...param,
        value,
        status: paramStatus,
        percent,
        displayValue:
          value !== undefined
            ? value.toFixed(param.decimals) + (param.unit ? ` ${param.unit}` : '')
            : '-',
      };
    });
  }, [data]);

  // BUG-M5: compute aggregate gauge score from actual parameter percentages
  // instead of mapping status strings to arbitrary hardcoded values (100/75/50/25).
  const aggregateGaugePercent = useMemo(() => {
    const known = parameterValues.filter((p) => p.status !== 'UNKNOWN');
    if (known.length === 0) return 0;
    const sum = known.reduce((acc, p) => acc + p.percent, 0);
    return Math.round(sum / known.length);
  }, [parameterValues]);

  // Loading skeleton
  if (isLoading) {
    return (
      <Card className={`p-4 ${className}`}>
        <div className="animate-pulse">
          <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/3 mb-4"></div>
          <div className="flex justify-center mb-4">
            <div className="w-20 h-20 bg-gray-200 dark:bg-gray-700 rounded-full"></div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-16 bg-gray-200 dark:bg-gray-700 rounded"></div>
            ))}
          </div>
        </div>
      </Card>
    );
  }

  // Error state
  if (error) {
    return (
      <Card className={`p-4 ${className}`}>
        <div className="text-center py-4">
          <div className="w-12 h-12 mx-auto mb-2 rounded-full bg-error-100 dark:bg-error-900/40 flex items-center justify-center">
            <CircleAlert
              className="w-6 h-6 text-error-600 dark:text-error-400"
              aria-hidden="true"
            />
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-400">{error}</p>
        </div>
      </Card>
    );
  }

  // No data state
  if (!data) {
    return (
      <Card className={`p-4 ${className}`}>
        <div className="text-center py-8">
          <div className="w-12 h-12 mx-auto mb-2 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
            <Lightbulb className="w-6 h-6 text-gray-500 dark:text-gray-400" aria-hidden="true" />
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400">Su kalitesi verisi yok</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Henüz ölçüm yapılmamış</p>
        </div>
      </Card>
    );
  }

  return (
    <Card
      className={`p-4 ${config.bgColor} ${config.borderColor} border ${onClick ? 'cursor-pointer hover:shadow-md transition-shadow' : ''} ${className}`}
      onClick={onClick}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {tankName || data.tankName || 'Su Kalitesi'}
          </h3>
          {data.measuredAt && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {formatRelativeTime(new Date(data.measuredAt))}
            </p>
          )}
        </div>
        <Badge variant={config.badgeVariant}>{config.label}</Badge>
      </div>

      {/* Main Gauge - Overall Status (BUG-M5: data-driven from parameter averages) */}
      {!compact && (
        <div className="flex justify-center mb-4">
          <div className="relative">
            <CircularGauge
              value={status !== 'UNKNOWN' ? aggregateGaugePercent : undefined}
              status={status}
              size={80}
            />
            <div className="absolute inset-0 flex items-center justify-center">
              <span className={`text-lg font-bold ${config.color}`}>
                {status !== 'UNKNOWN' ? `${aggregateGaugePercent}%` : '-'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Parameter Grid */}
      <div className={`grid ${compact ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-5'} gap-2`}>
        {parameterValues.slice(0, compact ? 3 : 5).map((param) => (
          <div
            key={param.key}
            className={`text-center p-2 rounded-lg ${statusConfig[param.status].bgColor}`}
          >
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">{param.label}</div>
            <div className={`text-sm font-semibold ${statusConfig[param.status].color}`}>
              {param.displayValue}
            </div>
          </div>
        ))}
      </div>

      {/* Alarm Indicator */}
      {data.hasAlarm && (
        <div className="mt-3 flex items-center gap-2 text-error-600 dark:text-error-400">
          <TriangleAlert className="w-4 h-4 animate-pulse" aria-hidden="true" />
          <span className="text-xs font-medium">Aktif alarm</span>
        </div>
      )}
    </Card>
  );
};

export default WaterQualityGauge;
