/**
 * SCADA Types - Local type definitions to avoid ReactFlow import in main bundle
 */

// Equipment node data structure (shared with iframe canvas via postMessage)
export interface EquipmentNodeData {
  equipmentId: string;
  equipmentName: string;
  equipmentCode: string;
  equipmentType: string;
  equipmentCategory: string;
  status: string;
  specifications?: Record<string, unknown>;
  icon?: string;
}

// Connection types for different edge purposes
export type ConnectionType = 'pipe' | 'cable' | 'signal' | 'default';

// Edge data structure
export interface ProcessEdgeData {
  connectionType: ConnectionType;
  label?: string;
  flowRate?: number;
  flowUnit?: string;
}

// Simplified Node type for SCADA (matches ReactFlow structure)
export interface ScadaNode<T = EquipmentNodeData> {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: T;
  selected?: boolean;
  draggable?: boolean;
  connectable?: boolean;
  selectable?: boolean;
  width?: number;
  height?: number;
}

// Simplified Edge type for SCADA (matches ReactFlow structure)
export interface ScadaEdge<T = ProcessEdgeData> {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  type?: string;
  animated?: boolean;
  data?: T;
  style?: Record<string, unknown>;
  label?: string;
  labelStyle?: Record<string, unknown>;
  markerEnd?: unknown;
  markerStart?: unknown;
}
