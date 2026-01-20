// src/components/Flow/types.ts

// import type { ComponentType } from 'react';
// import type { NodeProps, NodeTypes, EdgeTypes } from 'reactflow';
import type { NodeTypes } from 'reactflow';

import { loadNodeTypes } from '@/utils/loadNodeTypes';
export { edgeTypes } from './edgeTypes'; // ← make sure this file exists!

/**
 * Dynamically load every .tsx in /src/components/nodes/*
 * into a nodeTypes map, once at module‐scope.
 */
export const nodeTypes: NodeTypes = loadNodeTypes() as NodeTypes;

/**
 * All the data fields that any node in this canvas may carry.
 */
export interface FlowNodeData {
  // GenericNode props
  svgName?: string;
  width?:   number;
  height?:  number;

  // Shared display fields
  label?:    string;
  subtitle?: string;
  unit?:     string;

  // SensorWidget props
  mqttUrl?:      string;
  mqttTopic?:    string;
  mode?:         'push' | 'poll' | 'onChange';
  httpUrl?:      string;
  pollInterval?: number;
  value?:        number | string;
  scaleMax?:     number;
  lowThreshold?: number;
  highThreshold?: number;

  // Inspector only
  outflowDistribution?: Record<string, number>;
  isWaterSource?:       boolean;
  flowRate?:            number;
  isAirSource?:         boolean;
  airFlowRate?:         number;
  calculatedFlow?:      number;
  calculatedAirFlow?:   number;

  // Equipment node props
  equipmentType?: string;
  equipmentName?: string;
  equipmentCode?: string;
  status?: string;
  connectionPoints?: {
    top?: 'input' | 'output';
    right?: 'input' | 'output';
    bottom?: 'input' | 'output';
    left?: 'input' | 'output';
  };

  // Rotation support (for rotatable nodes)
  rotation?: number;

  // Handle type toggles (for nodes with toggleable handles)
  top?: 'source' | 'target';
  right?: 'source' | 'target';
  bottom?: 'source' | 'target';
  left?: 'source' | 'target';
  leftType?: 'source' | 'target';
  rightType?: 'source' | 'target';
  bottomType?: 'source' | 'target';
  inletType?: 'source' | 'target';
  outletType?: 'source' | 'target';
  pipeLeftType?: 'source' | 'target';
  pipeRightType?: 'source' | 'target';
}

/**
 * Shape of the data carried on each edge.
 */
export interface FlowEdgeData {
  label?: string;
  // Connection type for P&ID styling (ISA-5.1 standard)
  connectionType?: 'process-pipe' | 'electrical' | 'pneumatic' | 'hydraulic' |
                   'instrument' | 'data-link' | 'capillary' | 'steam' | 'drain-vent';
  // Waypoints for multi-handle and orthogonal edges
  points?: Array<{ x: number; y: number; locked?: boolean }>;
  // For orthogonal edges
  bendPoints?: Array<{ x: number; y: number }>;
  // Control points for bezier/draggable edges
  controlPoint?: { x: number; y: number };
  controlPoint2?: { x: number; y: number }; // For cubic bezier
  // Guide lines visibility (for draggable edge)
  showGuides?: boolean;
}
