/**
 * Built-in screen templates for the Unified SCADA Editor.
 *
 * Templates provide pre-configured widget layouts for common screen types.
 */
import type { ScreenType, ScreenWidget } from '../../store/scada';

export interface ScreenTemplate {
  id: string;
  name: string;
  description: string;
  screenType: ScreenType;
  icon: string;
  defaultWidgets: Omit<ScreenWidget, 'id'>[];
}

function wid(): string {
  return `tmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export const SCREEN_TEMPLATES: ScreenTemplate[] = [
  {
    id: 'empty-dashboard',
    name: 'Empty Dashboard',
    description: 'Blank dashboard - add widgets manually',
    screenType: 'dashboard',
    icon: 'LayoutDashboard',
    defaultWidgets: [],
  },
  {
    id: 'four-gauge',
    name: '4-Gauge Dashboard',
    description: 'Four gauge widgets in a 2x2 grid for key process values',
    screenType: 'dashboard',
    icon: 'Gauge',
    defaultWidgets: [
      {
        widgetType: 'gauge',
        position: { col: 0, row: 0, w: 3, h: 4 },
        config: { label: 'Temperature', unit: '\u00b0C', min: 0, max: 100, tagName: '' },
      },
      {
        widgetType: 'gauge',
        position: { col: 3, row: 0, w: 3, h: 4 },
        config: { label: 'Pressure', unit: 'bar', min: 0, max: 10, tagName: '' },
      },
      {
        widgetType: 'gauge',
        position: { col: 6, row: 0, w: 3, h: 4 },
        config: { label: 'Flow Rate', unit: 'L/min', min: 0, max: 500, tagName: '' },
      },
      {
        widgetType: 'gauge',
        position: { col: 9, row: 0, w: 3, h: 4 },
        config: { label: 'Level', unit: '%', min: 0, max: 100, tagName: '' },
      },
    ],
  },
  {
    id: 'alarm-monitor',
    name: 'Alarm Monitor',
    description: 'Active alarm table with severity indicators and acknowledgement',
    screenType: 'alarms',
    icon: 'AlertTriangle',
    defaultWidgets: [
      {
        widgetType: 'alarmTable',
        position: { col: 0, row: 0, w: 12, h: 6 },
        config: { showAcknowledged: true, autoRefresh: true, refreshInterval: 5 },
      },
      {
        widgetType: 'alarmSummary',
        position: { col: 0, row: 6, w: 6, h: 2 },
        config: { groupBy: 'severity' },
      },
      {
        widgetType: 'alarmHistory',
        position: { col: 6, row: 6, w: 6, h: 2 },
        config: { hours: 24 },
      },
    ],
  },
  {
    id: 'trend-viewer',
    name: 'Trend Viewer',
    description: 'Historical trend charts with configurable time range',
    screenType: 'trends',
    icon: 'TrendingUp',
    defaultWidgets: [
      {
        widgetType: 'trendChart',
        position: { col: 0, row: 0, w: 12, h: 5 },
        config: { tags: [], timeRange: '1h', autoScale: true },
      },
      {
        widgetType: 'trendChart',
        position: { col: 0, row: 5, w: 6, h: 3 },
        config: { tags: [], timeRange: '24h', autoScale: true },
      },
      {
        widgetType: 'dataTable',
        position: { col: 6, row: 5, w: 6, h: 3 },
        config: { tags: [], showTimestamp: true, rows: 20 },
      },
    ],
  },
];

/**
 * Instantiate widgets from a template with unique IDs.
 */
export function instantiateTemplate(template: ScreenTemplate): ScreenWidget[] {
  return template.defaultWidgets.map((w) => ({
    ...w,
    id: wid(),
  }));
}
