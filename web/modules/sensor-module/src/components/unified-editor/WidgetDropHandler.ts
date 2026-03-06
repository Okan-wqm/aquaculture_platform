/**
 * WidgetDropHandler - Utility for handling SCADA widget drops onto the ReactFlow canvas.
 *
 * Responsibilities:
 * - Grid-snap position calculation (CELL_WIDTH x CELL_HEIGHT)
 * - Building a complete ScadaWidgetNode data payload from drop event
 * - Generating unique node IDs
 */

import { WIDGET_SIZE_CONSTRAINTS, ScadaWidgetNodeData } from '../process-editor/nodes/ScadaWidgetNode';
import type { ScadaWidgetType } from '../scada-builder/WidgetPalette';

/* ------------------------------------------------------------------ */
/*  Grid constants                                                     */
/* ------------------------------------------------------------------ */

export const CELL_WIDTH = 120;
export const CELL_HEIGHT = 100;

/* ------------------------------------------------------------------ */
/*  Grid snap helper                                                   */
/* ------------------------------------------------------------------ */

/**
 * Snap an arbitrary (x, y) position to the nearest grid intersection.
 */
export function snapToGrid(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.round(x / CELL_WIDTH) * CELL_WIDTH,
    y: Math.round(y / CELL_HEIGHT) * CELL_HEIGHT,
  };
}

/* ------------------------------------------------------------------ */
/*  Drop payload                                                       */
/* ------------------------------------------------------------------ */

export interface WidgetDropPayload {
  widgetType: ScadaWidgetType;
  label: string;
  defaultConfig: Record<string, any>;
}

/* ------------------------------------------------------------------ */
/*  Build ScadaWidgetNode from drop                                    */
/* ------------------------------------------------------------------ */

export interface ScadaWidgetReactFlowNode {
  id: string;
  type: 'scadaWidget';
  position: { x: number; y: number };
  data: ScadaWidgetNodeData;
  connectable: boolean;
}

/**
 * Parse the dataTransfer payload from a widget palette drag event.
 * Returns null if the event does not carry widget data.
 */
export function parseWidgetDropData(event: DragEvent | React.DragEvent): WidgetDropPayload | null {
  const raw = event.dataTransfer?.getData('application/reactflow-widget');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WidgetDropPayload;
  } catch {
    return null;
  }
}

/**
 * Create a complete ReactFlow node object suitable for `addNode` postMessage.
 *
 * @param payload  Parsed drop payload (widgetType + label + defaultConfig)
 * @param rawX     Raw drop X coordinate (flow-space, before snap)
 * @param rawY     Raw drop Y coordinate (flow-space, before snap)
 * @param screenId Current screen id (defaults to 'default')
 */
export function createScadaWidgetNode(
  payload: WidgetDropPayload,
  rawX: number,
  rawY: number,
  screenId = 'default',
): ScadaWidgetReactFlowNode {
  const { x, y } = snapToGrid(rawX, rawY);

  const constraints = WIDGET_SIZE_CONSTRAINTS[payload.widgetType];
  const defaultW = constraints?.defaultW ?? 240;
  const defaultH = constraints?.defaultH ?? 200;

  const nodeData: ScadaWidgetNodeData = {
    widgetType: payload.widgetType,
    config: payload.defaultConfig ?? {},
    screenId,
    label: payload.label,
    width: defaultW,
    height: defaultH,
  };

  return {
    id: `scadaWidget-${payload.widgetType}-${Date.now()}`,
    type: 'scadaWidget',
    position: { x, y },
    data: nodeData,
    connectable: false,
  };
}
