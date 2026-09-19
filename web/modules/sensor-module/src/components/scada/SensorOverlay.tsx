/**
 * Sensor Overlay Component
 *
 * Equipment node üzerinde konumlandırılmış sensör değer gösterimi.
 * Normal/Warning/Critical durumlarına göre renklendirme.
 */

import React, { useMemo } from 'react';
import {
  Thermometer,
  Droplets,
  Gauge,
  Activity,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
  AlertCircle,
} from 'lucide-react';
import { SensorReading, SensorStatus, SensorType } from '../../store/scadaViewerStore';

// ============================================================================
// Types
// ============================================================================

interface SensorOverlayProps {
  readings: SensorReading[];
  equipmentId: string;
  maxVisible?: number;
  compact?: boolean;
}

interface SensorValueDisplayProps {
  reading: SensorReading;
  compact?: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

const getTypeIcon = (type: SensorType, className: string = 'w-3 h-3') => {
  const icons: Record<SensorType, React.ReactNode> = {
    temperature: <Thermometer className={className} />,
    ph: <Gauge className={className} />,
    dissolved_oxygen: <Droplets className={className} />,
    salinity: <Activity className={className} />,
    ammonia: <Activity className={className} />,
    nitrite: <Activity className={className} />,
    nitrate: <Activity className={className} />,
    turbidity: <Activity className={className} />,
    water_level: <Activity className={className} />,
    multi_parameter: <Gauge className={className} />,
    flow_rate: <Activity className={className} />,
    conductivity: <Activity className={className} />,
    orp: <Gauge className={className} />,
    chlorine: <Droplets className={className} />,
    co2: <Activity className={className} />,
  };
  return icons[type] || <Activity className={className} />;
};

const getTrendIcon = (trend: 'up' | 'down' | 'stable') => {
  switch (trend) {
    case 'up':
      return <TrendingUp className="w-2.5 h-2.5 text-success-500" />;
    case 'down':
      return <TrendingDown className="w-2.5 h-2.5 text-error-500" />;
    default:
      return <Minus className="w-2.5 h-2.5 text-gray-500 dark:text-gray-400" />;
  }
};

const getStatusConfig = (status: SensorStatus) => {
  const configs: Record<
    SensorStatus,
    { bg: string; border: string; text: string; icon?: React.ReactNode }
  > = {
    normal: {
      bg: 'bg-success-50 dark:bg-success-900/20',
      border: 'border-success-300 dark:border-success-700',
      text: 'text-success-700 dark:text-success-300',
    },
    warning: {
      bg: 'bg-warning-50 dark:bg-warning-900/20',
      border: 'border-warning-400',
      text: 'text-warning-700 dark:text-warning-300',
      icon: <AlertTriangle className="w-3 h-3" />,
    },
    critical: {
      bg: 'bg-error-50 dark:bg-error-900/20',
      border: 'border-error-400',
      text: 'text-error-700 dark:text-error-300',
      icon: <AlertCircle className="w-3 h-3" />,
    },
    offline: {
      bg: 'bg-gray-100 dark:bg-gray-800',
      border: 'border-gray-300 dark:border-gray-600',
      text: 'text-gray-500 dark:text-gray-400',
    },
  };
  return configs[status];
};

const formatValue = (value: number, type: SensorType): string => {
  // Different precision for different types
  switch (type) {
    case 'ph':
      return value.toFixed(2);
    case 'temperature':
    case 'dissolved_oxygen':
    case 'salinity':
      return value.toFixed(1);
    default:
      return value.toFixed(1);
  }
};

// ============================================================================
// Sensor Value Display Component
// ============================================================================

const SensorValueDisplay: React.FC<SensorValueDisplayProps> = ({ reading, compact = false }) => {
  const statusConfig = getStatusConfig(reading.status);
  const typeIcon = getTypeIcon(reading.type, compact ? 'w-2.5 h-2.5' : 'w-3 h-3');
  const trendIcon = getTrendIcon(reading.trend);

  if (compact) {
    return (
      <div
        className={`
          flex items-center gap-1 px-1.5 py-0.5 rounded
          ${statusConfig.bg} ${statusConfig.border} border
        `}
        title={`${reading.sensorName}: ${formatValue(reading.value, reading.type)} ${reading.unit}`}
      >
        <span className={statusConfig.text}>{typeIcon}</span>
        <span className={`text-[10px] font-medium ${statusConfig.text}`}>
          {formatValue(reading.value, reading.type)}
        </span>
        {reading.status !== 'normal' && statusConfig.icon && (
          <span className={statusConfig.text}>{statusConfig.icon}</span>
        )}
      </div>
    );
  }

  return (
    <div
      className={`
        flex items-center gap-2 px-2 py-1 rounded-lg shadow-sm
        ${statusConfig.bg} ${statusConfig.border} border
        transition-all duration-200
      `}
    >
      <span className={statusConfig.text}>{typeIcon}</span>
      <div className="flex-1 min-w-0">
        <p className={`text-[10px] ${statusConfig.text} truncate`}>{reading.sensorName}</p>
        <div className="flex items-center gap-1">
          <span className={`text-sm font-semibold ${statusConfig.text}`}>
            {formatValue(reading.value, reading.type)}
          </span>
          <span className={`text-[10px] ${statusConfig.text} opacity-70`}>{reading.unit}</span>
          {trendIcon}
        </div>
      </div>
      {reading.status !== 'normal' && statusConfig.icon && (
        <span className={`${statusConfig.text} animate-pulse`}>{statusConfig.icon}</span>
      )}
    </div>
  );
};

// ============================================================================
// Sensor Overlay Component
// ============================================================================

export const SensorOverlay: React.FC<SensorOverlayProps> = ({
  readings,
  equipmentId,
  maxVisible = 4,
  compact = false,
}) => {
  // Sort readings by priority: critical > warning > normal
  const sortedReadings = useMemo(() => {
    return [...readings].sort((a, b) => {
      const priority: Record<SensorStatus, number> = {
        critical: 0,
        warning: 1,
        offline: 2,
        normal: 3,
      };
      return priority[a.status] - priority[b.status];
    });
  }, [readings]);

  const visibleReadings = sortedReadings.slice(0, maxVisible);
  const hiddenCount = sortedReadings.length - maxVisible;
  const hasCritical = sortedReadings.some((r) => r.status === 'critical');
  const hasWarning = sortedReadings.some((r) => r.status === 'warning');

  if (readings.length === 0) {
    return null;
  }

  return (
    <div className="sensor-overlay absolute -right-2 top-0 z-10 pointer-events-none">
      <div className="flex flex-col gap-1 items-end">
        {visibleReadings.map((reading) => (
          <SensorValueDisplay key={reading.id} reading={reading} compact={compact} />
        ))}

        {hiddenCount > 0 && (
          <div
            className={`
              px-1.5 py-0.5 rounded text-[10px] font-medium
              ${
                hasCritical
                  ? 'bg-error-100 dark:bg-error-900/40 text-error-700 dark:text-error-300'
                  : hasWarning
                    ? 'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300'
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
              }
            `}
          >
            +{hiddenCount} more
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// Inline Sensor Badge (for use inside equipment card)
// ============================================================================

interface SensorBadgeProps {
  reading: SensorReading;
}

export const SensorBadge: React.FC<SensorBadgeProps> = ({ reading }) => {
  const statusConfig = getStatusConfig(reading.status);
  const typeIcon = getTypeIcon(reading.type, 'w-3 h-3');

  return (
    <div
      className={`
        inline-flex items-center gap-1.5 px-2 py-1 rounded
        ${statusConfig.bg} ${statusConfig.border} border
      `}
    >
      <span className={statusConfig.text}>{typeIcon}</span>
      <span className={`text-xs font-medium ${statusConfig.text}`}>
        {formatValue(reading.value, reading.type)} {reading.unit}
      </span>
    </div>
  );
};

// ============================================================================
// Sensor Summary Bar (horizontal bar showing all sensors for an equipment)
// ============================================================================

interface SensorSummaryBarProps {
  readings: SensorReading[];
  onClick?: () => void;
}

export const SensorSummaryBar: React.FC<SensorSummaryBarProps> = ({ readings, onClick }) => {
  const hasCritical = readings.some((r) => r.status === 'critical');
  const hasWarning = readings.some((r) => r.status === 'warning');
  const allNormal = !hasCritical && !hasWarning;

  return (
    <button
      onClick={onClick}
      className={`
        flex items-center gap-2 px-3 py-1.5 rounded-lg
        border transition-all
        ${
          hasCritical
            ? 'bg-error-50 dark:bg-error-900/20 border-error-300 dark:border-error-700 hover:bg-error-100 dark:hover:bg-error-900/50'
            : hasWarning
              ? 'bg-warning-50 dark:bg-warning-900/20 border-warning-300 dark:border-warning-700 hover:bg-warning-100 dark:hover:bg-warning-900/50'
              : 'bg-success-50 dark:bg-success-900/20 border-success-300 dark:border-success-700 hover:bg-success-100 dark:hover:bg-success-900/50'
        }
      `}
    >
      <Activity
        className={`w-4 h-4 ${
          hasCritical
            ? 'text-error-600 dark:text-error-400'
            : hasWarning
              ? 'text-warning-600 dark:text-warning-400'
              : 'text-success-600 dark:text-success-400'
        }`}
      />
      <span
        className={`text-sm font-medium ${
          hasCritical
            ? 'text-error-700 dark:text-error-300'
            : hasWarning
              ? 'text-warning-700 dark:text-warning-300'
              : 'text-success-700 dark:text-success-300'
        }`}
      >
        {readings.length} sensör
      </span>
      {(hasCritical || hasWarning) && (
        <span
          className={`text-xs px-1.5 py-0.5 rounded ${
            hasCritical
              ? 'bg-error-200 dark:bg-error-800/50 text-error-800 dark:text-error-200'
              : 'bg-warning-200 dark:bg-warning-800/50 text-warning-800 dark:text-warning-200'
          }`}
        >
          {hasCritical ? 'Kritik' : 'Uyarı'}
        </span>
      )}
    </button>
  );
};

export default SensorOverlay;
