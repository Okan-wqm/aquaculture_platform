/**
 * Table Widget Content
 *
 * Displays multiple sensors in a table format.
 */

import React from 'react';
import { Circle } from 'lucide-react';
import { WidgetConfig } from '../types';
import { useWidgetData } from '../../../hooks/useWidgetData';
import { DataTable, type DataTableColumn, Spinner } from '@aquaculture/shared-ui';

interface TableWidgetContentProps {
  config: WidgetConfig;
}

export const TableWidgetContent: React.FC<TableWidgetContentProps> = ({ config }) => {
  const { data, loading, error } = useWidgetData(config);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400 text-sm">
        {error}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400 text-sm">
        No data
      </div>
    );
  }

  // Status colors and labels
  const statusConfig = {
    normal: { color: 'bg-success-500', label: 'Normal' },
    warning: { color: 'bg-warning-500', label: 'Warning' },
    critical: { color: 'bg-error-500', label: 'Critical' },
    offline: { color: 'bg-gray-400', label: 'Offline' },
  };

  type TableReading = (typeof data)[number];
  const tableReadingColumns: DataTableColumn<TableReading>[] = [
    {
      key: 'sensor',
      header: 'Sensor',
      render: (_value, reading) => {
        const status = statusConfig[reading.status] || statusConfig.normal;
        return (
          <div className="flex items-center">
            <Circle size={8} className={`${status.color} rounded-full mr-2`} fill="currentColor" />
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {reading.sensorName}
            </span>
          </div>
        );
      },
    },
    {
      key: 'value',
      header: 'Value',
      align: 'right',
      render: (_value, reading) => (
        <>
          <span className="text-sm font-bold text-gray-900 dark:text-gray-100">
            {reading.value.toFixed(config.settings?.decimalPlaces ?? 1)}
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400 ml-1">{reading.unit}</span>
        </>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      align: 'center',
      render: (_value, reading) => {
        const status = statusConfig[reading.status] || statusConfig.normal;
        return (
          <>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${getStatusBgClass(
                reading.status,
              )}`}
            >
              {status.label}
            </span>
          </>
        );
      },
    },
    {
      key: 'updated',
      header: 'Updated',
      align: 'right',
      render: (_value, reading) => {
        const timeSince = formatTimeSince(reading.timestamp);
        return <>{timeSince}</>;
      },
    },
  ];

  return (
    <div className="h-full overflow-auto">
      <DataTable<TableReading>
        data={data}
        columns={tableReadingColumns}
        keyExtractor={(reading) => reading.sensorId}
        emptyMessage="No data"
        searchable={false}
        sortable={false}
        stickyHeader={false}
        compact
      />
    </div>
  );
};

// Get background class for status badge
function getStatusBgClass(status: string): string {
  switch (status) {
    case 'normal':
      return 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200';
    case 'warning':
      return 'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200';
    case 'critical':
      return 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200';
    case 'offline':
      return 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200';
    default:
      return 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200';
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
