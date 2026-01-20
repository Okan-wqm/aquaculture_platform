/**
 * Widget Renderer Component
 *
 * Renders the appropriate widget content based on widget type.
 */

import React from 'react';
import { WidgetConfig } from './types';
import {
  GaugeWidgetContent,
  LineChartWidgetContent,
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
    case 'line-chart':
      return <LineChartWidgetContent config={config} />;
    case 'sparkline':
      return <SparklineWidgetContent config={config} />;
    case 'stat-card':
      return <StatCardWidgetContent config={config} />;
    case 'table':
      return <TableWidgetContent config={config} />;
    case 'alert':
      // TODO: Implement AlertWidgetContent
      return (
        <div className="flex items-center justify-center h-full text-gray-400 text-sm">
          Alert widget - Yakında
        </div>
      );
    default:
      return (
        <div className="flex items-center justify-center h-full text-gray-400 text-sm">
          Bilinmeyen widget türü
        </div>
      );
  }
};

export default WidgetRenderer;
