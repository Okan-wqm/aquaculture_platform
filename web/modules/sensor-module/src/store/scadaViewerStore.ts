/**
 * Zustand store for SCADA View state management
 */

import { create } from 'zustand';
import {
  ScadaNode,
  ScadaEdge,
  EquipmentNodeData,
  ProcessEdgeData,
} from '../types/scada-types';

// Sensor reading types - synchronized with backend SensorType enum
export type SensorType =
  | 'temperature'
  | 'ph'
  | 'dissolved_oxygen'
  | 'salinity'
  | 'ammonia'
  | 'nitrite'
  | 'nitrate'
  | 'turbidity'
  | 'water_level'
  | 'multi_parameter'
  | 'flow_rate'
  | 'conductivity'
  | 'orp'
  | 'chlorine'
  | 'co2';

export type SensorStatus = 'normal' | 'warning' | 'critical' | 'offline';

export interface SensorReading {
  id: string;
  sensorId: string;
  sensorName: string;
  type: SensorType;
  value: number;
  unit: string;
  status: SensorStatus;
  minValue: number;
  maxValue: number;
  warningLow?: number;
  warningHigh?: number;
  criticalLow?: number;
  criticalHigh?: number;
  timestamp: Date;
  trend: 'up' | 'down' | 'stable';
  history: { timestamp: Date; value: number }[];
}

export interface EquipmentSensors {
  equipmentId: string;
  sensors: SensorReading[];
}

// Process definition for SCADA view
export interface ScadaProcess {
  id: string;
  name: string;
  description?: string;
  // BUG-018: align with useProcess.ts ProcessStatus type — use 'inactive', not 'paused'
  status: 'draft' | 'active' | 'inactive' | 'archived';
  nodes: ScadaNode<EquipmentNodeData>[];
  edges: ScadaEdge<ProcessEdgeData>[];
}

// SCADA store state
interface ScadaState {
  // Selected process
  selectedProcessId: string | null;
  selectedProcess: ScadaProcess | null;
  processes: ScadaProcess[];

  // Selected equipment for detail panel
  selectedEquipmentId: string | null;

  // PERF-008: Use plain Record instead of Map so Zustand shallow-equality and
  // fine-grained selectors work correctly.  Object spread only copies the top-level
  // keys (one entry per equipment), whereas `new Map(state.sensorReadings)` had to
  // iterate every entry to build a new Map instance on every single sensor update.
  sensorReadings: Record<string, SensorReading[]>;

  // UI state
  isLiveMode: boolean;
  isPanelOpen: boolean;
  lastUpdate: Date | null;

  // Actions
  setSelectedProcessId: (id: string | null) => void;
  loadProcess: (process: ScadaProcess) => void;
  setProcesses: (processes: ScadaProcess[]) => void;
  setSelectedEquipmentId: (id: string | null) => void;
  setSensorReadings: (equipmentId: string, readings: SensorReading[]) => void;
  updateSensorReading: (equipmentId: string, sensorId: string, value: number) => void;
  setIsLiveMode: (isLive: boolean) => void;
  setIsPanelOpen: (isOpen: boolean) => void;
  getEquipmentSensors: (equipmentId: string) => SensorReading[];
  resetStore: () => void;
}

// Initial state
const initialState = {
  selectedProcessId: null,
  selectedProcess: null,
  processes: [],
  selectedEquipmentId: null,
  // PERF-008: plain object — no Map constructor overhead
  sensorReadings: {} as Record<string, SensorReading[]>,
  isLiveMode: true,
  isPanelOpen: false,
  lastUpdate: null,
};

