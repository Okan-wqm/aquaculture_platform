/**
 * Edge Components Index
 *
 * This file exports all edge components for use in ReactFlow applications.
 */

import type { EdgeTypes } from '@xyflow/react';

// Import edge components
import DraggableEdge from './DraggableEdge';
import MultiHandleEdge from './MultiHandleEdge';
import OrthogonalEdge from './OrthogonalEdge';

// Re-export individual edges + their data / props types so consumers
// can build thin wrappers that inject a zustand/context-backed
// `updateEdgeData` override without duplicating the edge component.
export {
  MultiHandleEdge,
  OrthogonalEdge,
  DraggableEdge,
};
export type {
  MultiHandleEdgeData,
  MultiHandleEdgeProps,
} from './MultiHandleEdge';
export type {
  OrthogonalEdgeData,
  OrthogonalEdgeProps,
  EdgeDataUpdater,
} from './OrthogonalEdge';
export type {
  DraggableEdgeData,
  DraggableEdgeProps,
} from './DraggableEdge';

// Pre-configured edge types for ReactFlow
export const edgeTypes: EdgeTypes = {
  multiHandle: MultiHandleEdge,
  draggable: DraggableEdge,
  orthogonal: OrthogonalEdge,
  // Default edge type
  default: MultiHandleEdge,
};

// Export edge type names for dynamic selection
export const EDGE_TYPE_OPTIONS = [
  { value: 'multiHandle', label: 'Polyline (Draggable)', description: 'Multiple waypoints with draggable control points' },
  { value: 'orthogonal', label: 'Orthogonal (90°)', description: 'Right-angle routing with adjustable bends' },
  { value: 'draggable', label: 'Bezier Curve', description: 'Smooth curves with control points' },
] as const;
