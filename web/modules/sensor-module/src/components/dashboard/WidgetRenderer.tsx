/**
 * Widget Renderer Component
 *
 * Renders the appropriate widget content based on widget type.
 */

import React from 'react';
import { WidgetConfig } from './types';
import {
  AlertWidgetContent,
  AreaChartWidgetContent,
  BarChartWidgetContent,
  GaugeWidgetContent,
  HeatmapWidgetContent,
  LineChartWidgetContent,
  ProcessViewWidgetContent,
  RadialGaugeWidgetContent,
  SparklineWidgetContent,
  StatCardWidgetContent,
  TableWidgetContent,
} from './widgets';

interface WidgetRendererProps {
  config: WidgetConfig;
}

export const WidgetRenderer: React.FC<WidgetRendererProps> = ({ config }) => {
  switch (config.type) {
    case 'gauge':
      return <GaugeWidgetContent config={config} />;
    case 'radial-gauge':
      return <RadialGaugeWidgetContent config={config} />;
    case 'line-chart':
      return <LineChartWidgetContent config={config} />;
    case 'area-chart':
      return <AreaChartWidgetContent config={config} />;
    case 'bar-chart':
      return <BarChartWidgetContent config={config} />;
    case 'multi-line':
      // Multi-line uses the same component as line-chart with multiple sensors
      return <LineChartWidgetContent config={config} />;
    case 'sparkline':
      return <SparklineWidgetContent config={config} />;
    case 'stat-card':
      return <StatCardWidgetContent config={config} />;
    case 'table':
      return <TableWidgetContent config={config} />;
    case 'heatmap':
      return <HeatmapWidgetContent config={config} />;
    case 'alert':
      return <AlertWidgetContent config={config} />;
    case 'process-view':
      return <ProcessViewWidgetContent config={config} />;
    default:
      return (
        <div className="flex items-center justify-center h-full text-gray-500 text-sm">
          Bilinmeyen widget türü
        </div>
      );
  }
};

export default WidgetRenderer;
