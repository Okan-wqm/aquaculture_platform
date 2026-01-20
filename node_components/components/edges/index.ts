/**
 * Edge Types Registry
 * Exports all available edge types for ReactFlow
 */

import MultiHandleEdge from './MultiHandleEdge';
import DraggableEdge from './DraggableEdge';
import OrthogonalEdge from './OrthogonalEdge';

export { MultiHandleEdge, DraggableEdge, OrthogonalEdge };

/**
 * Edge types object for ReactFlow
 * Usage: <ReactFlow edgeTypes={edgeTypes} />
 */
export const edgeTypes = {
  multiHandle: MultiHandleEdge,
  draggable: DraggableEdge,
  orthogonal: OrthogonalEdge,
  // Default to multiHandle for polyline routing
  default: MultiHandleEdge,
};

/**
 * Edge type identifiers
 */
export type EdgeTypeId = 'multiHandle' | 'draggable' | 'orthogonal' | 'default';

/**
 * Edge type configuration for UI
 */
export interface EdgeTypeConfig {
  id: EdgeTypeId;
  label: string;
  description: string;
  icon?: string;
}

export const EDGE_TYPE_OPTIONS: EdgeTypeConfig[] = [
  {
    id: 'multiHandle',
    label: 'Polyline',
    description: 'Coklu noktali duz cizgi - P&ID standart',
  },
  {
    id: 'orthogonal',
    label: 'Orthogonal',
    description: '90 derece koseli otomatik routing',
  },
  {
    id: 'draggable',
    label: 'Bezier',
    description: 'Yumusak egri - tek veya cift kontrol noktasi',
  },
];

export default edgeTypes;
