/**
 * SCADA Builder Edge Types Registry
 * Independent from process-editor edge components
 */

import MultiHandleEdge from './MultiHandleEdge';
import DraggableEdge from './DraggableEdge';
import OrthogonalEdge from './OrthogonalEdge';

export const scadaEdgeTypes = {
  multiHandle: MultiHandleEdge,
  draggable: DraggableEdge,
  orthogonal: OrthogonalEdge,
};

// Alias for ScreenCanvas compatibility
export const edgeTypes = scadaEdgeTypes;

export { MultiHandleEdge, DraggableEdge, OrthogonalEdge };
