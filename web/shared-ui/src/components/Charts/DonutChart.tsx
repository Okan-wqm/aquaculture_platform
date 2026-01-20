/**
 * Donut Chart Component
 * Wrapper around PieChart with inner radius
 */

import React from 'react';
import { PieChart, PieDataItem } from './PieChart';

export interface DonutChartProps {
  data: PieDataItem[];
  size?: number;
  thickness?: number; // How thick the donut ring should be
  showLabels?: boolean;
  showPercentages?: boolean;
  showLegend?: boolean;
  showTooltip?: boolean;
  animate?: boolean;
  className?: string;
  formatValue?: (value: number) => string;
  centerContent?: React.ReactNode;
}

export const DonutChart: React.FC<DonutChartProps> = ({
  data,
  size = 200,
  thickness = 30,
  showLabels = false,
  showPercentages = true,
  showLegend = true,
  showTooltip = true,
  animate = true,
  className = '',
  formatValue,
  centerContent,
}) => {
  const outerRadius = size / 2 - 10;
  const innerRadius = Math.max(outerRadius - thickness, 20);

  return (
    <div className={`relative ${className}`}>
      <PieChart
        data={data}
        size={size}
        innerRadius={innerRadius}
        showLabels={showLabels}
        showPercentages={showPercentages}
        showLegend={showLegend}
        showTooltip={showTooltip}
        animate={animate}
        formatValue={formatValue}
      />
      {centerContent && (
        <div
          className="absolute pointer-events-none flex items-center justify-center"
          style={{
            top: '50%',
            left: size / 2,
            transform: 'translate(-50%, -50%)',
            width: innerRadius * 2 - 10,
            height: innerRadius * 2 - 10,
          }}
        >
          {centerContent}
        </div>
      )}
    </div>
  );
};

export default DonutChart;
