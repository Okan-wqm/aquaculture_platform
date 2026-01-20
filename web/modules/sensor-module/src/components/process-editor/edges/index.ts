/**
 * Edge Types Registry
 * Custom edge components for the process editor
 *
 * Available edge types:
 * - multiHandle: Polyline with draggable waypoints (default)
 * - draggable: Bezier curve with control points (quadratic/cubic)
 * - orthogonal: 90-degree angle routing
 */

import MultiHandleEdge, { MultiHandleEdgeData } from './MultiHandleEdge';
import DraggableEdge, { DraggableEdgeData } from './DraggableEdge';
import OrthogonalEdge, { OrthogonalEdgeData } from './OrthogonalEdge';

export const edgeTypes = {
  multiHandle: MultiHandleEdge,
  draggable: DraggableEdge,
  orthogonal: OrthogonalEdge,
};

export { MultiHandleEdge, DraggableEdge, OrthogonalEdge };
export type { MultiHandleEdgeData, DraggableEdgeData, OrthogonalEdgeData };
