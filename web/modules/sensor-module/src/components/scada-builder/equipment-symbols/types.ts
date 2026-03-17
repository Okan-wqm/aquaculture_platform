import type { EquipmentState, EquipmentConnectionPoint } from '../../../types/scada-widget.types';

// ViewBox dimensions for each equipment subtype (used for handle alignment)
export const EQUIPMENT_VIEWBOX: Record<string, { width: number; height: number }> = {
  // Pumps — 100×100
  centrifugalPump:  { width: 100, height: 100 },
  gearPump:         { width: 100, height: 100 },
  diaphragmPump:    { width: 100, height: 100 },
  pistonPump:       { width: 100, height: 100 },
  submersiblePump:  { width: 100, height: 100 },
  vacuumPump:       { width: 100, height: 100 },
  turbinePump:      { width: 100, height: 100 },
  screwPump:        { width: 100, height: 100 },
  peristalticPump:  { width: 100, height: 100 },
  blowerPump:       { width: 100, height: 100 },
  jetPump:          { width: 100, height: 100 },
  vanePump:         { width: 100, height: 100 },
  // Valves — 100×80
  gateValve:        { width: 100, height: 80 },
  ballValve:        { width: 100, height: 80 },
  butterflyValve:   { width: 100, height: 80 },
  globeValve:       { width: 100, height: 80 },
  checkValve:       { width: 100, height: 80 },
  reliefValve:      { width: 100, height: 80 },
  controlValve:     { width: 100, height: 80 },
  needleValve:      { width: 100, height: 80 },
  solenoidValve:    { width: 100, height: 80 },
  threeWayValve:    { width: 100, height: 100 },
  pinchValve:       { width: 100, height: 80 },
  diaphragmValve:   { width: 100, height: 80 },
  plugValve:        { width: 100, height: 80 },
  // Tanks — various
  verticalTank:     { width: 100, height: 140 },
  horizontalTank:   { width: 140, height: 100 },
  conicalBottomTank: { width: 100, height: 140 },
  pressureVessel:   { width: 140, height: 100 },
  silo:             { width: 100, height: 140 },
  mixingTank:       { width: 100, height: 140 },
  // Heat Exchangers
  shellAndTube:     { width: 140, height: 100 },
  plateHeatExchanger: { width: 140, height: 100 },
  airCooler:        { width: 140, height: 100 },
  condenser:        { width: 100, height: 120 },
  evaporator:       { width: 100, height: 120 },
  // Compressors
  pistonCompressor:       { width: 120, height: 100 },
  screwCompressor:        { width: 120, height: 100 },
  centrifugalCompressor:  { width: 100, height: 100 },
  diaphragmCompressor:    { width: 100, height: 100 },
  // Motors
  acMotor:    { width: 100, height: 100 },
  vfdMotor:   { width: 120, height: 100 },
  servoMotor: { width: 120, height: 100 },
  // Filters
  bagFilter:      { width: 100, height: 140 },
  drumFilter:     { width: 120, height: 100 },
  membraneFilter: { width: 120, height: 100 },
  // Instruments
  pressureTransmitter:    { width: 80, height: 100 },
  flowTransmitter:        { width: 80, height: 100 },
  levelTransmitter:       { width: 80, height: 100 },
  temperatureTransmitter: { width: 80, height: 100 },
  // Animated
  animatedGear:     { width: 100, height: 100 },
  animatedConveyor: { width: 140, height: 80 },
};

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
  turbinePump: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'top', offset: 0.5, direction: 'out' },
  ],
  screwPump: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.5, direction: 'out' },
  ],
  peristalticPump: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.5, direction: 'out' },
  ],
  blowerPump: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.35, direction: 'out' },
  ],
  jetPump: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'motive', label: 'Motive', side: 'top', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.5, direction: 'out' },
  ],
  vanePump: [
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
  threeWayValve: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet-1', label: 'Çıkış 1', side: 'right', offset: 0.5, direction: 'out' },
    { id: 'outlet-2', label: 'Çıkış 2', side: 'bottom', offset: 0.5, direction: 'out' },
  ],
  pinchValve: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.5, direction: 'out' },
  ],
  diaphragmValve: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.5, direction: 'out' },
  ],
  plugValve: [
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
  // Compressors
  pistonCompressor: [
    { id: 'inlet', label: 'Giriş', side: 'top', offset: 0.25, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'top', offset: 0.46, direction: 'out' },
  ],
  screwCompressor: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.5, direction: 'out' },
  ],
  centrifugalCompressor: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.52, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.3, direction: 'out' },
  ],
  diaphragmCompressor: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.3, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.3, direction: 'out' },
  ],
  // Motors
  acMotor: [
    { id: 'shaft', label: 'Mil', side: 'right', offset: 0.5, direction: 'out' },
  ],
  vfdMotor: [
    { id: 'shaft', label: 'Mil', side: 'right', offset: 0.5, direction: 'out' },
  ],
  servoMotor: [
    { id: 'shaft', label: 'Mil', side: 'right', offset: 0.5, direction: 'out' },
    { id: 'feedback', label: 'Feedback', side: 'top', offset: 0.5, direction: 'out' },
  ],
  // Filters
  bagFilter: [
    { id: 'inlet', label: 'Giriş', side: 'top', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'bottom', offset: 0.5, direction: 'out' },
  ],
  drumFilter: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.7, direction: 'in' },
    { id: 'filtrate', label: 'Filtrat', side: 'bottom', offset: 0.5, direction: 'out' },
  ],
  membraneFilter: [
    { id: 'feed', label: 'Besleme', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'retentate', label: 'Retantat', side: 'right', offset: 0.5, direction: 'out' },
    { id: 'permeate', label: 'Permeat', side: 'bottom', offset: 0.5, direction: 'out' },
  ],
  // Instruments
  pressureTransmitter: [
    { id: 'process', label: 'Proses', side: 'bottom', offset: 0.5, direction: 'in' },
    { id: 'signal', label: 'Sinyal', side: 'top', offset: 0.5, direction: 'out' },
  ],
  flowTransmitter: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.78, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.78, direction: 'out' },
    { id: 'signal', label: 'Sinyal', side: 'top', offset: 0.5, direction: 'out' },
  ],
  levelTransmitter: [
    { id: 'hi', label: 'Üst', side: 'left', offset: 0.8, direction: 'in' },
    { id: 'lo', label: 'Alt', side: 'right', offset: 0.8, direction: 'in' },
    { id: 'signal', label: 'Sinyal', side: 'top', offset: 0.5, direction: 'out' },
  ],
  temperatureTransmitter: [
    { id: 'process', label: 'Proses', side: 'left', offset: 0.8, direction: 'in' },
    { id: 'signal', label: 'Sinyal', side: 'top', offset: 0.5, direction: 'out' },
  ],
  // Animated
  animatedGear: [
    { id: 'inlet', label: 'Giriş', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Çıkış', side: 'right', offset: 0.5, direction: 'out' },
  ],
  animatedConveyor: [
    { id: 'feed', label: 'Besleme', side: 'left', offset: 0.3, direction: 'in' },
    { id: 'discharge', label: 'Deşarj', side: 'right', offset: 0.3, direction: 'out' },
  ],
  // ── Process Equipment Widgets ──
  feeder: [
    { id: 'inlet', label: 'Feed In', side: 'top', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Feed Out', side: 'bottom', offset: 0.5, direction: 'out' },
    { id: 'control', label: 'Control', side: 'right', offset: 0.5, direction: 'in' },
  ],
  radialFilter: [
    { id: 'inlet', label: 'Inlet', side: 'left', offset: 0.3, direction: 'in' },
    { id: 'outlet', label: 'Outlet', side: 'right', offset: 0.4, direction: 'out' },
    { id: 'drain', label: 'Drain', side: 'bottom', offset: 0.5, direction: 'out' },
  ],
  cleanWaterTank: [
    { id: 'inlet', label: 'Inlet', side: 'left', offset: 0.3, direction: 'in' },
    { id: 'outlet', label: 'Outlet', side: 'right', offset: 0.7, direction: 'out' },
    { id: 'level', label: 'Level', side: 'right', offset: 0.3, direction: 'out' },
    { id: 'drain', label: 'Drain', side: 'bottom', offset: 0.5, direction: 'out' },
  ],
  dirtyWaterTank: [
    { id: 'inlet', label: 'Inlet', side: 'left', offset: 0.3, direction: 'in' },
    { id: 'outlet', label: 'Outlet', side: 'right', offset: 0.7, direction: 'out' },
    { id: 'drain', label: 'Drain', side: 'bottom', offset: 0.5, direction: 'out' },
  ],
  mbbr: [
    { id: 'inlet', label: 'Inlet', side: 'left', offset: 0.4, direction: 'in' },
    { id: 'outlet', label: 'Outlet', side: 'right', offset: 0.4, direction: 'out' },
    { id: 'air', label: 'Air Supply', side: 'bottom', offset: 0.5, direction: 'in' },
  ],
  hepaFilter: [
    { id: 'inlet', label: 'Air In', side: 'left', offset: 0.5, direction: 'in' },
    { id: 'outlet', label: 'Air Out', side: 'right', offset: 0.5, direction: 'out' },
  ],
  cornellDualDrain: [
    { id: 'inlet-1', label: 'Inlet 1', side: 'top', offset: 0.35, direction: 'in' },
    { id: 'inlet-2', label: 'Inlet 2', side: 'top', offset: 0.65, direction: 'in' },
    { id: 'center-drain', label: 'Center Drain', side: 'bottom', offset: 0.45, direction: 'out' },
    { id: 'side-drain', label: 'Side Drain', side: 'right', offset: 0.6, direction: 'out' },
  ],
};
