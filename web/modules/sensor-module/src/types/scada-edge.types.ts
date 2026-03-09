/**
 * SCADA Builder Edge Types
 * Defines edge/connection types for the SCADA canvas
 */

import type { ConnectionType } from '../config/connectionTypes';

export type ScadaEdgeType = 'orthogonal' | 'multiHandle' | 'draggable';

export interface BendPoint {
  x: number;
  y: number;
  locked?: boolean;
}

export interface ControlPoint {
  x: number;
  y: number;
}

export interface ScadaEdgeData {
  connectionType: ConnectionType;
  label?: string;
  animated?: boolean;
  // Edge-type-specific data:
  bendPoints?: BendPoint[];        // orthogonal
  points?: BendPoint[];            // multiHandle (with locked flag)
  controlPoint?: ControlPoint;     // draggable (quadratic)
  controlPoint2?: ControlPoint;    // draggable (cubic)
  curveType?: 'quadratic' | 'cubic'; // draggable
  routingMode?: 'horizontal-first' | 'vertical-first' | 'auto'; // orthogonal
}

export interface ScadaEdge {
  id: string;
  source: string;         // widget ID
  target: string;         // widget ID
  sourceHandle: string;   // port ID (e.g. 'inlet', 'hot-in')
  targetHandle: string;   // port ID
  type: ScadaEdgeType;
  data: ScadaEdgeData;
}
