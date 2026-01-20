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

// Sensor reading types
export type SensorType =
  | 'temperature'
  | 'ph'
  | 'dissolved_oxygen'
  | 'salinity'
  | 'ammonia'
  | 'nitrite'
  | 'nitrate'
  | 'turbidity'
  | 'water_level';

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
  status: 'draft' | 'active' | 'paused' | 'archived';
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

  // Sensor readings by equipment
  sensorReadings: Map<string, SensorReading[]>;

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
  sensorReadings: new Map<string, SensorReading[]>(),
  isLiveMode: true,
  isPanelOpen: false,
  lastUpdate: null,
};

export const useScadaStore = create<ScadaState>((set, get) => ({
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
    set((state) => {
      const newReadings = new Map(state.sensorReadings);
      newReadings.set(equipmentId, readings);
      return { sensorReadings: newReadings, lastUpdate: new Date() };
    }),

  updateSensorReading: (equipmentId, sensorId, value) =>
    set((state) => {
      const newReadings = new Map(state.sensorReadings);
      const equipmentReadings = newReadings.get(equipmentId);

      if (equipmentReadings) {
        const updatedReadings = equipmentReadings.map((reading) => {
          if (reading.sensorId === sensorId) {
            const oldValue = reading.value;
            const trend = value > oldValue ? 'up' : value < oldValue ? 'down' : 'stable';
            const status = getStatusFromValue(value, reading);

            // Add to history (keep last 60 readings)
            const history = [
              ...reading.history.slice(-59),
              { timestamp: new Date(), value },
            ];

            return {
              ...reading,
              value,
              trend,
              status,
              timestamp: new Date(),
              history,
            };
          }
          return reading;
        });
        newReadings.set(equipmentId, updatedReadings);
      }

      return { sensorReadings: newReadings, lastUpdate: new Date() };
    }),

  setIsLiveMode: (isLive) =>
    set({ isLiveMode: isLive }),

  setIsPanelOpen: (isOpen) =>
    set({ isPanelOpen: isOpen }),

  getEquipmentSensors: (equipmentId) => {
    return get().sensorReadings.get(equipmentId) || [];
  },

  resetStore: () =>
    set({
      ...initialState,
      sensorReadings: new Map<string, SensorReading[]>(),
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
export const useSelectedProcess = () => useScadaStore((state) => state.selectedProcess);
export const useSelectedEquipmentId = () => useScadaStore((state) => state.selectedEquipmentId);
export const useIsLiveMode = () => useScadaStore((state) => state.isLiveMode);
export const useIsPanelOpen = () => useScadaStore((state) => state.isPanelOpen);
export const useProcesses = () => useScadaStore((state) => state.processes);
