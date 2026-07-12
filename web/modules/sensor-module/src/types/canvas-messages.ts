/**
 * Centralized PostMessage type system for parent <-> iframe canvas communication.
 */

import type { ScadaWidgetNodeData } from './scada-widget.types';
import type { EditorMode } from '../store/editorModeStore';

/* ------------------------------------------------------------------ */
/*  Parent -> iframe messages                                          */
/* ------------------------------------------------------------------ */

export type ParentToCanvasMessage =
  | { type: 'setNodes'; data: { nodes: unknown[] } }
  | { type: 'setEdges'; data: { edges: unknown[] } }
  | { type: 'addNode'; data: unknown }
  | { type: 'addOverlayNode'; data: { node: ScadaWidgetNodeData } }
  | { type: 'removeOverlayNode'; data: { nodeId: string } }
  | { type: 'updateOverlayNode'; data: { nodeId: string; data: Partial<ScadaWidgetNodeData> } }
  | { type: 'updateLiveValues'; data: { values: Record<string, number | string | boolean> } }
  | { type: 'setNodeVisibility'; data: { nodeIds: string[]; visible: boolean } }
  | { type: 'lockPidNodes'; data: { locked: boolean } }
  | { type: 'setEditorMode'; data: { mode: EditorMode } }
  | { type: 'getViewport'; data?: undefined }
  | { type: 'setViewport'; data: { x: number; y: number; zoom: number } }
  | { type: 'setActiveScreen'; data: { screenId: string } }
  | { type: 'fitView'; data?: undefined }
  | { type: 'getState'; data?: undefined };

/* ------------------------------------------------------------------ */
/*  iframe -> Parent messages                                          */
/* ------------------------------------------------------------------ */

export type CanvasToParentMessage =
  | { type: 'ready'; data?: undefined }
  | { type: 'nodesChange'; data: unknown[] }
  | { type: 'edgesChange'; data: unknown[] }
  // USER-driven canvas edit (WF-004). nodesChange/edgesChange above echo on
  // EVERY state change — including host-initiated hydration — so they can
  // never drive a dirty flag. canvasEdited is emitted only from ReactFlow's
  // interaction callbacks (drag, keyboard delete), which programmatic
  // setNodes/setEdges never invoke.
  | { type: 'canvasEdited'; data: { plane: 'nodes' | 'edges' } }
  | { type: 'nodeAdded'; data: unknown }
  | { type: 'edgeAdded'; data: unknown }
  | { type: 'nodeSelected'; data: { nodeId: string; nodeData: unknown } }
  | { type: 'overlayNodeSelected'; data: { nodeId: string; nodeData: ScadaWidgetNodeData } }
  | { type: 'overlayNodeMoved'; data: { nodeId: string; position: { x: number; y: number } } }
  | { type: 'overlayNodeResized'; data: { nodeId: string; width: number; height: number } }
  | { type: 'overlayNodeDropped'; data: { widgetType: string; position: { x: number; y: number } } }
  | { type: 'overlayNodeDeleted'; data: { nodeId: string } }
  | { type: 'state'; data: { nodes: unknown[]; edges: unknown[] } }
  | { type: 'viewportState'; data: { x: number; y: number; zoom: number } };

/* ------------------------------------------------------------------ */
/*  Type guard                                                         */
/* ------------------------------------------------------------------ */

export function isCanvasMessage(data: unknown): data is { type: string; data: unknown; source: string } {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    'source' in data
  );
}
