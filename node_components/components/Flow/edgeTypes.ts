// src/components/Flow/edgeTypes.ts

import type { EdgeTypes } from 'reactflow';
import MultiHandleEdge   from '../edges/MultiHandleEdge';
import DraggableEdge     from '../edges/DraggableEdge';
import OrthogonalEdge    from '../edges/OrthogonalEdge';

export const edgeTypes: EdgeTypes = {
  multiHandle: MultiHandleEdge,
  draggable:   DraggableEdge,
  orthogonal:  OrthogonalEdge,
  // Default edge type
  default:     MultiHandleEdge,
};
