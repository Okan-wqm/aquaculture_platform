/**
 * Device Status Card Component
 *
 * Industrial IoT device status display with health metrics
 * IEC 62443 compliant device lifecycle visualization
 */

import React from 'react';
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
      <div className="text-gray-400 w-5">{icon}</div>
      <div className="flex-1">
        <div className="flex justify-between text-xs mb-1">
          <span className="text-gray-500">{label}</span>
          <span className="text-gray-700 font-medium">
            {value !== undefined ? `${value}${unit}` : 'N/A'}
          </span>
        </div>
        <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
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
          <span className="text-xs text-gray-500">{connectionQuality}%</span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <WifiOff size={16} className="text-gray-400" />
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
    gray: 'bg-gray-100 text-gray-800 border-gray-200',
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
        className="bg-white rounded-lg border border-gray-200 p-3 hover:shadow-md transition-shadow cursor-pointer"
        onClick={() => onViewDetail?.(device)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center">
              <Server size={20} className="text-gray-500" />
            </div>
            <div>
              <div className="font-medium text-gray-900">{device.deviceCode}</div>
              <div className="text-xs text-gray-500">{device.deviceName}</div>
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
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-shadow">
      {/* Header */}
      <div className="p-4 border-b border-gray-100">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-gradient-to-br from-cyan-500 to-blue-600 rounded-lg flex items-center justify-center">
              <Server size={24} className="text-white" />
            </div>
            <div>
              <div className="font-semibold text-gray-900">{device.deviceCode}</div>
              <div className="text-sm text-gray-500">{device.deviceName}</div>
            </div>
          </div>
          <OnlineIndicator
            isOnline={device.isOnline}
            connectionQuality={device.connectionQuality}
          />
        </div>
      </div>

      {/* Status Row */}
      <div className="px-4 py-2 bg-gray-50 border-b border-gray-100">
        <div className="flex items-center justify-between">
          <StateBadge state={device.lifecycleState} />
          <HealthIndicator device={device} />
        </div>
      </div>

      {/* Device Info */}
      <div className="p-4 space-y-3">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <span className="text-gray-500">Model:</span>
            <span className="ml-1 font-medium text-gray-700">
              {getDeviceModelText(device.deviceModel)}
            </span>
          </div>
          <div>
            <span className="text-gray-500">Firmware:</span>
            <span className="ml-1 font-medium text-gray-700">
              {device.firmwareVersion || 'N/A'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1 text-xs text-gray-500">
          <Clock size={12} />
          <span>Last seen: {formatLastSeen(device.lastSeenAt)}</span>
        </div>

        {/* Health Metrics */}
        {device.isOnline && (
          <div className="space-y-2 pt-2 border-t border-gray-100">
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
            {device.temperatureCelsius !== undefined && (
              <div className="flex items-center gap-2">
                <div className="text-gray-400 w-5">
                  <Thermometer size={14} />
                </div>
                <div className="flex-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">Temperature</span>
                    <span
                      className={`font-medium ${
                        device.temperatureCelsius > 70
                          ? 'text-red-500'
                          : device.temperatureCelsius > 55
                          ? 'text-yellow-500'
                          : 'text-gray-700'
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
        <div className="grid grid-cols-3 gap-2 pt-2 border-t border-gray-100">
          <div className="text-center">
            <div className="text-lg font-semibold text-cyan-600">
              {device.sensorCount ?? 0}
            </div>
            <div className="text-xs text-gray-500">Sensors</div>
          </div>
          <div className="text-center">
            <div className="text-lg font-semibold text-blue-600">
              {device.programCount ?? 0}
            </div>
            <div className="text-xs text-gray-500">Programs</div>
          </div>
          <div className="text-center">
            <div
              className={`text-lg font-semibold ${
                (device.activeAlarmCount ?? 0) > 0 ? 'text-red-500' : 'text-gray-400'
              }`}
            >
              {device.activeAlarmCount ?? 0}
            </div>
            <div className="text-xs text-gray-500">Alarms</div>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 flex gap-2">
        <button
          onClick={() => onConfigure?.(device)}
          className="flex-1 flex items-center justify-center gap-1 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
        >
          <Settings size={14} />
          Configure
        </button>
        <button
          onClick={() => onViewDetail?.(device)}
          className="flex-1 flex items-center justify-center gap-1 px-3 py-2 text-sm font-medium text-white bg-cyan-600 rounded-lg hover:bg-cyan-700 transition-colors"
        >
          <Eye size={14} />
          Detail
        </button>
        {device.isOnline && (
          <button
            onClick={() => onReboot?.(device)}
            className="flex items-center justify-center px-3 py-2 text-sm font-medium text-gray-500 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            title="Reboot Device"
          >
            <RefreshCw size={14} />
          </button>
        )}
      </div>
    </div>
  );
};

export default DeviceStatusCard;
