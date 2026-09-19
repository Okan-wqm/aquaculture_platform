/**
 * Device Status Card Component
 *
 * Industrial IoT device status display with health metrics
 * IEC 62443 compliant device lifecycle visualization
 */

import React from 'react';
import { Button } from '@aquaculture/shared-ui';
import {
  Cpu,
  HardDrive,
  MemoryStick,
  Thermometer,
  Wifi,
  WifiOff,
  Settings,
  Eye,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  Clock,
  Activity,
  Server,
} from 'lucide-react';
import {
  EdgeDevice,
  DeviceLifecycleState,
  getDeviceStatusColor,
  getDeviceStatusText,
  getDeviceModelText,
  formatLastSeen,
  getHealthStatus,
} from '../../hooks/useEdgeDevices';

interface DeviceStatusCardProps {
  device: EdgeDevice;
  onConfigure?: (device: EdgeDevice) => void;
  onViewDetail?: (device: EdgeDevice) => void;
  onReboot?: (device: EdgeDevice) => void;
  compact?: boolean;
}

/**
 * Progress bar component for health metrics
 */
const ProgressBar: React.FC<{
  value: number;
  label: string;
  icon: React.ReactNode;
  unit?: string;
  warning?: number;
  critical?: number;
}> = ({ value, label, icon, unit = '%', warning = 70, critical = 90 }) => {
  const getColor = () => {
    if (value >= critical) return 'bg-red-500';
    if (value >= warning) return 'bg-yellow-500';
    return 'bg-green-500';
  };

  return (
    <div className="flex items-center gap-2">
      <div className="text-gray-500 dark:text-gray-400 w-5">{icon}</div>
      <div className="flex-1">
        <div className="flex justify-between text-xs mb-1">
          <span className="text-gray-500 dark:text-gray-400">{label}</span>
          <span className="text-gray-700 dark:text-gray-300 font-medium">
            {value !== undefined ? `${value}${unit}` : 'N/A'}
          </span>
        </div>
        <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
          <div
            className={`h-full ${getColor()} transition-all duration-300`}
            style={{ width: `${Math.min(100, value || 0)}%` }}
          />
        </div>
      </div>
    </div>
  );
};

/**
 * Online status indicator
 */
