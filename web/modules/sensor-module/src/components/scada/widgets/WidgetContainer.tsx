/**
 * Widget Container Component
 * Wrapper for sensor widgets with common styling and behavior
 */

import React from 'react';
import { X, Maximize2, MoreVertical } from 'lucide-react';
import { SensorReading } from '../../../store/scadaStore';
import { GaugeWidget } from './GaugeWidget';
import { NumericWidget } from './NumericWidget';
import { SparklineWidget } from './SparklineWidget';
import { StatusWidget } from './StatusWidget';

export type WidgetType = 'gauge' | 'numeric' | 'sparkline' | 'status';

interface WidgetContainerProps {
  reading: SensorReading;
  type: WidgetType;
  title?: string;
  onRemove?: () => void;
  onExpand?: () => void;
  showHeader?: boolean;
  draggable?: boolean;
  className?: string;
}

export const WidgetContainer: React.FC<WidgetContainerProps> = ({
  reading,
  type,
  title,
  onRemove,
  onExpand,
  showHeader = true,
  draggable = false,
  className = '',
}) => {
  const renderWidget = () => {
    switch (type) {
      case 'gauge':
        return <GaugeWidget reading={reading} size="md" showLabel={!showHeader} />;
      case 'numeric':
        return <NumericWidget reading={reading} size="md" showLabel={!showHeader} />;
      case 'sparkline':
        return <SparklineWidget reading={reading} showLabel={!showHeader} />;
      case 'status':
        return <StatusWidget reading={reading} size="md" variant="full" />;
      default:
        return <NumericWidget reading={reading} size="md" />;
    }
  };

  return (
    <div
      className={`
        bg-white rounded-lg shadow-sm border border-gray-200
        ${draggable ? 'cursor-move' : ''}
        ${className}
      `}
    >
      {/* Header */}
      {showHeader && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
          <div className="flex items-center gap-2">
            {draggable && (
              <MoreVertical size={14} className="text-gray-400 cursor-grab" />
            )}
            <h4 className="text-sm font-medium text-gray-700 truncate">
              {title || reading.type.replace('_', ' ')}
            </h4>
          </div>
          <div className="flex items-center gap-1">
            {onExpand && (
              <button
                onClick={onExpand}
                className="p-1 hover:bg-gray-100 rounded transition-colors"
                title="Expand"
              >
                <Maximize2 size={14} className="text-gray-400" />
              </button>
            )}
            {onRemove && (
              <button
                onClick={onRemove}
                className="p-1 hover:bg-red-50 rounded transition-colors"
                title="Remove"
              >
                <X size={14} className="text-gray-400 hover:text-red-500" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Widget content */}
      <div className="p-3">{renderWidget()}</div>

      {/* Last update */}
      <div className="px-3 pb-2 text-xs text-gray-400 text-right">
        {formatTimestamp(reading.timestamp)}
      </div>
    </div>
  );
};

// Helper function to format timestamp
function formatTimestamp(date: Date): string {
  const now = new Date();
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diff < 5) return 'Şimdi';
  if (diff < 60) return `${diff} sn önce`;
  if (diff < 3600) return `${Math.floor(diff / 60)} dk önce`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} sa önce`;
  return date.toLocaleDateString('tr-TR');
}

// Widget Grid Component for multiple widgets
interface WidgetGridProps {
  readings: SensorReading[];
  defaultType?: WidgetType;
  columns?: 1 | 2 | 3 | 4;
  showHeaders?: boolean;
  className?: string;
}

export const WidgetGrid: React.FC<WidgetGridProps> = ({
  readings,
  defaultType = 'numeric',
  columns = 2,
  showHeaders = false,
  className = '',
}) => {
  const gridCols = {
    1: 'grid-cols-1',
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-4',
  };

  return (
    <div className={`grid ${gridCols[columns]} gap-3 ${className}`}>
      {readings.map((reading) => (
        <WidgetContainer
          key={reading.sensorId}
          reading={reading}
          type={defaultType}
          showHeader={showHeaders}
        />
      ))}
    </div>
  );
};

// Compact widget for node overlay
interface CompactWidgetProps {
  reading: SensorReading;
  className?: string;
}

export const CompactWidget: React.FC<CompactWidgetProps> = ({
  reading,
  className = '',
}) => {
  const statusColors = {
    normal: 'bg-green-100 text-green-700 border-green-200',
    warning: 'bg-yellow-100 text-yellow-700 border-yellow-200',
    critical: 'bg-red-100 text-red-700 border-red-200',
    offline: 'bg-gray-100 text-gray-500 border-gray-200',
  };

  return (
    <div
      className={`
        inline-flex items-center gap-1 px-1.5 py-0.5
        rounded border text-xs font-medium
        ${statusColors[reading.status]}
        ${className}
      `}
      title={`${reading.type}: ${reading.value}${reading.unit}`}
    >
      <span>{reading.value.toFixed(1)}</span>
      <span className="text-gray-500">{reading.unit}</span>
    </div>
  );
};

export default WidgetContainer;
