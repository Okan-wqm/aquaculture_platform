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

/**
 * Tag-driven edge flow animation configuration.
 *
 * Binds the animated state of a pipe/edge to a process tag -- typically
 * the upstream pump's running state or the pipe's flow sensor value.
 *
 * Architecture:
 * - tagName:            the tag that drives animation (e.g. 'pump1_running')
 * - flowCondition:      when to animate:
 *                         'nonZero'  => any numeric value > 0
 *                         'boolean'  => truthy (1, true, "on")
 *                         'always'   => unconditional (backward-compat)
 * - flowSpeed:          CSS animation duration in seconds (lower = faster, default 2)
 * - reverseOnNegative:  reverse the flow direction when the tag value is negative
 *
 * When the tag value meets the flow condition the edge animates.
 * When it does not, the edge is static (no flow). This makes the SCADA
 * diagram accurately reflect the real process state.
 */
export interface EdgeFlowConfig {
  /** Tag name that controls this edge's flow animation */
  tagName?: string;
  /** When to show flow: 'nonZero' (val > 0), 'boolean' (truthy), 'always' (backward-compat) */
  flowCondition: 'nonZero' | 'boolean' | 'always';
  /** Animation speed: CSS animation-duration in seconds (default 2) */
  flowSpeed?: number;
  /** Reverse flow direction when tag value is negative */
  reverseOnNegative?: boolean;
}

export interface ScadaEdgeData {
  connectionType: ConnectionType;
  label?: string;
  animated?: boolean;
  /** Tag-driven flow animation binding. When present, overrides the static `animated` flag. */
  flowConfig?: EdgeFlowConfig;
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
