/**
 * Dashboard Widget Types
 */

export type WidgetType =
  | 'gauge'
  | 'line-chart'
  | 'area-chart'
  | 'bar-chart'
  | 'multi-line'
  | 'sparkline'
  | 'stat-card'
  | 'table'
  | 'radial-gauge'
  | 'heatmap'
  | 'alert'
  | 'process-view';

export type TimeRange = 'live' | '1h' | '6h' | '24h' | '7d' | '30d';

/**
 * Available sensor metrics for visualization
 */
export type SensorMetric =
  | 'temperature'
  | 'ph'
  | 'dissolvedOxygen'
  | 'salinity'
  | 'ammonia'
  | 'nitrite'
  | 'nitrate'
  | 'turbidity'
  | 'waterLevel';

export const SENSOR_METRICS: {
  value: SensorMetric;
  label: string;
  unit: string;
  color: string;
}[] = [
  { value: 'temperature', label: 'Temperature', unit: '°C', color: '#EF4444' },
  { value: 'ph', label: 'pH', unit: 'pH', color: '#8B5CF6' },
  { value: 'dissolvedOxygen', label: 'Dissolved Oxygen', unit: 'mg/L', color: '#0EA5E9' },
  { value: 'salinity', label: 'Salinity', unit: 'ppt', color: '#10B981' },
  { value: 'ammonia', label: 'Ammonia', unit: 'mg/L', color: '#F59E0B' },
  { value: 'nitrite', label: 'Nitrite', unit: 'mg/L', color: '#EC4899' },
  { value: 'nitrate', label: 'Nitrate', unit: 'mg/L', color: '#6366F1' },
  { value: 'turbidity', label: 'Turbidity', unit: 'NTU', color: '#78716C' },
  { value: 'waterLevel', label: 'Water Level', unit: 'm', color: '#14B8A6' },
];

