// src/components/Flow/edgeTypes.ts

import type { EdgeTypes } from 'reactflow';
import MultiHandleEdge   from '@/components/MultiHandleEdge';
import DraggableEdge     from '@/components/DraggableEdge';

export const edgeTypes: EdgeTypes = {
  multiHandle: MultiHandleEdge,
  draggable:   DraggableEdge,
};
