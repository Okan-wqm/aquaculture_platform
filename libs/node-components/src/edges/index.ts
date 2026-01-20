/**
 * Edge Components Index
 *
 * This file exports all edge components for use in ReactFlow applications.
 */

import type { EdgeTypes } from 'reactflow';

// Import edge components
import MultiHandleEdge from './MultiHandleEdge';
import OrthogonalEdge from './OrthogonalEdge';
import DraggableEdge from './DraggableEdge';

// Re-export individual edges
export {
  MultiHandleEdge,
  OrthogonalEdge,
  DraggableEdge,
};

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
