import type { EquipmentState, EquipmentConnectionPoint } from '../../../types/scada-widget.types';

export interface EquipmentSymbolProps {
  state: EquipmentState;
  width: number;
  height: number;
  rotation?: number; // 0 | 90 | 180 | 270
  showConnectionPoints?: boolean;
  label?: string;
}

// State-based color system (P&ID standard)
export const EQUIPMENT_STATE_COLORS: Record<EquipmentState, { fill: string; stroke: string }> = {
  running: { fill: '#dcfce7', stroke: '#22c55e' },
  open:    { fill: '#dcfce7', stroke: '#22c55e' },
  stopped: { fill: '#f3f4f6', stroke: '#9ca3af' },
  closed:  { fill: '#f3f4f6', stroke: '#9ca3af' },
  fault:   { fill: '#fef2f2', stroke: '#ef4444' },
};

// Connection point colors
export const CONNECTION_POINT_COLORS = {
  in:    '#3b82f6', // blue for inlet
  out:   '#f97316', // orange for outlet
  inout: '#8b5cf6', // purple for bidirectional
} as const;

// CONNECTION_POINTS registry - maps each subtype to its connection points
// Use exact EquipmentSubType keys
export const CONNECTION_POINTS: Record<string, EquipmentConnectionPoint[]> = {
  // Pumps - left(inlet), right(outlet)
  centrifugalPump: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.5, direction: 'out' },
  ],
  gearPump: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.5, direction: 'out' },
  ],
  diaphragmPump: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.5, direction: 'out' },
  ],
  pistonPump: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.5, direction: 'out' },
  ],
  submersiblePump: [
    { id: 'inlet', label: 'Giriş', side: 'bottom', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'top', offset: 0.5, direction: 'out' },
  ],
  vacuumPump: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.5, direction: 'out' },
  ],
  // Valves - left(inlet), right(outlet) mostly
  gateValve: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.5, direction: 'out' },
  ],
  ballValve: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.5, direction: 'out' },
  ],
  butterflyValve: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.5, direction: 'out' },
  ],
  globeValve: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.5, direction: 'out' },
  ],
  checkValve: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.5, direction: 'out' },
  ],
  reliefValve: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'top', offset: 0.5, direction: 'out' },
  ],
  controlValve: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.5, direction: 'out' },
  ],
  needleValve: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.5, direction: 'out' },
  ],
  solenoidValve: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.5, direction: 'out' },
  ],
  // Tanks
  verticalTank: [
    { id: 'inlet', label: 'Giriş', side: 'top', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'bottom', offset: 0.5, direction: 'out' },
    { id: 'level', label: 'Seviye', side: 'left', offset: 0.5, direction: 'out' },
    { id: 'drain', label: 'Dren', side: 'right', offset: 0.8, direction: 'out' },
  ],
  horizontalTank: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.5, direction: 'out' },
    { id: 'vent', label: 'Havalandırma', side: 'top', offset: 0.5, direction: 'out' },
    { id: 'drain', label: 'Dren', side: 'bottom', offset: 0.5, direction: 'out' },
  ],
  conicalBottomTank: [
    { id: 'inlet', label: 'Giriş', side: 'top', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'bottom', offset: 0.5, direction: 'out' },
    { id: 'level', label: 'Seviye', side: 'left', offset: 0.5, direction: 'out' },
  ],
  pressureVessel: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.5, direction: 'out' },
    { id: 'vent', label: 'Havalandırma', side: 'top', offset: 0.5, direction: 'out' },
  ],
  silo: [
    { id: 'inlet', label: 'Giriş', side: 'top', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'bottom', offset: 0.5, direction: 'out' },
  ],
  mixingTank: [
    { id: 'inlet', label: 'Giriş', side: 'top', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'bottom', offset: 0.5, direction: 'out' },
    { id: 'additive', label: 'Katkı', side: 'left', offset: 0.3, direction: 'in' },
    { id: 'drain', label: 'Dren', side: 'right', offset: 0.8, direction: 'out' },
  ],
  // Heat Exchangers
  shellAndTube: [
    { id: 'hot-in', label: 'Sıcak Giriş', side: 'left', offset: 0.25, direction: 'in' },
    { id: 'hot-out', label: 'Sıcak Çıkış', side: 'right', offset: 0.25, direction: 'out' },
    { id: 'cold-in', label: 'Soğuk Giriş', side: 'left', offset: 0.75, direction: 'in' },
    { id: 'cold-out', label: 'Soğuk Çıkış', side: 'right', offset: 0.75, direction: 'out' },
  ],
  plateHeatExchanger: [
    { id: 'hot-in', label: 'Sıcak Giriş', side: 'left', offset: 0.25, direction: 'in' },
    { id: 'hot-out', label: 'Sıcak Çıkış', side: 'right', offset: 0.75, direction: 'out' },
    { id: 'cold-in', label: 'Soğuk Giriş', side: 'right', offset: 0.25, direction: 'in' },
    { id: 'cold-out', label: 'Soğuk Çıkış', side: 'left', offset: 0.75, direction: 'out' },
  ],
  airCooler: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.5, direction: 'out' },
    { id: 'air', label: 'Hava', side: 'top', offset: 0.5, direction: 'in' },
  ],
  condenser: [
    { id: 'vapor-in', label: 'Buhar Giriş', side: 'top', offset: 0.5, direction: 'in' },
    { id: 'liquid-out', label: 'Sıvı Çıkış', side: 'bottom', offset: 0.5, direction: 'out' },
    { id: 'coolant-in', label: 'Soğutucu Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'coolant-out', label: 'Soğutucu Çıkış', side: 'right', offset: 0.5, direction: 'out' },
  ],
  evaporator: [
    { id: 'liquid-in', label: 'Sıvı Giriş', side: 'bottom', offset: 0.5, direction: 'in' },
    { id: 'vapor-out', label: 'Buhar Çıkış', side: 'top', offset: 0.5, direction: 'out' },
    { id: 'heat-in', label: 'Isı Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'heat-out', label: 'Isı Çıkış', side: 'right', offset: 0.5, direction: 'out' },
  ],
};
