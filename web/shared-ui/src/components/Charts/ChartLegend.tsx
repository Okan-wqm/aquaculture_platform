/**
 * Chart Legend Component
 * Reusable legend for charts
 */

import React from 'react';

export interface LegendItem {
  label: string;
  color: string;
  value?: string | number;
  percentage?: number;
}

export interface ChartLegendProps {
  items: LegendItem[];
  orientation?: 'horizontal' | 'vertical';
  position?: 'top' | 'bottom' | 'left' | 'right';
  showValues?: boolean;
  showPercentages?: boolean;
  onItemClick?: (item: LegendItem, index: number) => void;
  className?: string;
}

export const ChartLegend: React.FC<ChartLegendProps> = ({
  items,
  orientation = 'horizontal',
  showValues = false,
  showPercentages = false,
  onItemClick,
  className = '',
}) => {
  const containerClass = orientation === 'horizontal'
    ? 'flex flex-wrap items-center gap-4'
    : 'flex flex-col gap-2';

  return (
    <div className={`${containerClass} ${className}`}>
      {items.map((item, index) => (
        <div
          key={index}
          className={`flex items-center gap-2 text-sm ${onItemClick ? 'cursor-pointer hover:opacity-80' : ''}`}
          onClick={() => onItemClick?.(item, index)}
        >
          <span
            className="w-3 h-3 rounded-full flex-shrink-0"
            style={{ backgroundColor: item.color }}
          />
          <span className="text-gray-600">{item.label}</span>
          {showValues && item.value !== undefined && (
            <span className="font-medium text-gray-900">{item.value}</span>
          )}
          {showPercentages && item.percentage !== undefined && (
            <span className="text-gray-500">({item.percentage}%)</span>
          )}
        </div>
      ))}
    </div>
  );
};

export default ChartLegend;