export const useScadaViewerStore = create<ScadaState>((set, get) => ({
  ...initialState,

  setSelectedProcessId: (id) => {
    const process = get().processes.find((p) => p.id === id) || null;
    set({
      selectedProcessId: id,
      selectedProcess: process,
      selectedEquipmentId: null,
    });
  },

  loadProcess: (process) =>
    set({
      selectedProcessId: process.id,
      selectedProcess: process,
      selectedEquipmentId: null,
    }),

  setProcesses: (processes) =>
    set((state) => {
      // If a process is currently selected, update it with fresh data
      let updatedSelectedProcess = state.selectedProcess;
      if (state.selectedProcessId) {
        const freshProcess = processes.find((p) => p.id === state.selectedProcessId);
        if (freshProcess) {
          updatedSelectedProcess = freshProcess;
        }
      }
      return { processes, selectedProcess: updatedSelectedProcess };
    }),

  setSelectedEquipmentId: (id) =>
    set({
      selectedEquipmentId: id,
      isPanelOpen: id !== null,
    }),

  setSensorReadings: (equipmentId, readings) =>
    set((state) => ({
      // PERF-008: object spread — only one new top-level key is touched
      sensorReadings: { ...state.sensorReadings, [equipmentId]: readings },
      lastUpdate: new Date(),
    })),

  updateSensorReading: (equipmentId, sensorId, value) =>
    set((state) => {
      // PERF-008: avoid full collection clone — only update the one equipment slice.
      // Object spread copies keys by reference for every entry except [equipmentId],
      // so unaffected equipment slices are the same reference and components that
      // select state.sensorReadings[otherEquipmentId] will not re-render.
      const equipmentReadings = state.sensorReadings[equipmentId];
      if (!equipmentReadings) return { lastUpdate: new Date() };

      const updatedReadings = equipmentReadings.map((reading) => {
        if (reading.sensorId === sensorId) {
          const oldValue = reading.value;
          const trend: SensorReading['trend'] = value > oldValue ? 'up' : value < oldValue ? 'down' : 'stable';
          const status = getStatusFromValue(value, reading);
          const history = [
            ...reading.history.slice(-59),
            { timestamp: new Date(), value },
          ];
          return { ...reading, value, trend, status, timestamp: new Date(), history };
        }
        return reading;
      });

      return {
        sensorReadings: { ...state.sensorReadings, [equipmentId]: updatedReadings },
        lastUpdate: new Date(),
      };
    }),

  setIsLiveMode: (isLive) =>
    set({ isLiveMode: isLive }),

  setIsPanelOpen: (isOpen) =>
    set({ isPanelOpen: isOpen }),

  getEquipmentSensors: (equipmentId) => {
    return get().sensorReadings[equipmentId] || [];
  },

  resetStore: () =>
    set({
      ...initialState,
      sensorReadings: {} as Record<string, SensorReading[]>,
    }),
}));

// Helper function to determine status from value
function getStatusFromValue(value: number, reading: SensorReading): SensorStatus {
  if (reading.criticalLow !== undefined && value < reading.criticalLow) return 'critical';
  if (reading.criticalHigh !== undefined && value > reading.criticalHigh) return 'critical';
  if (reading.warningLow !== undefined && value < reading.warningLow) return 'warning';
  if (reading.warningHigh !== undefined && value > reading.warningHigh) return 'warning';
  return 'normal';
}

// Selector hooks
export const useSelectedProcess = () => useScadaViewerStore((state) => state.selectedProcess);
export const useSelectedEquipmentId = () => useScadaViewerStore((state) => state.selectedEquipmentId);
export const useIsLiveMode = () => useScadaViewerStore((state) => state.isLiveMode);
export const useIsPanelOpen = () => useScadaViewerStore((state) => state.isPanelOpen);
export const useProcesses = () => useScadaViewerStore((state) => state.processes);

// PERF-008: Fine-grained equipment-scoped selector.
// SensorPanel uses this so it only re-renders when its OWN equipment's readings change,
// not on every other sensor update across the SCADA page.
export const useEquipmentReadings = (equipmentId: string | null) =>
  useScadaViewerStore((state) =>
    equipmentId ? (state.sensorReadings[equipmentId] ?? []) : []
  );
