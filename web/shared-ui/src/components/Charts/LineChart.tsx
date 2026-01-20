/**
 * Line Chart Component
 * SVG-based multi-line chart
 */

import React, { useMemo, useState } from 'react';
import { ChartTooltip } from './ChartTooltip';

export interface LineDataset {
  label: string;
  data: number[];
  color?: string;
  strokeWidth?: number;
  dashed?: boolean;
}

export interface LineChartProps {
  labels: string[];
  datasets: LineDataset[];
  width?: number;
  height?: number;
  showGrid?: boolean;
  showLabels?: boolean;
  showTooltip?: boolean;
  showDots?: boolean;
  showLegend?: boolean;
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

export const LineChart: React.FC<LineChartProps> = ({
  labels,
  datasets,
  width = 400,
  height = 200,
  showGrid = true,
  showLabels = true,
  showTooltip = true,
  showDots = false,
  showLegend = true,
  animate = true,
  className = '',
  formatValue = (v) => v.toLocaleString(),
}) => {
  const [tooltipData, setTooltipData] = useState<{
    visible: boolean;
    x: number;
    y: number;
    labelIndex: number;
  }>({ visible: false, x: 0, y: 0, labelIndex: 0 });

  const padding = { top: 20, right: 20, bottom: showLabels ? 40 : 20, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const { allPoints, yTicks } = useMemo(() => {
    if (!datasets || datasets.length === 0 || labels.length === 0) {
      return { allPoints: [], yTicks: [] };
    }

    const allValues = datasets.flatMap((d) => d.data);
    const min = Math.min(...allValues);
    const max = Math.max(...allValues);
    const range = max - min || 1;

    const paddedMin = min - range * 0.1;
    const paddedMax = max + range * 0.1;
    const paddedRange = paddedMax - paddedMin;

    const pts = datasets.map((dataset, datasetIndex) => ({
      dataset,
      color: dataset.color || defaultColors[datasetIndex % defaultColors.length],
      points: dataset.data.map((value, i) => ({
        x: padding.left + (i / (labels.length - 1)) * chartWidth,
        y: padding.top + (1 - (value - paddedMin) / paddedRange) * chartHeight,
        value,
      })),
    }));

    const tickCount = 5;
    const ticks = Array.from({ length: tickCount }, (_, i) => {
      const value = paddedMin + (paddedRange * (tickCount - 1 - i)) / (tickCount - 1);
      const y = padding.top + (i / (tickCount - 1)) * chartHeight;
      return { value: Math.round(value), y };
    });

    return { allPoints: pts, yTicks: ticks };
  }, [datasets, labels, chartWidth, chartHeight, padding]);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!showTooltip || allPoints.length === 0) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;

    const step = chartWidth / (labels.length - 1);
    const index = Math.round((mouseX - padding.left) / step);

    if (index >= 0 && index < labels.length) {
      const x = padding.left + (index / (labels.length - 1)) * chartWidth;
      setTooltipData({
        visible: true,
        x,
        y: padding.top,
        labelIndex: index,
      });
    } else {
      setTooltipData((prev) => ({ ...prev, visible: false }));
    }
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
    <div className={`relative ${className}`}>
      {/* Legend */}
      {showLegend && (
        <div className="flex flex-wrap gap-4 mb-4">
          {datasets.map((dataset, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              <span
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: dataset.color || defaultColors[i % defaultColors.length] }}
              />
              <span className="text-gray-600">{dataset.label}</span>
            </div>
          ))}
        </div>
      )}

      <svg
        width={width}
        height={height}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
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
            {labels.map((label, i) => (
              (labels.length <= 7 || i % Math.ceil(labels.length / 7) === 0) && (
                <text
                  key={i}
                  x={padding.left + (i / (labels.length - 1)) * chartWidth}
                  y={height - padding.bottom + 20}
                  textAnchor="middle"
                  fill="currentColor"
                >
                  {label}
                </text>
              )
            ))}
          </g>
        )}

        {/* Lines */}
        {allPoints.map((line, lineIndex) => {
          const pathD = line.points
            .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`)
            .join(' ');

          return (
            <g key={lineIndex}>
              <path
                d={pathD}
                fill="none"
                stroke={line.color}
                strokeWidth={line.dataset.strokeWidth || 2}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={line.dataset.dashed ? '8,4' : undefined}
                className={animate ? 'transition-all duration-500' : ''}
              />

              {/* Dots */}
              {showDots &&
                line.points.map((p, i) => (
                  <circle
                    key={i}
                    cx={p.x}
                    cy={p.y}
                    r={4}
                    fill="white"
                    stroke={line.color}
                    strokeWidth={2}
                  />
                ))}
            </g>
          );
        })}

        {/* Tooltip indicator line */}
        {tooltipData.visible && (
          <line
            x1={tooltipData.x}
            y1={padding.top}
            x2={tooltipData.x}
            y2={height - padding.bottom}
            stroke="#9CA3AF"
            strokeWidth={1}
            strokeDasharray="4,4"
          />
        )}
      </svg>

      {/* Tooltip */}
      {tooltipData.visible && (
        <ChartTooltip
          visible={tooltipData.visible}
          x={tooltipData.x}
          y={tooltipData.y + 10}
          title={labels[tooltipData.labelIndex]}
          items={allPoints.map((line) => ({
            label: line.dataset.label,
            value: formatValue(line.points[tooltipData.labelIndex]?.value || 0),
            color: line.color,
          }))}
        />
      )}
    </div>
  );
};

export default LineChart;
