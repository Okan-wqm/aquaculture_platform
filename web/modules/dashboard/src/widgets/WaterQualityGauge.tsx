/**
 * Water Quality Gauge Widget
 *
 * Displays water quality parameters with circular gauge visualization.
 * Shows overall status and key parameters (temperature, DO, pH, ammonia, nitrite).
 */

import React, { useMemo } from 'react';
import { Card, Badge, formatRelativeTime } from '@aquaculture/shared-ui';

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
    color: 'text-green-600',
    bgColor: 'bg-green-50',
    borderColor: 'border-green-200',
    label: 'Optimal',
    badgeVariant: 'success',
  },
  ACCEPTABLE: {
    color: 'text-blue-600',
    bgColor: 'bg-blue-50',
    borderColor: 'border-blue-200',
    label: 'Kabul Edilebilir',
    badgeVariant: 'info',
  },
  WARNING: {
    color: 'text-yellow-600',
    bgColor: 'bg-yellow-50',
    borderColor: 'border-yellow-200',
    label: 'Dikkat',
    badgeVariant: 'warning',
  },
  CRITICAL: {
    color: 'text-red-600',
    bgColor: 'bg-red-50',
    borderColor: 'border-red-200',
    label: 'Kritik',
    badgeVariant: 'error',
  },
  UNKNOWN: {
    color: 'text-gray-600',
    bgColor: 'bg-gray-50',
    borderColor: 'border-gray-200',
    label: 'Bilinmiyor',
    badgeVariant: 'default',
  },
};

// ============================================================================
// Parameter Configuration
// ============================================================================

interface ParameterConfig {
  key: keyof Pick<WaterQualityData, 'temperature' | 'dissolvedOxygen' | 'pH' | 'ammonia' | 'nitrite'>;
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
    label: 'Sicaklik',
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
  if (value === undefined || value === null) return 'UNKNOWN';

  if (value < config.criticalMin || value > config.criticalMax) {
    return 'CRITICAL';
  }
  if (value < config.optimalMin || value > config.optimalMax) {
    return 'WARNING';
  }
  return 'OPTIMAL';
}

function calculateGaugePercent(
  value: number | undefined,
  config: ParameterConfig,
): number {
  if (value === undefined || value === null) return 0;

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
    OPTIMAL: '#22c55e',
    ACCEPTABLE: '#3b82f6',
    WARNING: '#eab308',
    CRITICAL: '#ef4444',
    UNKNOWN: '#9ca3af',
  }[status];

  return (
    <svg width={size} height={size} className="transform -rotate-90">
      {/* Background circle */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="#e5e7eb"
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
          value !== undefined ? value.toFixed(param.decimals) + (param.unit ? ` ${param.unit}` : '') : '-',
      };
    });
  }, [data]);

  // Loading skeleton
  if (isLoading) {
    return (
      <Card className={`p-4 ${className}`}>
        <div className="animate-pulse">
          <div className="h-4 bg-gray-200 rounded w-1/3 mb-4"></div>
          <div className="flex justify-center mb-4">
            <div className="w-20 h-20 bg-gray-200 rounded-full"></div>
          </div>
          <div className="grid grid-cols-5 gap-2">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-16 bg-gray-200 rounded"></div>
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
          <div className="w-12 h-12 mx-auto mb-2 rounded-full bg-red-100 flex items-center justify-center">
            <svg className="w-6 h-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p className="text-sm text-gray-600">{error}</p>
        </div>
      </Card>
    );
  }

  // No data state
  if (!data) {
    return (
      <Card className={`p-4 ${className}`}>
        <div className="text-center py-8">
          <div className="w-12 h-12 mx-auto mb-2 rounded-full bg-gray-100 flex items-center justify-center">
            <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
          </div>
          <p className="text-sm text-gray-500">Su kalitesi verisi yok</p>
          <p className="text-xs text-gray-400 mt-1">Henuz olcum yapilmamis</p>
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
          <h3 className="text-sm font-medium text-gray-900">
            {tankName || data.tankName || 'Su Kalitesi'}
          </h3>
          {data.measuredAt && (
            <p className="text-xs text-gray-500">
              {formatRelativeTime(new Date(data.measuredAt))}
            </p>
          )}
        </div>
        <Badge variant={config.badgeVariant}>
          {config.label}
        </Badge>
      </div>

      {/* Main Gauge - Overall Status */}
      {!compact && (
        <div className="flex justify-center mb-4">
          <div className="relative">
            <CircularGauge
              value={status === 'OPTIMAL' ? 100 : status === 'ACCEPTABLE' ? 75 : status === 'WARNING' ? 50 : status === 'CRITICAL' ? 25 : 0}
              status={status}
              size={80}
            />
            <div className="absolute inset-0 flex items-center justify-center">
              <span className={`text-lg font-bold ${config.color}`}>
                {status === 'OPTIMAL' ? '100%' : status === 'ACCEPTABLE' ? '75%' : status === 'WARNING' ? '50%' : status === 'CRITICAL' ? '25%' : '-'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Parameter Grid */}
      <div className={`grid ${compact ? 'grid-cols-3' : 'grid-cols-5'} gap-2`}>
        {parameterValues.slice(0, compact ? 3 : 5).map((param) => (
          <div
            key={param.key}
            className={`text-center p-2 rounded-lg ${statusConfig[param.status].bgColor}`}
          >
            <div className="text-xs text-gray-500 mb-1">{param.label}</div>
            <div className={`text-sm font-semibold ${statusConfig[param.status].color}`}>
              {param.displayValue}
            </div>
          </div>
        ))}
      </div>

      {/* Alarm Indicator */}
      {data.hasAlarm && (
        <div className="mt-3 flex items-center gap-2 text-red-600">
          <svg className="w-4 h-4 animate-pulse" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          <span className="text-xs font-medium">Aktif alarm</span>
        </div>
      )}
    </Card>
  );
};

export default WaterQualityGauge;