export interface GridPosition {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Selected data channel info stored in widget config
 */
export interface SelectedChannel {
  id: string;
  channelKey: string;
  displayLabel: string;
  unit?: string;
  sensorId: string;
  sensorName: string;
}

export interface WidgetConfig {
  id: string;
  type: WidgetType;
  title: string;
  // New: Data channel based selection
  dataChannelIds?: string[];
  selectedChannels?: SelectedChannel[];
  // Legacy: Sensor + metric based (deprecated, kept for backward compatibility)
  sensorIds?: string[];
  metric?: SensorMetric;
  timeRange: TimeRange;
  refreshInterval: number; // ms
  gridPosition: GridPosition;
  settings?: WidgetSettings;
  // Process view widget: Selected process ID
  processId?: string;
}

/**
 * Widget display settings
 */
export interface WidgetSettings {
  showLegend?: boolean;
  showGrid?: boolean;
  colorScheme?: 'default' | 'ocean' | 'forest' | 'sunset';
  aggregation?: 'none' | 'avg' | 'min' | 'max';
  decimalPlaces?: number;
  // Y-Axis configuration for chart types
  yAxis?: YAxisConfig;
  // Threshold zones for gauge/radial-gauge
  thresholds?: ThresholdConfig;
  // Bar chart specific
  barWidth?: number;
  // Heatmap specific
  heatmapColorScale?: 'blues' | 'greens' | 'reds' | 'viridis';
}

/**
 * Y-Axis configuration for chart widgets
 */
export interface YAxisConfig {
  min?: number;           // Manual minimum (undefined = auto)
  max?: number;           // Manual maximum (undefined = auto)
  label?: string;         // Y-axis label text
  position?: 'left' | 'right';
  tickCount?: number;     // Number of ticks
}

/**
 * Threshold configuration for gauge widgets
 */
export interface ThresholdConfig {
  warning?: { low?: number; high?: number };
  critical?: { low?: number; high?: number };
}

export interface DashboardWidget {
  config: WidgetConfig;
  data?: SensorDataPoint[];
  loading?: boolean;
  error?: string | null;
}

export interface SensorDataPoint {
  sensorId: string;
  sensorName: string;
  value: number;
  unit: string;
  timestamp: Date;
  status: 'normal' | 'warning' | 'critical' | 'offline';
}

export interface SensorInfo {
  id: string;
  name: string;
  type: string;
  unit: string;
  minValue?: number;
  maxValue?: number;
  warningLow?: number;
  warningHigh?: number;
  criticalLow?: number;
  criticalHigh?: number;
}

// Widget type metadata for UI
export const WIDGET_TYPES: {
  type: WidgetType;
  label: string;
  description: string;
  defaultSize: { w: number; h: number };
  icon: string;
  category: 'charts' | 'gauges' | 'data';
}[] = [
  // Gauge widgets
  {
    type: 'gauge',
    label: 'Gauge',
    description: 'Circular gauge for single sensor value',
    defaultSize: { w: 2, h: 3 },
    icon: 'gauge',
    category: 'gauges',
  },
  {
    type: 'radial-gauge',
    label: 'Radial Gauge',
    description: 'Radial progress gauge with threshold zones',
    defaultSize: { w: 2, h: 3 },
    icon: 'target',
    category: 'gauges',
  },
  // Chart widgets
  {
    type: 'line-chart',
    label: 'Line Chart',
    description: 'Time series line chart for historical data',
    defaultSize: { w: 4, h: 3 },
    icon: 'line-chart',
    category: 'charts',
  },
  {
    type: 'area-chart',
    label: 'Area Chart',
    description: 'Filled area chart for trend visualization',
    defaultSize: { w: 4, h: 3 },
    icon: 'area-chart',
    category: 'charts',
  },
  {
    type: 'bar-chart',
    label: 'Bar Chart',
    description: 'Vertical bar chart for periodic comparisons',
    defaultSize: { w: 4, h: 3 },
    icon: 'bar-chart-2',
    category: 'charts',
  },
  {
    type: 'multi-line',
    label: 'Multi-Line Chart',
    description: 'Overlay multiple sensors on single chart',
    defaultSize: { w: 6, h: 4 },
    icon: 'git-branch',
    category: 'charts',
  },
  {
    type: 'heatmap',
    label: 'Heatmap',
    description: 'Color-coded time blocks for pattern detection',
    defaultSize: { w: 6, h: 3 },
    icon: 'grid',
    category: 'charts',
  },
  {
    type: 'sparkline',
    label: 'Sparkline',
    description: 'Mini trend line for compact display',
    defaultSize: { w: 2, h: 2 },
    icon: 'trending-up',
    category: 'charts',
  },
  // Data widgets
  {
    type: 'stat-card',
    label: 'Statistics Card',
    description: 'Min/Max/Average statistics display',
    defaultSize: { w: 2, h: 2 },
    icon: 'activity',
    category: 'data',
  },
  {
    type: 'table',
    label: 'Data Table',
    description: 'Multi-sensor tabular view',
    defaultSize: { w: 4, h: 3 },
    icon: 'table',
    category: 'data',
  },
  // Process widget
  {
    type: 'process-view',
    label: 'Process View',
    description: 'Display process diagram in widget',
    defaultSize: { w: 6, h: 4 },
    icon: 'git-fork',
    category: 'data',
  },
];

export const TIME_RANGES: { value: TimeRange; label: string }[] = [
  { value: 'live', label: 'Live' },
  { value: '1h', label: 'Last 1 Hour' },
  { value: '6h', label: 'Last 6 Hours' },
  { value: '24h', label: 'Last 24 Hours' },
  { value: '7d', label: 'Last 7 Days' },
  { value: '30d', label: 'Last 30 Days' },
];

export const REFRESH_INTERVALS: { value: number; label: string }[] = [
  { value: 5000, label: '5 seconds' },
  { value: 10000, label: '10 seconds' },
  { value: 30000, label: '30 seconds' },
  { value: 60000, label: '1 minute' },
  { value: 300000, label: '5 minutes' },
];

/**
 * Widget category labels for grouping in UI
 */
export const WIDGET_CATEGORIES = {
  gauges: 'Gauges',
  charts: 'Charts',
  data: 'Data Views',
} as const;
