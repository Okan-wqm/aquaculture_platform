/**
 * Status Widget Component
 * Displays sensor status as a compact indicator with icon
 */

import React from 'react';
import {
  CheckCircle,
  AlertTriangle,
  XCircle,
  WifiOff,
  Thermometer,
  Droplets,
  Gauge,
  Wind,
  Waves,
  Activity,
} from 'lucide-react';
import { SensorReading, SensorStatus, SensorType } from '../../../store/scadaStore';

interface StatusWidgetProps {
  reading: SensorReading;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'icon' | 'badge' | 'full';
  className?: string;
}

const sizeConfig = {
  sm: { iconSize: 14, fontSize: 'text-xs', padding: 'p-1' },
  md: { iconSize: 18, fontSize: 'text-sm', padding: 'p-2' },
  lg: { iconSize: 24, fontSize: 'text-base', padding: 'p-3' },
};

const statusConfig: Record<SensorStatus, { icon: React.FC<{ size?: number; className?: string }>; color: string; bg: string; label: string }> = {
  normal: {
    icon: CheckCircle,
    color: 'text-green-600',
    bg: 'bg-green-100',
    label: 'Normal',
  },
  warning: {
    icon: AlertTriangle,
    color: 'text-yellow-600',
    bg: 'bg-yellow-100',
    label: 'Warning',
  },
  critical: {
    icon: XCircle,
    color: 'text-red-600',
    bg: 'bg-red-100',
    label: 'Critical',
  },
  offline: {
    icon: WifiOff,
    color: 'text-gray-500',
    bg: 'bg-gray-100',
    label: 'Offline',
  },
};

const typeIcons: Record<SensorType, React.FC<{ size?: number; className?: string }>> = {
  temperature: Thermometer,
  ph: Gauge,
  dissolved_oxygen: Droplets,
  salinity: Waves,
  ammonia: Activity,
  nitrite: Activity,
  nitrate: Activity,
  turbidity: Wind,
  water_level: Waves,
};

export const StatusWidget: React.FC<StatusWidgetProps> = ({
  reading,
  size = 'md',
  variant = 'badge',
  className = '',
}) => {
  const config = sizeConfig[size];
  const statusCfg = statusConfig[reading.status];
  const StatusIcon = statusCfg.icon;
  const TypeIcon = typeIcons[reading.type] || Activity;

  // Icon only variant
  if (variant === 'icon') {
    return (
      <div
        className={`
          inline-flex items-center justify-center
          rounded-full ${statusCfg.bg} ${config.padding}
          ${className}
        `}
        title={`${reading.type}: ${reading.value}${reading.unit} (${reading.status})`}
      >
        <StatusIcon size={config.iconSize} className={statusCfg.color} />
      </div>
    );
  }

  // Badge variant
  if (variant === 'badge') {
    return (
      <div
        className={`
          inline-flex items-center gap-1.5
          rounded-full ${statusCfg.bg} ${config.padding} px-2
          ${className}
        `}
      >
        <TypeIcon size={config.iconSize - 2} className={statusCfg.color} />
        <span className={`${config.fontSize} font-medium ${statusCfg.color}`}>
          {reading.value.toFixed(1)}
        </span>
        <span className={`${config.fontSize} text-gray-500`}>{reading.unit}</span>
        <StatusIcon
          size={config.iconSize - 4}
          className={`${statusCfg.color} ${
            reading.status !== 'normal' && reading.status !== 'offline' ? 'animate-pulse' : ''
          }`}
        />
      </div>
    );
  }

  // Full variant
  return (
    <div
      className={`
        rounded-lg border ${statusCfg.bg} border-opacity-50
        ${config.padding} ${className}
        flex items-center gap-3
      `}
    >
      {/* Type icon */}
      <div className={`p-2 rounded-lg ${statusCfg.bg}`}>
        <TypeIcon size={config.iconSize} className={statusCfg.color} />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className={`${config.fontSize} text-gray-500 capitalize`}>
          {reading.type.replace('_', ' ')}
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-lg font-bold text-gray-900`}>
            {reading.value.toFixed(1)}
          </span>
          <span className="text-sm text-gray-500">{reading.unit}</span>
        </div>
      </div>

      {/* Status icon */}
      <div
        className={`
          flex flex-col items-center gap-1
          ${reading.status !== 'normal' && reading.status !== 'offline' ? 'animate-pulse' : ''}
        `}
      >
        <StatusIcon size={config.iconSize} className={statusCfg.color} />
        <span className={`text-xs ${statusCfg.color} font-medium`}>
          {statusCfg.label}
        </span>
      </div>
    </div>
  );
};

export default StatusWidget;
