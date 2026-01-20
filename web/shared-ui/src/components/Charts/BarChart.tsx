/**
 * Bar Chart Component
 * SVG-based bar chart with grouped/stacked options
 */

import React, { useMemo, useState } from 'react';
import { ChartTooltip } from './ChartTooltip';

export interface BarDataset {
  label: string;
  data: number[];
  color?: string;
}

export interface BarChartProps {
  labels: string[];
  datasets: BarDataset[];
  width?: number;
  height?: number;
  showGrid?: boolean;
  showLabels?: boolean;
  showTooltip?: boolean;
  showLegend?: boolean;
  showValues?: boolean;
  horizontal?: boolean;
  stacked?: boolean;
  barRadius?: number;
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
];

export const BarChart: React.FC<BarChartProps> = ({
  labels,
  datasets,
  width = 400,
  height = 250,
  showGrid = true,
  showLabels = true,
  showTooltip = true,
  showLegend = true,
  showValues = false,
  horizontal = false,
  stacked = false,
  barRadius = 4,
  animate = true,
  className = '',
  formatValue = (v) => v.toLocaleString(),
}) => {
  const [tooltipData, setTooltipData] = useState<{
    visible: boolean;
    x: number;
    y: number;
    title: string;
    items: { label: string; value: string; color: string }[];
  }>({ visible: false, x: 0, y: 0, title: '', items: [] });

  const padding = { top: 20, right: 20, bottom: showLabels ? 50 : 20, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const { bars, yTicks, maxValue } = useMemo(() => {
    if (!datasets || datasets.length === 0 || labels.length === 0) {
      return { bars: [], yTicks: [], maxValue: 0 };
    }

    let max: number;
    if (stacked) {
      max = Math.max(
        ...labels.map((_, i) => datasets.reduce((sum, d) => sum + (d.data[i] || 0), 0))
      );
    } else {
      max = Math.max(...datasets.flatMap((d) => d.data));
    }
    max = max || 1;
    const paddedMax = max * 1.1;

    const groupWidth = chartWidth / labels.length;
    const barWidth = stacked
      ? groupWidth * 0.6
      : (groupWidth * 0.7) / datasets.length;
    const groupPadding = (groupWidth - (stacked ? barWidth : barWidth * datasets.length)) / 2;

    const allBars = labels.flatMap((label, labelIndex) => {
      let stackOffset = 0;

      return datasets.map((dataset, datasetIndex) => {
        const value = dataset.data[labelIndex] || 0;
        const barHeight = (value / paddedMax) * chartHeight;
        const color = dataset.color || defaultColors[datasetIndex % defaultColors.length];

        let x: number;
        let y: number;

        if (stacked) {
          x = padding.left + labelIndex * groupWidth + groupPadding;
          y = padding.top + chartHeight - stackOffset - barHeight;
          stackOffset += barHeight;
        } else {
          x = padding.left + labelIndex * groupWidth + groupPadding + datasetIndex * barWidth;
          y = padding.top + chartHeight - barHeight;
        }

        return {
          x,
          y,
          width: barWidth,
          height: barHeight,
          value,
          color,
          label,
          datasetLabel: dataset.label,
        };
      });
    });

    const tickCount = 5;
    const ticks = Array.from({ length: tickCount }, (_, i) => {
      const value = (paddedMax * (tickCount - 1 - i)) / (tickCount - 1);
      const y = padding.top + (i / (tickCount - 1)) * chartHeight;
      return { value: Math.round(value), y };
    });

    return { bars: allBars, yTicks: ticks, maxValue: max };
  }, [datasets, labels, chartWidth, chartHeight, padding, stacked]);

  const handleBarHover = (bar: (typeof bars)[0], event: React.MouseEvent) => {
    if (!showTooltip) return;

    const sameLabel = bars.filter((b) => b.label === bar.label);

    setTooltipData({
      visible: true,
      x: event.clientX,
      y: event.clientY,
      title: bar.label,
      items: sameLabel.map((b) => ({
        label: b.datasetLabel,
        value: formatValue(b.value),
        color: b.color,
      })),
    });
  };

  const handleMouseLeave = () => {
    setTooltipData((prev) => ({ ...prev, visible: false }));
  };

  if (!datasets || datasets.length === 0) {
    return (
      <div className={`flex items-center justify-center ${className}`} style={{ width, height }}>
        <span className="text-gray-400 text-sm">No data available</span>
      </div>
    );
  }

  return (
    <div className={`relative ${className}`} onMouseLeave={handleMouseLeave}>
      {/* Legend */}
      {showLegend && (
        <div className="flex flex-wrap gap-4 mb-4">
          {datasets.map((dataset, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              <span
                className="w-3 h-3 rounded"
                style={{ backgroundColor: dataset.color || defaultColors[i % defaultColors.length] }}
              />
              <span className="text-gray-600">{dataset.label}</span>
            </div>
          ))}
        </div>
      )}

      <svg width={width} height={height}>
        {/* Grid lines */}
        {showGrid && (
          <g className="text-gray-200">
            {yTicks.map((tick, i) => (
              <line
                key={i}
                x1={padding.left}
                y1={tick.y}
                x2={width - padding.right}
                y2={tick.y}
                stroke="currentColor"
                strokeDasharray="4,4"
              />
            ))}
          </g>
        )}

        {/* Y axis labels */}
        <g className="text-gray-500 text-xs">
          {yTicks.map((tick, i) => (
            <text
              key={i}
              x={padding.left - 8}
              y={tick.y}
              textAnchor="end"
              dominantBaseline="middle"
              fill="currentColor"
            >
              {formatValue(tick.value)}
            </text>
          ))}
        </g>

        {/* X axis labels */}
        {showLabels && (
          <g className="text-gray-500 text-xs">
            {labels.map((label, i) => {
              const groupWidth = chartWidth / labels.length;
              const x = padding.left + i * groupWidth + groupWidth / 2;
              return (
                <text
                  key={i}
                  x={x}
                  y={height - padding.bottom + 20}
                  textAnchor="middle"
                  fill="currentColor"
                >
                  {label.length > 10 ? `${label.slice(0, 10)}...` : label}
                </text>
              );
            })}
          </g>
        )}

        {/* Bars */}
        {bars.map((bar, i) => (
          <g key={i}>
            <rect
              x={bar.x}
              y={bar.y}
              width={bar.width}
              height={Math.max(0, bar.height)}
              fill={bar.color}
              rx={barRadius}
              ry={barRadius}
              className={`${animate ? 'transition-all duration-500' : ''} cursor-pointer hover:opacity-80`}
              onMouseEnter={(e) => handleBarHover(bar, e)}
            />
            {showValues && bar.height > 20 && (
              <text
                x={bar.x + bar.width / 2}
                y={bar.y + 14}
                textAnchor="middle"
                fill="white"
                className="text-xs font-medium"
              >
                {formatValue(bar.value)}
              </text>
            )}
          </g>
        ))}

        {/* X axis line */}
        <line
          x1={padding.left}
          y1={padding.top + chartHeight}
          x2={width - padding.right}
          y2={padding.top + chartHeight}
          stroke="#E5E7EB"
          strokeWidth={1}
        />
      </svg>

      {/* Tooltip */}
      {tooltipData.visible && (
        <div
          className="fixed z-50 pointer-events-none"
          style={{
            left: tooltipData.x + 10,
            top: tooltipData.y - 10,
          }}
        >
          <div className="bg-gray-900 text-white text-xs rounded-lg shadow-lg px-3 py-2">
            <div className="font-medium mb-1 border-b border-gray-700 pb-1">
              {tooltipData.title}
            </div>
            <div className="space-y-1">
              {tooltipData.items.map((item, idx) => (
                <div key={idx} className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-2 h-2 rounded"
                      style={{ backgroundColor: item.color }}
                    />
                    <span className="text-gray-300">{item.label}</span>
                  </div>
                  <span className="font-medium">{item.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BarChart;
