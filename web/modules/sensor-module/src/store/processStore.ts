/**
 * Zustand store for Process Editor state management
 */

import { HOST_SOURCE } from '../canvas-contract';
import { create } from 'zustand';
import {
  Node,
  Edge,
  Connection,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  NodeChange,
  EdgeChange,
} from '@xyflow/react';
import {
  ConnectionPointPosition,
  ConnectionPointType,
} from '../components/equipment-icons/equipmentTypes';
import { ConnectionType, DEFAULT_CONNECTION_TYPE } from '../config/connectionTypes';

// Connection point state for each node
export interface ConnectionPointState {
  top: ConnectionPointType;
  right: ConnectionPointType;
  bottom: ConnectionPointType;
  left: ConnectionPointType;
}

// Default connection point configuration
export const DEFAULT_CONNECTION_POINTS: ConnectionPointState = {
  top: 'input',
  right: 'output',
  bottom: 'output',
  left: 'input',
};

// Sensor mapping for equipment nodes
export interface SensorMapping {
  sensorId: string;
  sensorName: string;
  channelId: string;
  channelName: string;
  dataPath: string;
  dataType: string;
  unit?: string;
}

// Display type options for sensor visualization
export type SensorDisplayType = 'gauge' | 'numeric' | 'badge' | 'sparkline';

// Sensor node data structure (for linking real sensors to canvas nodes)
export interface SensorNodeData extends Record<string, unknown> {
  // Sensor identification
  sensorId?: string;
  sensorName?: string;
  sensorType?: string;
  sensorUnit?: string;
  parentDeviceId?: string;
  parentDeviceName?: string;
  dataPath?: string;
  serialNumber?: string;
  status?: string;

  // Display configuration
  displayType?: SensorDisplayType;
  customName?: string;           // User-defined name for this node

  // Value range
  minValue?: number;
  maxValue?: number;
  precision?: number;            // Decimal places (default: 1)
  displayUnit?: string;          // Override unit for display

  // Alarm thresholds
  alarmsEnabled?: boolean;
  warningLow?: number;
  warningHigh?: number;
  criticalLow?: number;
  criticalHigh?: number;

  // Live data (updated at runtime)
  currentValue?: number;
  lastUpdated?: string;
}

// -----------------------------------------------------------------------
// I/O Binding: bir equipment node'unun fiziksel I/O kanalına bağlanması.
// Process editor'da ekipman seçilip edge device + I/O tag eşlendiğinde
// bu yapı node data'ya yazılır. Canlı değerler overlay'de gösterilir.
// -----------------------------------------------------------------------
/**
 * I/O tag tipi — IEC 61131-3 standart I/O sınıflandırması.
 * Backend'deki IoType enum ile senkronize olmalı (device-io-config.entity.ts).
 * useEdgeDevices.ts'deki IoType enum ile de tutarlı.
 */
export type IoBindingType = 'DI' | 'DO' | 'AI' | 'AO';

/**
 * I/O veri tipi — PLC/edge agent'ın kullandığı veri genişliği.
 * Backend'deki IoDataType enum ile senkronize olmalı.
 */
export type IoBindingDataType = 'BOOL' | 'INT16' | 'INT32' | 'UINT16' | 'UINT32' | 'FLOAT32' | 'FLOAT64';

export interface IoBinding {
  ioConfigId: string;          // DeviceIoConfig.id (backend UUID)
  tagName: string;             // İnsan-okunur tag adı, ör: "pump1_speed"
  ioType: IoBindingType;       // DI/DO/AI/AO — string yerine union type ile tip güvenliği
  dataType: IoBindingDataType; // PLC veri tipi — string yerine union type ile tip güvenliği
}

// Equipment node data structure
export interface EquipmentNodeData extends Record<string, unknown> {
  // equipmentId is only set when node is linked to real equipment
  // Undefined/null means node is a template (not linked)
  equipmentId?: string;
  equipmentName?: string;
  equipmentCode?: string;
  equipmentType?: string;
  equipmentCategory?: string;
  status?: string;
  specifications?: Record<string, unknown>;
  icon?: string;
  // Template type ID (for unlinked template nodes)
  templateTypeId?: string;
  // Display label for the node
  label?: string;
  // Connection point configuration
  connectionPoints?: ConnectionPointState;
  // Sensor mappings for this equipment
  sensorMappings?: SensorMapping[];

