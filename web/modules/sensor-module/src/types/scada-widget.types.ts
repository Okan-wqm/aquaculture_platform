/**
 * Shared SCADA widget type definitions.
 *
 * Canonical source for ScadaWidgetType and ScadaWidgetNodeData —
 * other modules should import from here instead of defining locally.
 */

export type ScadaWidgetType =
  | 'gauge'
  | 'numericDisplay'
  | 'statusIndicator'
  | 'tankLevel'
  | 'toggleSwitch'
  | 'slider'
  | 'numericInput'
  | 'pushButton'
  | 'emergencyStop'
  | 'trendChart'
  | 'alarmBanner'
  | 'alarmList'
  | 'calibrationWizard'
  | 'calibrationHistory'
  | 'calibrationStatus'
  | 'processView';

export interface ScadaWidgetNodeData {
  widgetType: ScadaWidgetType;
  config: Record<string, unknown>;
  screenId: string;
  liveValue?: number | string | boolean;
  label?: string;
  tagName?: string;
  tagFqn?: string;
  width?: number;
  height?: number;
  onResize?: (widgetType: string, width: number, height: number) => void;
}
