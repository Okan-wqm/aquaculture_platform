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
}

/**
 * Shape of the data carried on each edge.
 */
export interface FlowEdgeData {
  label: string;
}