  // -----------------------------------------------------------------------
  // Edge Device Binding (Faz A — Kemik Yapı)
  // Equipment node'u fiziksel bir edge device'a bağlar.
  // Bu sayede node üzerinden canlı I/O verisi gösterilebilir
  // ve kontrol komutları (DO toggle, VFD start/stop) gönderilebilir.
  // -----------------------------------------------------------------------
  edgeDeviceId?: string;     // EdgeDevice.id UUID
  edgeDeviceCode?: string;   // EdgeDevice.deviceCode (MQTT topic'te kullanılır)

  // I/O tag binding'leri — bu node'a bağlı fiziksel I/O kanalları.
  // Her binding bir DeviceIoConfig kaydına referans verir.
  ioBindings?: IoBinding[];
}

// Handle type for new node components
export type HandleType = 'source' | 'target';

// Handle configuration for BaseNode
export interface HandleConfig {
  id: string;
  type: HandleType;
  position: { x: number; y: number };
}

// Blower node data
export interface BlowerNodeData extends Record<string, unknown> {
  inlet?: HandleType;
  outlet?: HandleType;
  rotation?: number;
  label?: string;
}

// Drum Filter node data
export interface DrumFilterNodeData extends Record<string, unknown> {
  inletType1?: HandleType;
  inletType2?: HandleType;
  inletType3?: HandleType;
  drainType?: HandleType;
  outlet?: HandleType;
  label?: string;
}

// UV Unit node data
export interface UVUnitNodeData extends Record<string, unknown> {
  rotation?: number;
  handles?: HandleConfig[];
  label?: string;
}

// Tank Inlet node data
export interface TankInletNodeData extends Record<string, unknown> {
  top?: HandleType;
  bottom?: HandleType;
  rotation?: number;
  label?: string;
}

// Radial Settler node data
export interface RadialSettlerNodeData extends Record<string, unknown> {
  label?: string;
  leftType?: HandleType;
  rightType?: HandleType;
  bottomType?: HandleType;
}

// Fish Tank node data
export interface FishTankNodeData extends Record<string, unknown> {
  label?: string;
  width?: number;
  height?: number;
  pipeHeight?: number;
  tankStroke?: string;
  waterColor?: string;
  pipeColor?: string;
}

// Connection Point node data
export interface ConnectionPointNodeData extends Record<string, unknown> {
  topType?: HandleType;
  bottomType?: HandleType;
  leftType?: HandleType;
  rightType?: HandleType;
  fillColor?: string;
  strokeColor?: string;
  label?: string;
}

// Sensor Widget node data
export interface SensorWidgetNodeData extends Record<string, unknown> {
  label?: string;
  widgetName?: string;
  subtitle?: string;
  unit?: string;
  value?: number | string;
  scaleMax?: number;
  lowThreshold?: number;
  highThreshold?: number;
  mode?: 'push' | 'poll' | 'onChange';
  mqttUrl?: string;
  mqttTopic?: string;
  httpUrl?: string;
  pollInterval?: number;
}

// Flow source properties (for nodes that can be water/air sources)
export interface FlowSourceData {
  isWaterSource?: boolean;
  flowRate?: number;
  isAirSource?: boolean;
  airFlowRate?: number;
  calculatedFlow?: number;
  calculatedAirFlow?: number;
  outflowDistribution?: Record<string, number>;
}

// Union type for all node data types
// Her node tipi burada olmalı — eksik tip olursa TypeScript dar tip çıkarımı bozulur
export type ProcessNodeData =
  | EquipmentNodeData
  | BlowerNodeData
  | DrumFilterNodeData
  | UVUnitNodeData
  | TankInletNodeData
  | RadialSettlerNodeData
  | FishTankNodeData
  | ConnectionPointNodeData
  | SensorWidgetNodeData
  | SensorNodeData
  | FlowSourceData;

// Edge data structure (ConnectionType imported from config/connectionTypes.ts)
export interface ProcessEdgeData extends Record<string, unknown> {
  connectionType: ConnectionType;
  label?: string;
  flowRate?: number;
  flowUnit?: string;
}

// Saved process structure
export interface SavedProcess {
  id: string;
  name: string;
  description?: string;
  version: string;
  status: 'draft' | 'active' | 'inactive' | 'archived';
  nodes: Node<EquipmentNodeData>[];
  edges: Edge<ProcessEdgeData>[];
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
}

