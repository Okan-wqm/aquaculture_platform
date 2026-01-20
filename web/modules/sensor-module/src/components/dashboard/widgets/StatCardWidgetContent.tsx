/**
 * Stat Card Widget Content
 *
 * Displays min/max/avg statistics for sensor data.
 */

import React, { useMemo, useState, useEffect } from 'react';
import { ArrowUp, ArrowDown, Minus, Activity, Clock } from 'lucide-react';

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
import { WidgetConfig } from '../types';
import { useWidgetData } from '../../../hooks/useWidgetData';

interface StatCardWidgetContentProps {
  config: WidgetConfig;
}

interface StatItem {
  label: string;
  value: number;
  unit: string;
  icon: React.ReactNode;
  color: string;
}

export const StatCardWidgetContent: React.FC<StatCardWidgetContentProps> = ({
  config,
}) => {
  const { data, history, loading, error } = useWidgetData(config);
  const [, forceUpdate] = useState(0);

  // Update time display every second
  useEffect(() => {
    const interval = setInterval(() => forceUpdate((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Calculate statistics from history
  const stats = useMemo(() => {
    if (!history || history.length === 0) {
      return null;
    }

    const values = history.map((h) => h.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;

    // Get current value from data
    const current = data?.[0]?.value ?? avg;
    const unit = data?.[0]?.unit ?? '';

    return {
      current,
      min,
      max,
      avg,
      unit,
      count: values.length,
    };
  }, [data, history]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin w-6 h-6 border-2 border-cyan-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        {error || 'No data'}
      </div>
    );
  }

  const statItems: StatItem[] = [
    {
      label: 'Current',
      value: stats.current,
      unit: stats.unit,
      icon: <Activity size={14} />,
      color: 'text-cyan-600',
    },
    {
      label: 'Min',
      value: stats.min,
      unit: stats.unit,
      icon: <ArrowDown size={14} />,
      color: 'text-blue-600',
    },
    {
      label: 'Max',
      value: stats.max,
      unit: stats.unit,
      icon: <ArrowUp size={14} />,
      color: 'text-red-500',
    },
    {
      label: 'Avg',
      value: stats.avg,
      unit: stats.unit,
      icon: <Minus size={14} />,
      color: 'text-green-600',
    },
  ];

  // Get latest timestamp from data
  const latestTimestamp = data?.[0]?.timestamp;

  return (
    <div className="flex flex-col h-full p-2">
      <div className="grid grid-cols-2 gap-3 flex-1">
        {statItems.map((stat) => (
          <div
            key={stat.label}
            className="flex flex-col items-center justify-center bg-gray-50 rounded-lg p-2"
          >
            <div className={`flex items-center gap-1 ${stat.color}`}>
              {stat.icon}
              <span className="text-xs font-medium">{stat.label}</span>
            </div>
            <div className="mt-1">
              <span className="text-lg font-bold text-gray-900">
                {stat.value.toFixed(config.settings?.decimalPlaces ?? 1)}
              </span>
              <span className="text-xs text-gray-500 ml-1">{stat.unit}</span>
            </div>
          </div>
        ))}
      </div>
      {/* Last update time */}
      {latestTimestamp && (
        <div className="flex items-center justify-center gap-1 text-xs text-gray-400 mt-2 pt-2 border-t border-gray-100">
          <Clock size={10} />
          <span>{formatTimeSince(latestTimestamp)}</span>
        </div>
      )}
    </div>
  );
};

export default StatCardWidgetContent;