const OnlineIndicator: React.FC<{ isOnline: boolean; connectionQuality?: number }> = ({
  isOnline,
  connectionQuality,
}) => {
  if (isOnline) {
    return (
      <div className="flex items-center gap-1">
        <div className="relative">
          <Wifi size={16} className="text-green-500" />
          <span className="absolute -top-1 -right-1 w-2 h-2 bg-green-500 rounded-full animate-pulse" />
        </div>
        {connectionQuality !== undefined && (
          <span className="text-xs text-gray-500 dark:text-gray-400">{connectionQuality}%</span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <WifiOff size={16} className="text-gray-500 dark:text-gray-400" />
    </div>
  );
};

/**
 * Device lifecycle state badge
 */
const StateBadge: React.FC<{ state: DeviceLifecycleState }> = ({ state }) => {
  const color = getDeviceStatusColor(state);
  const text = getDeviceStatusText(state);

  const colorClasses: Record<string, string> = {
    green: 'bg-green-100 text-green-800 border-green-200',
    gray: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 border-gray-200 dark:border-gray-700',
    yellow: 'bg-yellow-100 text-yellow-800 border-yellow-200',
    red: 'bg-red-100 text-red-800 border-red-200',
    blue: 'bg-blue-100 text-blue-800 border-blue-200',
  };

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
        colorClasses[color] || colorClasses.gray
      }`}
    >
      {state === DeviceLifecycleState.ACTIVE && (
        <CheckCircle size={10} className="mr-1" />
      )}
      {state === DeviceLifecycleState.ERROR && (
        <AlertTriangle size={10} className="mr-1" />
      )}
      {state === DeviceLifecycleState.MAINTENANCE && (
        <Settings size={10} className="mr-1 animate-spin-slow" />
      )}
      {text}
    </span>
  );
};

/**
 * Health status indicator
 */
const HealthIndicator: React.FC<{ device: EdgeDevice }> = ({ device }) => {
  const health = getHealthStatus(device);

  const config = {
    good: { icon: CheckCircle, color: 'text-green-500', label: 'Healthy' },
    warning: { icon: AlertTriangle, color: 'text-yellow-500', label: 'Warning' },
    critical: { icon: AlertTriangle, color: 'text-red-500', label: 'Critical' },
  }[health];

  const Icon = config.icon;

  return (
    <div className={`flex items-center gap-1 ${config.color}`}>
      <Icon size={14} />
      <span className="text-xs font-medium">{config.label}</span>
    </div>
  );
};

/**
 * Main Device Status Card Component
 */
export const DeviceStatusCard: React.FC<DeviceStatusCardProps> = ({
  device,
  onConfigure,
  onViewDetail,
  onReboot,
  compact = false,
}) => {
  if (compact) {
    return (
      <div
        className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-3 hover:shadow-md transition-shadow cursor-pointer"
        onClick={() => onViewDetail?.(device)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gray-100 dark:bg-gray-800 rounded-lg flex items-center justify-center">
              <Server size={20} className="text-gray-500 dark:text-gray-400" />
            </div>
            <div>
              <div className="font-medium text-gray-900 dark:text-gray-100">{device.deviceCode}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">{device.deviceName}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <OnlineIndicator isOnline={device.isOnline} />
            <StateBadge state={device.lifecycleState} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm hover:shadow-md transition-shadow">
      {/* Header */}
      <div className="p-4 border-b border-gray-100 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-gradient-to-br from-cyan-500 to-blue-600 rounded-lg flex items-center justify-center">
              <Server size={24} className="text-white" />
            </div>
            <div>
              <div className="font-semibold text-gray-900 dark:text-gray-100">{device.deviceCode}</div>
              <div className="text-sm text-gray-500 dark:text-gray-400">{device.deviceName}</div>
            </div>
          </div>
          <OnlineIndicator
            isOnline={device.isOnline}
            connectionQuality={device.connectionQuality}
          />
        </div>
      </div>

      {/* Status Row */}
      <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800 border-b border-gray-100 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <StateBadge state={device.lifecycleState} />
          <HealthIndicator device={device} />
        </div>
      </div>

      {/* Device Info */}
      <div className="p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
          <div>
            <span className="text-gray-500 dark:text-gray-400">Model:</span>
            <span className="ml-1 font-medium text-gray-700 dark:text-gray-300">
              {getDeviceModelText(device.deviceModel)}
            </span>
          </div>
          <div>
            <span className="text-gray-500 dark:text-gray-400">Firmware:</span>
            <span className="ml-1 font-medium text-gray-700 dark:text-gray-300">
              {device.firmwareVersion || 'N/A'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
          <Clock size={12} />
          <span>Last seen: {formatLastSeen(device.lastSeenAt)}</span>
        </div>

        {/* Health Metrics */}
        {device.isOnline && (
          <div className="space-y-2 pt-2 border-t border-gray-100 dark:border-gray-700">
            <ProgressBar
              value={device.cpuUsage || 0}
              label="CPU"
              icon={<Cpu size={14} />}
            />
            <ProgressBar
              value={device.memoryUsage || 0}
              label="Memory"
              icon={<MemoryStick size={14} />}
            />
            <ProgressBar
              value={device.storageUsage || 0}
              label="Storage"
              icon={<HardDrive size={14} />}
            />
            {device.temperatureCelsius != null && (
              <div className="flex items-center gap-2">
                <div className="text-gray-500 dark:text-gray-400 w-5">
                  <Thermometer size={14} />
                </div>
                <div className="flex-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500 dark:text-gray-400">Temperature</span>
                    <span
                      className={`font-medium ${
                        device.temperatureCelsius > 70
                          ? 'text-red-500'
                          : device.temperatureCelsius > 55
                          ? 'text-yellow-500'
                          : 'text-gray-700 dark:text-gray-300'
                      }`}
                    >
                      {device.temperatureCelsius.toFixed(1)}°C
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Stats Summary */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2 border-t border-gray-100 dark:border-gray-700">
          <div className="text-center">
            <div className="text-lg font-semibold text-cyan-600">
              {device.sensorCount ?? 0}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">Sensors</div>
          </div>
          <div className="text-center">
            <div className="text-lg font-semibold text-blue-600">
              {device.programCount ?? 0}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">Programs</div>
          </div>
          <div className="text-center">
            <div
              className={`text-lg font-semibold ${
                (device.activeAlarmCount ?? 0) > 0 ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'
              }`}
            >
              {device.activeAlarmCount ?? 0}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">Alarms</div>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800 border-t border-gray-100 dark:border-gray-700 flex gap-2">
        <Button variant="secondary" size="sm" className="flex-1 justify-center" leftIcon={<Settings size={14} />} onClick={() => onConfigure?.(device)}>Configure</Button>
        <Button variant="primary" size="sm" className="flex-1 justify-center" leftIcon={<Eye size={14} />} onClick={() => onViewDetail?.(device)}>Detail</Button>
        {device.isOnline && (
          <Button variant="secondary" size="sm" iconOnly aria-label="Reboot Device" className="justify-center" onClick={() => onReboot?.(device)} title="Reboot Device"><RefreshCw size={14} /></Button>
        )}
      </div>
    </div>
  );
};

export default DeviceStatusCard;
