/**
 * Table Widget Content
 *
 * Displays multiple sensors in a table format.
 */

import React from 'react';
import { Circle } from 'lucide-react';
import { WidgetConfig } from '../types';
import { useWidgetData } from '../../../hooks/useWidgetData';

interface TableWidgetContentProps {
  config: WidgetConfig;
}

export const TableWidgetContent: React.FC<TableWidgetContentProps> = ({
  config,
}) => {
  const { data, loading, error } = useWidgetData(config);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        {error}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        No data
      </div>
    );
  }

  // Status colors and labels
  const statusConfig = {
    normal: { color: 'bg-green-500', label: 'Normal' },
    warning: { color: 'bg-yellow-500', label: 'Warning' },
    critical: { color: 'bg-red-500', label: 'Critical' },
    offline: { color: 'bg-gray-400', label: 'Offline' },
  };

  return (
    <div className="h-full overflow-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50 sticky top-0">
          <tr>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Sensor
            </th>
            <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
              Value
            </th>
            <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
              Status
            </th>
            <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
              Updated
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {data.map((reading) => {
            const status = statusConfig[reading.status] || statusConfig.normal;
            const timeSince = formatTimeSince(reading.timestamp);

            return (
              <tr key={reading.sensorId} className="hover:bg-gray-50">
                <td className="px-3 py-2 whitespace-nowrap">
                  <div className="flex items-center">
                    <Circle
                      size={8}
                      className={`${status.color} rounded-full mr-2`}
                      fill="currentColor"
                    />
                    <span className="text-sm font-medium text-gray-900">
                      {reading.sensorName}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-right">
                  <span className="text-sm font-bold text-gray-900">
                    {reading.value.toFixed(config.settings?.decimalPlaces ?? 1)}
                  </span>
                  <span className="text-xs text-gray-500 ml-1">
                    {reading.unit}
                  </span>
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-center">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${getStatusBgClass(
                      reading.status
                    )}`}
                  >
                    {status.label}
                  </span>
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-right text-xs text-gray-500">
                  {timeSince}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

// Get background class for status badge
function getStatusBgClass(status: string): string {
  switch (status) {
    case 'normal':
      return 'bg-green-100 text-green-800';
    case 'warning':
      return 'bg-yellow-100 text-yellow-800';
    case 'critical':
      return 'bg-red-100 text-red-800';
    case 'offline':
      return 'bg-gray-100 text-gray-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
}

// Format time since reading
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
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'Just now';
}

export default TableWidgetContent;
