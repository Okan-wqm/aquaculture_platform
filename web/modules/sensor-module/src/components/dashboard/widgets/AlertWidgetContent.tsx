/**
 * Alert Widget Content
 * Displays active alarms from the sensor system with severity badges and acknowledge capability.
 */

import React from 'react';
import { AlertTriangle, AlertCircle, Info, Zap, Bell, CheckCircle, WifiOff } from 'lucide-react';
import { WidgetConfig } from '../types';
import { useWidgetData, WidgetDataPoint } from '../../../hooks/useWidgetData';
import { Spinner } from '@aquaculture/shared-ui';

interface AlertWidgetContentProps {
  config: WidgetConfig;
}

// Alert severity styles
const severityConfig = {
  EMERGENCY: {
    icon: Zap,
    bg: 'bg-error-100 dark:bg-error-900/40',
    text: 'text-error-800 dark:text-error-200',
    border: 'border-error-300 dark:border-error-700',
    badge: 'bg-error-600 text-white',
  },
  CRITICAL: {
    icon: AlertCircle,
    bg: 'bg-warning-100 dark:bg-warning-900/40',
    text: 'text-warning-800 dark:text-warning-200',
    border: 'border-warning-300 dark:border-warning-700',
    badge: 'bg-warning-500 text-white',
  },
  WARNING: {
    icon: AlertTriangle,
    bg: 'bg-warning-100 dark:bg-warning-900/40',
    text: 'text-warning-800 dark:text-warning-200',
    border: 'border-warning-300 dark:border-warning-700',
    badge: 'bg-warning-500 text-white',
  },
  OFFLINE: {
    icon: WifiOff,
    bg: 'bg-gray-100 dark:bg-gray-800',
    text: 'text-gray-800 dark:text-gray-200',
    border: 'border-gray-300 dark:border-gray-600',
    badge: 'bg-gray-600 text-white',
  },
  INFO: {
    icon: Info,
    bg: 'bg-info-100 dark:bg-info-900/40',
    text: 'text-info-800 dark:text-info-200',
    border: 'border-info-300 dark:border-info-700',
    badge: 'bg-info-500 text-white',
  },
};

// Mock alert data structure (in production, this comes from useAlerts hook)
interface AlertItem {
  id: string;
  severity: keyof typeof severityConfig;
  message: string;
  source: string;
  timestamp: Date;
  acknowledged: boolean;
}

export const AlertWidgetContent: React.FC<AlertWidgetContentProps> = ({ config }) => {
  const { data, loading, error } = useWidgetData(config);

  // Transform widget data into alerts, or use the data directly if it's alarm-shaped
  const alerts: AlertItem[] = React.useMemo(() => {
    if (!data || data.length === 0) return [];
    // Widget data is sensor readings — for alert widget, we generate alerts from threshold breaches and offline sensors
    return data
      .filter(
        (reading: WidgetDataPoint) =>
          reading.status === 'critical' ||
          reading.status === 'warning' ||
          reading.status === 'offline',
      )
      .map((reading: WidgetDataPoint): AlertItem => {
        let severity: keyof typeof severityConfig;
        let message: string;

        if (reading.status === 'offline') {
          severity = 'OFFLINE';
          message = `${reading.sensorName || 'Sensor'}: offline — no data received`;
        } else if (reading.status === 'critical') {
          severity = 'CRITICAL';
          message = `${reading.sensorName || 'Sensor'}: ${reading.value}${reading.unit || ''} (threshold exceeded)`;
        } else {
          severity = 'WARNING';
          message = `${reading.sensorName || 'Sensor'}: ${reading.value}${reading.unit || ''} (threshold exceeded)`;
        }

        return {
          id: reading.sensorId,
          severity,
          message,
          source: reading.sensorName || 'Unknown',
          timestamp: reading.timestamp ? new Date(reading.timestamp) : new Date(),
          acknowledged: false,
        };
      })
      .slice(0, 5); // Show last 5
  }, [data]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner size="md" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-error-500 text-sm">{error}</div>
    );
  }

  if (alerts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500 dark:text-gray-400">
        <CheckCircle size={32} className="mb-2 text-success-500" />
        <span className="text-sm font-medium">No Active Alerts</span>
        <span className="text-xs text-gray-400 dark:text-gray-500 mt-1">All systems normal</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Alert count header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <Bell size={14} className="text-gray-500 dark:text-gray-400" />
          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
            {alerts.length} active alert{alerts.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Alert list */}
      <div className="flex-1 overflow-y-auto space-y-1.5">
        {alerts.map((alert) => {
          const sev = severityConfig[alert.severity] || severityConfig.INFO;
          const Icon = sev.icon;

          return (
            <div
              key={alert.id}
              className={`flex items-start gap-2 p-2 rounded-lg border ${sev.bg} ${sev.border}`}
            >
              <Icon size={14} className={`${sev.text} mt-0.5 flex-shrink-0`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${sev.badge}`}>
                    {alert.severity}
                  </span>
                </div>
                <p className={`text-xs ${sev.text} mt-0.5 truncate`}>{alert.message}</p>
                <span className="text-[10px] text-gray-500 dark:text-gray-400">
                  {formatTimeAgo(alert.timestamp)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  if (diff < 0) return 'Just now'; // Handle clock skew
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default AlertWidgetContent;