// Process store state
interface ProcessState {
  // Process metadata
  processId: string | null;
  processName: string;
  processDescription: string;
  processVersion: string;
  // BUG-018: align with useProcess.ts ProcessStatus — use 'inactive' not 'paused'
  processStatus: 'draft' | 'active' | 'inactive' | 'archived';

  // ReactFlow state - uses any for flexibility with different node types
  nodes: Node<any>[];
  edges: Edge<ProcessEdgeData>[];

  // UI state
  selectedNode: Node<any> | null;
  selectedEdge: Edge<ProcessEdgeData> | null;
  isDirty: boolean;
  isSaving: boolean;

  // Equipment linking state
  equipmentNodeMap: Record<string, string>; // equipmentId -> nodeId

  // Sensor linking state
  sensorNodeMap: Record<string, string>; // sensorId -> nodeId

  // Actions - Process metadata
  setProcessId: (id: string | null) => void;
  setProcessName: (name: string) => void;
  setProcessDescription: (description: string) => void;
  setProcessStatus: (status: 'draft' | 'active' | 'inactive' | 'archived') => void;

  // Actions - Nodes
  setNodes: (nodes: Node<any>[]) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  addNode: (node: Node<any>) => void;
  removeNode: (nodeId: string) => void;
  updateNodeData: (nodeId: string, data: Record<string, any>) => void;
  updateConnectionPointType: (nodeId: string, pointId: ConnectionPointPosition, newType: ConnectionPointType) => void;

  // Actions - Sensor Mappings
  addSensorMapping: (nodeId: string, mapping: SensorMapping) => void;
  removeSensorMapping: (nodeId: string, channelId: string) => void;

  // Actions - Equipment Linking
  linkEquipmentToNode: (nodeId: string, equipmentId: string, equipmentData: Partial<EquipmentNodeData>) => void;
  unlinkEquipmentFromNode: (nodeId: string) => void;
  isEquipmentLinked: (equipmentId: string) => boolean;
  getLinkedNodeId: (equipmentId: string) => string | undefined;
  highlightNode: (nodeId: string) => void;
  syncNodeToCanvas: (nodeId: string, data: Record<string, any>) => void;

  // Actions - Sensor Linking
  linkSensorToNode: (nodeId: string, sensorId: string, sensorData: SensorNodeData) => void;
  unlinkSensorFromNode: (nodeId: string) => void;
  isSensorLinked: (sensorId: string) => boolean;
  getLinkedSensorNodeId: (sensorId: string) => string | undefined;
  rebuildSensorNodeMap: () => void;

