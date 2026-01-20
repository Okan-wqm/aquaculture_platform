/**
 * Pie Chart Component
 * SVG-based pie chart with interactive slices
 */

import React, { useMemo, useState } from 'react';

export interface PieDataItem {
  label: string;
  value: number;
  color?: string;
}

export interface PieChartProps {
  data: PieDataItem[];
  size?: number;
  innerRadius?: number; // 0 for pie, > 0 for donut
  showLabels?: boolean;
  showPercentages?: boolean;
  showLegend?: boolean;
  showTooltip?: boolean;
  animate?: boolean;
  className?: string;
  formatValue?: (value: number) => string;
}

const defaultColors = [
  '#3B82F6', // blue
  '#10B981', // green
  '#F59E0B', // yellow
  '#EF4444', // red
  '#8B5CF6', // purple
  '#EC4899', // pink
  '#06B6D4', // cyan
  '#F97316', // orange
  '#6366F1', // indigo
  '#84CC16', // lime
];

export const PieChart: React.FC<PieChartProps> = ({
  data,
  size = 200,
  innerRadius = 0,
  showLabels = false,
  showPercentages = true,
  showLegend = true,
  showTooltip = true,
  animate = true,
  className = '',
  formatValue = (v) => v.toLocaleString(),
}) => {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const { slices, total } = useMemo(() => {
    if (!data || data.length === 0) {
      return { slices: [], total: 0 };
    }

    const sum = data.reduce((acc, item) => acc + item.value, 0);
    if (sum === 0) return { slices: [], total: 0 };

    const centerX = size / 2;
    const centerY = size / 2;
    const outerRadius = size / 2 - 10;
    const inner = innerRadius > 0 ? innerRadius : 0;

    let currentAngle = -90; // Start from top

    const paths = data.map((item, index) => {
      const percentage = (item.value / sum) * 100;
      const angle = (item.value / sum) * 360;
      const startAngle = currentAngle;
      const endAngle = currentAngle + angle;
      currentAngle = endAngle;

      // Convert angles to radians
      const startRad = (startAngle * Math.PI) / 180;
      const endRad = (endAngle * Math.PI) / 180;

      // Calculate arc points
      const x1Outer = centerX + outerRadius * Math.cos(startRad);
      const y1Outer = centerY + outerRadius * Math.sin(startRad);
      const x2Outer = centerX + outerRadius * Math.cos(endRad);
      const y2Outer = centerY + outerRadius * Math.sin(endRad);

      const largeArc = angle > 180 ? 1 : 0;

      let path: string;
      if (inner > 0) {
        const x1Inner = centerX + inner * Math.cos(startRad);
        const y1Inner = centerY + inner * Math.sin(startRad);
        const x2Inner = centerX + inner * Math.cos(endRad);
        const y2Inner = centerY + inner * Math.sin(endRad);

        path = [
          `M ${x1Outer} ${y1Outer}`,
          `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${x2Outer} ${y2Outer}`,
          `L ${x2Inner} ${y2Inner}`,
          `A ${inner} ${inner} 0 ${largeArc} 0 ${x1Inner} ${y1Inner}`,
          'Z',
        ].join(' ');
      } else {
        path = [
          `M ${centerX} ${centerY}`,
          `L ${x1Outer} ${y1Outer}`,
          `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${x2Outer} ${y2Outer}`,
          'Z',
        ].join(' ');
      }

      // Label position
      const labelAngle = startAngle + angle / 2;
      const labelRad = (labelAngle * Math.PI) / 180;
      const labelRadius = inner > 0 ? (outerRadius + inner) / 2 : outerRadius * 0.65;
      const labelX = centerX + labelRadius * Math.cos(labelRad);
      const labelY = centerY + labelRadius * Math.sin(labelRad);

      return {
        path,
        color: item.color || defaultColors[index % defaultColors.length],
        label: item.label,
        value: item.value,
        percentage,
        labelX,
        labelY,
      };
    });

    return { slices: paths, total: sum };
  }, [data, size, innerRadius]);

  if (!data || data.length === 0 || total === 0) {
    return (
      <div className={`flex items-center justify-center ${className}`} style={{ width: size, height: size }}>
        <span className="text-gray-400 text-sm">No data available</span>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-6 ${className}`}>
      {/* Chart */}
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size}>
          {slices.map((slice, index) => (
            <path
              key={index}
              d={slice.path}
              fill={slice.color}
              stroke="white"
              strokeWidth={2}
              className={`${animate ? 'transition-all duration-300' : ''} cursor-pointer`}
              style={{
                transform: hoveredIndex === index ? 'scale(1.03)' : 'scale(1)',
                transformOrigin: 'center',
                filter: hoveredIndex === index ? 'brightness(1.1)' : 'none',
              }}
              onMouseEnter={() => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(null)}
            />
          ))}

          {/* Labels on chart */}
          {showLabels &&
            slices.map(
              (slice, index) =>
                slice.percentage > 5 && (
                  <text
                    key={`label-${index}`}
                    x={slice.labelX}
                    y={slice.labelY}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="text-xs font-medium pointer-events-none"
                    fill="white"
                  >
                    {showPercentages ? `${slice.percentage.toFixed(0)}%` : formatValue(slice.value)}
                  </text>
                )
            )}
        </svg>

        {/* Center total for donut */}
        {innerRadius > 0 && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
            style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
          >
            <span className="text-xl font-bold text-gray-900">{formatValue(total)}</span>
            <span className="text-xs text-gray-500">Total</span>
          </div>
        )}

        {/* Tooltip */}
        {showTooltip && hoveredIndex !== null && (
          <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 z-10">
            <div className="bg-gray-900 text-white text-xs rounded-lg shadow-lg px-3 py-2 whitespace-nowrap">
              <div className="flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: slices[hoveredIndex].color }}
                />
                <span>{slices[hoveredIndex].label}</span>
              </div>
              <div className="flex items-center justify-between gap-4 mt-1">
                <span className="text-gray-400">Value:</span>
                <span className="font-medium">{formatValue(slices[hoveredIndex].value)}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-gray-400">Share:</span>
                <span className="font-medium">{slices[hoveredIndex].percentage.toFixed(1)}%</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Legend */}
      {showLegend && (
        <div className="flex flex-col gap-2">
          {slices.map((slice, index) => (
            <div
              key={index}
              className={`flex items-center gap-3 text-sm cursor-pointer transition-opacity ${
                hoveredIndex !== null && hoveredIndex !== index ? 'opacity-50' : 'opacity-100'
              }`}
              onMouseEnter={() => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(null)}
            >
              <span
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: slice.color }}
              />
              <span className="text-gray-600 truncate max-w-[120px]">{slice.label}</span>
              <span className="text-gray-400 ml-auto">{slice.percentage.toFixed(1)}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default PieChart;
