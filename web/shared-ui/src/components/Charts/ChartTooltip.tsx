/**
 * Chart Tooltip Component
 * Reusable tooltip for charts
 */

import React from 'react';

export interface TooltipItem {
  label: string;
  value: string | number;
  color?: string;
}

export interface ChartTooltipProps {
  visible: boolean;
  x: number;
  y: number;
  title?: string;
  items: TooltipItem[];
  className?: string;
}

export const ChartTooltip: React.FC<ChartTooltipProps> = ({
  visible,
  x,
  y,
  title,
  items,
  className = '',
}) => {
  if (!visible) return null;

  return (
    <div
      className={`absolute z-50 pointer-events-none transform -translate-x-1/2 -translate-y-full ${className}`}
      style={{ left: x, top: y - 10 }}
    >
      <div className="bg-gray-900 text-white text-xs rounded-lg shadow-lg px-3 py-2 whitespace-nowrap">
        {title && <div className="font-medium mb-1 border-b border-gray-700 pb-1">{title}</div>}
        <div className="space-y-1">
          {items.map((item, index) => (
            <div key={index} className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                {item.color && (
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                )}
                <span className="text-gray-300">{item.label}</span>
              </div>
              <span className="font-medium">{item.value}</span>
            </div>
          ))}
        </div>
        {/* Arrow */}
        <div className="absolute left-1/2 bottom-0 transform -translate-x-1/2 translate-y-full">
          <div className="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[6px] border-t-gray-900" />
        </div>
      </div>
    </div>
  );
};

export default ChartTooltip;