  // Actions - Edges
  setEdges: (edges: Edge<ProcessEdgeData>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  removeEdge: (edgeId: string) => void;
  updateEdgeData: (edgeId: string, data: Partial<ProcessEdgeData>) => void;
  syncEdgeToCanvas: (edgeId: string, data: Partial<ProcessEdgeData>) => void;

  // Actions - Selection
  selectNode: (node: Node<any> | null) => void;
  selectEdge: (edge: Edge<ProcessEdgeData> | null) => void;

  // Actions - Save/Load
  loadProcess: (process: SavedProcess) => void;
  getProcessData: () => Omit<SavedProcess, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'>;
  resetStore: () => void;
  setIsSaving: (saving: boolean) => void;
  markClean: () => void;
  rebuildEquipmentNodeMap: () => void;
}

// Initial state
const initialState = {
  processId: null,
  processName: '',
  processDescription: '',
  processVersion: '1.0.0',
  processStatus: 'draft' as const,
  nodes: [],
  edges: [],
  selectedNode: null,
  selectedEdge: null,
  isDirty: false,
  isSaving: false,
  equipmentNodeMap: {} as Record<string, string>,
  sensorNodeMap: {} as Record<string, string>,
};

export const useProcessStore = create<ProcessState>((set, get) => ({
  ...initialState,

  // Process metadata actions
  setProcessId: (id) => set({ processId: id }),

  setProcessName: (name) =>
    set({ processName: name, isDirty: true }),

  setProcessDescription: (description) =>
    set({ processDescription: description, isDirty: true }),

  setProcessStatus: (status) =>
    set({ processStatus: status, isDirty: true }),

  // Node actions
  setNodes: (nodes) =>
    set({ nodes, isDirty: true }),

  onNodesChange: (changes) =>
    set((state) => ({
      nodes: applyNodeChanges(changes, state.nodes) as Node<any>[],
      isDirty: true,
    })),

  addNode: (node) =>
    set((state) => ({
      nodes: [...state.nodes, node],
      isDirty: true,
    })),

  removeNode: (nodeId) =>
    set((state) => {
      // Find the node to get its equipmentId for cleanup
      const node = state.nodes.find((n) => n.id === nodeId);
      const equipmentId = node?.data?.equipmentId;
      const newMap = { ...state.equipmentNodeMap };
      if (equipmentId) {
        delete newMap[equipmentId];
      }

      return {
        nodes: state.nodes.filter((n) => n.id !== nodeId),
        edges: state.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
        selectedNode: state.selectedNode?.id === nodeId ? null : state.selectedNode,
        equipmentNodeMap: newMap,
        isDirty: true,
      };
    }),

  updateNodeData: (nodeId, data) => {
    set((state) => {
      const updatedNodes = state.nodes.map((node) =>
        node.id === nodeId
          ? { ...node, data: { ...node.data, ...data } }
          : node
      );
      // Also update selectedNode if it's the same node
      const updatedSelectedNode =
        state.selectedNode?.id === nodeId
          ? { ...state.selectedNode, data: { ...state.selectedNode.data, ...data } }
          : state.selectedNode;
      return {
        nodes: updatedNodes,
        selectedNode: updatedSelectedNode,
        isDirty: true,
      };
    });
    // Sync to canvas iframe
    get().syncNodeToCanvas(nodeId, data);
  },

  updateConnectionPointType: (nodeId, pointId, newType) =>
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              data: {
                ...node.data,
                connectionPoints: {
                  ...node.data.connectionPoints,
                  [pointId]: newType,
                },
              },
            }
          : node
      ),
      isDirty: true,
    })),

  // Sensor mapping actions
  addSensorMapping: (nodeId, mapping) =>
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              data: {
                ...node.data,
                sensorMappings: [
                  ...(node.data.sensorMappings || []),
                  mapping,
                ],
              },
            }
          : node
      ),
      isDirty: true,
    })),

  removeSensorMapping: (nodeId, channelId) =>
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              data: {
                ...node.data,
                sensorMappings: (node.data.sensorMappings || []).filter(
                  (m: SensorMapping) => m.channelId !== channelId
                ),
              },
            }
          : node
      ),
      isDirty: true,
    })),

  // Edge actions
  setEdges: (edges) =>
    set({ edges, isDirty: true }),

  onEdgesChange: (changes) =>
    set((state) => ({
      edges: applyEdgeChanges(changes, state.edges) as Edge<ProcessEdgeData>[],
      isDirty: true,
    })),

  onConnect: (connection) =>
    set((state) => ({
      edges: addEdge(
        {
          ...connection,
          data: { connectionType: DEFAULT_CONNECTION_TYPE },
          type: 'smoothstep',
          animated: true,
        },
        state.edges
      ) as Edge<ProcessEdgeData>[],
      isDirty: true,
    })),

  removeEdge: (edgeId) =>
    set((state) => ({
      edges: state.edges.filter((e) => e.id !== edgeId),
      selectedEdge: state.selectedEdge?.id === edgeId ? null : state.selectedEdge,
      isDirty: true,
    })),

  updateEdgeData: (edgeId, data) => {
    set((state) => ({
      edges: state.edges.map((edge) =>
        edge.id === edgeId
          ? { ...edge, data: { ...edge.data, ...data } as ProcessEdgeData }
          : edge
      ),
      isDirty: true,
    }));
    // Sync to canvas iframe
    get().syncEdgeToCanvas(edgeId, data);
  },

  // Sync an edge's data to the canvas iframe
  syncEdgeToCanvas: (edgeId: string, data: Partial<ProcessEdgeData>) => {
    const iframe = document.querySelector('iframe[title="Process Editor Canvas"]') as HTMLIFrameElement;
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage(
        { type: 'updateEdgeData', data: { edgeId, data }, source: HOST_SOURCE },
        window.location.origin
      );
    }
  },

  // Selection actions
  selectNode: (node) =>
    set({ selectedNode: node, selectedEdge: null }),

  selectEdge: (edge) =>
    set({ selectedEdge: edge, selectedNode: null }),

  // Save/Load actions
  loadProcess: (process) => {
    // BUG-003: rebuild both maps from loaded node data so isEquipmentLinked/isSensorLinked work correctly
    const equipmentNodeMap: Record<string, string> = {};
    const sensorNodeMap: Record<string, string> = {};
    process.nodes.forEach((node) => {
      if (node.data?.equipmentId) equipmentNodeMap[node.data.equipmentId] = node.id;
      const sensorId = (node.data as any)?.sensorId as string | undefined;
      if (sensorId) sensorNodeMap[sensorId] = node.id;
    });
    set({
      processId: process.id,
      processName: process.name,
      processDescription: process.description || '',
      processVersion: process.version,
      processStatus: process.status,
      nodes: process.nodes,
      edges: process.edges,
      selectedNode: null,
      selectedEdge: null,
      isDirty: false,
      equipmentNodeMap,
      sensorNodeMap,
    });
  },

  getProcessData: () => {
    const state = get();
    return {
      name: state.processName,
      description: state.processDescription,
      version: state.processVersion,
      status: state.processStatus,
      nodes: state.nodes,
      edges: state.edges,
    };
  },

  resetStore: () =>
    set(initialState),

  setIsSaving: (saving) =>
    set({ isSaving: saving }),

  markClean: () =>
    set({ isDirty: false }),

  // Equipment linking actions
  linkEquipmentToNode: (nodeId, equipmentId, equipmentData) => {
    const updatedData = { ...equipmentData, equipmentId };
    set((state) => {
      // Clear any previous mapping for this node
      const newMap = { ...state.equipmentNodeMap };
      Object.keys(newMap).forEach((eqId) => {
        if (newMap[eqId] === nodeId) {
          delete newMap[eqId];
        }
      });
      // Add new mapping
      newMap[equipmentId] = nodeId;

      const updatedNodes = state.nodes.map((node) =>
        node.id === nodeId
          ? { ...node, data: { ...node.data, ...updatedData } }
          : node
      );
      // Also update selectedNode if it's the same node
      const updatedSelectedNode =
        state.selectedNode?.id === nodeId
          ? { ...state.selectedNode, data: { ...state.selectedNode.data, ...updatedData } }
          : state.selectedNode;

      return {
        nodes: updatedNodes,
        selectedNode: updatedSelectedNode,
        equipmentNodeMap: newMap,
        isDirty: true,
      };
    });
    // Sync to canvas iframe
    get().syncNodeToCanvas(nodeId, updatedData);
  },

  unlinkEquipmentFromNode: (nodeId) => {
    // Equipment unlink edildiğinde tüm bağlı verileri temizle:
    // - Equipment kimliği (equipmentId, equipmentName, equipmentCode)
    // - Edge device bağlantısı (edgeDeviceId, edgeDeviceCode)
    // - I/O tag binding'leri (ioBindings)
    // Bu temizlik yapılmazsa orphan referanslar kalır ve
    // re-link sırasında eski device/IO verileri görünür.
    const clearedData = {
      equipmentId: undefined,
      equipmentName: undefined,
      equipmentCode: undefined,
      status: undefined,
      edgeDeviceId: undefined,
      edgeDeviceCode: undefined,
      ioBindings: [],
    };
    set((state) => {
      const node = state.nodes.find((n) => n.id === nodeId);
      const equipmentId = node?.data?.equipmentId;
      const newMap = { ...state.equipmentNodeMap };
      if (equipmentId) {
        delete newMap[equipmentId];
      }

      const updatedNodes = state.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, ...clearedData } }
          : n
      );
      // Also update selectedNode if it's the same node
      const updatedSelectedNode =
        state.selectedNode?.id === nodeId
          ? { ...state.selectedNode, data: { ...state.selectedNode.data, ...clearedData } }
          : state.selectedNode;

      return {
        nodes: updatedNodes,
        selectedNode: updatedSelectedNode,
        equipmentNodeMap: newMap,
        isDirty: true,
      };
    });
    // Sync to canvas iframe
    get().syncNodeToCanvas(nodeId, clearedData);
  },

  isEquipmentLinked: (equipmentId) => !!get().equipmentNodeMap[equipmentId],

  getLinkedNodeId: (equipmentId) => get().equipmentNodeMap[equipmentId],

  // Highlight a node on the canvas (sends message to iframe)
  highlightNode: (nodeId: string) => {
    // Post message to canvas iframe to highlight the node
    const iframe = document.querySelector('iframe[title="Process Editor Canvas"]') as HTMLIFrameElement;
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage(
        { type: 'highlightNode', data: nodeId, source: HOST_SOURCE },
        window.location.origin
      );
    }
  },

  // Sync a node's data to the canvas iframe
  syncNodeToCanvas: (nodeId: string, data: Record<string, any>) => {
    const iframe = document.querySelector('iframe[title="Process Editor Canvas"]') as HTMLIFrameElement;
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage(
        { type: 'updateNodeData', data: { nodeId, data }, source: HOST_SOURCE },
        window.location.origin
      );
    }
  },

  // Rebuild equipment node map from nodes (useful after loading a process)
  rebuildEquipmentNodeMap: () =>
    set((state) => {
      const newMap: Record<string, string> = {};
      state.nodes.forEach((node) => {
        if (node.data?.equipmentId) {
          newMap[node.data.equipmentId] = node.id;
        }
      });
      return { equipmentNodeMap: newMap };
    }),

  // Sensor linking actions
  linkSensorToNode: (nodeId, sensorId, sensorData) => {
    const updatedData = { ...sensorData, sensorId };
    set((state) => {
      // Clear any previous sensor mapping for this node
      const newMap = { ...state.sensorNodeMap };
      Object.keys(newMap).forEach((sId) => {
        if (newMap[sId] === nodeId) {
          delete newMap[sId];
        }
      });
      // Add new mapping
      newMap[sensorId] = nodeId;

      const updatedNodes = state.nodes.map((node) =>
        node.id === nodeId
          ? { ...node, data: { ...node.data, ...updatedData } }
          : node
      );
      // Also update selectedNode if it's the same node
      const updatedSelectedNode =
        state.selectedNode?.id === nodeId
          ? { ...state.selectedNode, data: { ...state.selectedNode.data, ...updatedData } }
          : state.selectedNode;

      return {
        nodes: updatedNodes,
        selectedNode: updatedSelectedNode,
        sensorNodeMap: newMap,
        isDirty: true,
      };
    });
    // Sync to canvas iframe
    get().syncNodeToCanvas(nodeId, updatedData);
  },

  unlinkSensorFromNode: (nodeId) => {
    const clearedData: SensorNodeData = {
      sensorId: undefined,
      sensorName: undefined,
      sensorType: undefined,
      sensorUnit: undefined,
      parentDeviceId: undefined,
      parentDeviceName: undefined,
      dataPath: undefined,
      serialNumber: undefined,
      status: undefined,
    };
    set((state) => {
      const node = state.nodes.find((n) => n.id === nodeId);
      const sensorId = node?.data?.sensorId;
      const newMap = { ...state.sensorNodeMap };
      if (sensorId) {
        delete newMap[sensorId];
      }

      const updatedNodes = state.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, ...clearedData } }
          : n
      );
      // Also update selectedNode if it's the same node
      const updatedSelectedNode =
        state.selectedNode?.id === nodeId
          ? { ...state.selectedNode, data: { ...state.selectedNode.data, ...clearedData } }
          : state.selectedNode;

      return {
        nodes: updatedNodes,
        selectedNode: updatedSelectedNode,
        sensorNodeMap: newMap,
        isDirty: true,
      };
    });
    // Sync to canvas iframe
    get().syncNodeToCanvas(nodeId, clearedData);
  },

  isSensorLinked: (sensorId) => !!get().sensorNodeMap[sensorId],

  getLinkedSensorNodeId: (sensorId) => get().sensorNodeMap[sensorId],

  // Rebuild sensor node map from nodes (useful after loading a process)
  rebuildSensorNodeMap: () =>
    set((state) => {
      const newMap: Record<string, string> = {};
      state.nodes.forEach((node) => {
        if (node.data?.sensorId) {
          newMap[node.data.sensorId] = node.id;
        }
      });
      return { sensorNodeMap: newMap };
    }),
}));

// Selector hooks for common access patterns
export const useProcessNodes = () => useProcessStore((state) => state.nodes);
export const useProcessEdges = () => useProcessStore((state) => state.edges);
export const useSelectedNode = () => useProcessStore((state) => state.selectedNode);
export const useSelectedEdge = () => useProcessStore((state) => state.selectedEdge);
export const useProcessMetadata = () =>
  useProcessStore((state) => ({
    id: state.processId,
    name: state.processName,
    description: state.processDescription,
    version: state.processVersion,
    status: state.processStatus,
  }));
export const useIsDirty = () => useProcessStore((state) => state.isDirty);
