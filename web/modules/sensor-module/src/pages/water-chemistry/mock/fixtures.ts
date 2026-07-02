/**
 * Mock fixtures for Water-Chemistry Monitoring (P0).
 *
 * Shaped to the REAL entities so the later backend swap is data-source-only:
 *  - MockLoop mirrors farm-service System (id/name/type/siteId); `type` gates loop-sharing.
 *  - MockTank mirrors Tank (departmentId + optional systemId); siteId is resolved via
 *    department (tank has NO siteId column) — flattened here with that note.
 *  - MockBinding is a superset of WaterQualityParamEquipment (parameter→source→sensorId)
 *    plus the cascade fields (scopeType/scopeId) + SensorDataChannel `channelId`.
 *  - MockReading mirrors sensor_reading (value/timestamp/quality) + an offline flag.
 *
 * Nothing here fabricates a live value for a parameter with no binding — alkalinity/TAN/
 * H₂S are NOT in the sensor pipeline, so they are `manual` (or absent), never faked.
 */
import type { ParamKey } from '../types';

/** Mirrors farm-service SystemType (subset). Only recirculating types share loop water. */
export type LoopType = 'ras' | 'flow_through' | 'pond' | 'cage' | 'biofloc' | 'aquaponics';

/** System.type values that mean a shared-water recirculating loop. */
export const LOOP_SHARING_TYPES: ReadonlySet<LoopType> = new Set<LoopType>([
  'ras',
  'biofloc',
  'aquaponics',
]);

export interface MockSite {
  id: string;
  name: string;
}
export interface MockLoop {
  id: string;
  name: string;
  type: LoopType;
  siteId: string;
}
export interface MockTank {
  id: string;
  name: string;
  /** tank.department.siteId (flattened; tank has no siteId column). */
  siteId: string;
  /** tank.systemId — nullable; null = no loop tier. */
  loopId: string | null;
}

export type BindingScope = 'site' | 'loop' | 'tank';
export type BindingSource = 'sensor' | 'manual';

export interface MockBinding {
  parameter: ParamKey;
  scopeType: BindingScope;
  scopeId: string;
  source: BindingSource;
  /** for source==='sensor' */
  sensorId?: string;
  channelId?: string;
  /** for source==='manual' */
  manualValue?: number;
  manualAsOf?: string;
}

export interface MockReading {
  value: number;
  asOf: string;
  quality: number; // 0..100
  offline?: boolean;
}

export const UNITS: Record<ParamKey, string> = {
  temperature: '°C',
  salinity: 'ppt',
  ph: 'NBS',
  alkalinity: 'mg/L',
  calcium: 'mg/L',
  tan: 'mg/L',
  nitrate: 'mg/L',
  co2: 'mg/L',
  h2s: 'µg/L',
  dissolvedOxygen: 'mg/L',
};

const now = Date.now();
const iso = (minsAgo: number): string => new Date(now - minsAgo * 60_000).toISOString();

export const SITE: MockSite = { id: 'site-1', name: 'Suderra Demo Farm' };

export const LOOPS: MockLoop[] = [
  { id: 'loop-a', name: 'RAS Loop A (3 biofilters)', type: 'ras', siteId: 'site-1' },
  { id: 'loop-b', name: 'Flow-through Bank B', type: 'flow_through', siteId: 'site-1' },
];

export const TANKS: MockTank[] = [
  { id: 't1', name: 'Tank A-1', siteId: 'site-1', loopId: 'loop-a' },
  { id: 't2', name: 'Tank A-2', siteId: 'site-1', loopId: 'loop-a' },
  { id: 't3', name: 'Tank A-3 (own salinity)', siteId: 'site-1', loopId: 'loop-a' },
  { id: 't5', name: 'Tank A-5 (stale pH)', siteId: 'site-1', loopId: 'loop-a' },
  { id: 't7', name: 'Tank B-1 (flow-through)', siteId: 'site-1', loopId: 'loop-b' },
];

/**
 * Bindings. Loop-A shares temp/salinity/alk/calcium/TAN/nitrate at the loop; each tank
 * has its own pH + DO. Tank A-3 overrides salinity with its own sensor. Loop-B is
 * flow-through so loop-sharing is OFF — those tanks bind everything at tank level.
 */
export const BINDINGS: MockBinding[] = [
  // ---- Loop A (shared water) ----
  { parameter: 'temperature', scopeType: 'loop', scopeId: 'loop-a', source: 'sensor', sensorId: 'TMP-A', channelId: 'temperature' },
  { parameter: 'salinity', scopeType: 'loop', scopeId: 'loop-a', source: 'sensor', sensorId: 'SAL-A', channelId: 'salinity' },
  { parameter: 'nitrate', scopeType: 'loop', scopeId: 'loop-a', source: 'sensor', sensorId: 'NO3-A', channelId: 'nitrate' },
  { parameter: 'alkalinity', scopeType: 'loop', scopeId: 'loop-a', source: 'manual', manualValue: 120, manualAsOf: iso(180) },
  { parameter: 'calcium', scopeType: 'loop', scopeId: 'loop-a', source: 'manual', manualValue: 60, manualAsOf: iso(1440) },
  { parameter: 'tan', scopeType: 'loop', scopeId: 'loop-a', source: 'manual', manualValue: 0.5, manualAsOf: iso(120) },
  // Loop-A per-tank pH + DO
  { parameter: 'ph', scopeType: 'tank', scopeId: 't1', source: 'sensor', sensorId: 'PH-T1', channelId: 'ph' },
  { parameter: 'ph', scopeType: 'tank', scopeId: 't2', source: 'sensor', sensorId: 'PH-T2', channelId: 'ph' },
  { parameter: 'ph', scopeType: 'tank', scopeId: 't3', source: 'sensor', sensorId: 'PH-T3', channelId: 'ph' },
  { parameter: 'ph', scopeType: 'tank', scopeId: 't5', source: 'sensor', sensorId: 'PH-T5', channelId: 'ph' },
  { parameter: 'dissolvedOxygen', scopeType: 'tank', scopeId: 't1', source: 'sensor', sensorId: 'DO-T1', channelId: 'do' },
  { parameter: 'dissolvedOxygen', scopeType: 'tank', scopeId: 't2', source: 'sensor', sensorId: 'DO-T2', channelId: 'do' },
  { parameter: 'dissolvedOxygen', scopeType: 'tank', scopeId: 't3', source: 'sensor', sensorId: 'DO-T3', channelId: 'do' },
  { parameter: 'dissolvedOxygen', scopeType: 'tank', scopeId: 't5', source: 'sensor', sensorId: 'DO-T5', channelId: 'do' },
  // Tank A-3 salinity OVERRIDE (own sensor)
  { parameter: 'salinity', scopeType: 'tank', scopeId: 't3', source: 'sensor', sensorId: 'SAL-T3', channelId: 'salinity' },

  // ---- Loop B (flow-through → NOT shared; bind at tank level) ----
  { parameter: 'temperature', scopeType: 'tank', scopeId: 't7', source: 'sensor', sensorId: 'TMP-T7', channelId: 'temperature' },
  { parameter: 'salinity', scopeType: 'tank', scopeId: 't7', source: 'sensor', sensorId: 'SAL-T7', channelId: 'salinity' },
  { parameter: 'ph', scopeType: 'tank', scopeId: 't7', source: 'sensor', sensorId: 'PH-T7', channelId: 'ph' },
  { parameter: 'dissolvedOxygen', scopeType: 'tank', scopeId: 't7', source: 'sensor', sensorId: 'DO-T7', channelId: 'do' },
  { parameter: 'alkalinity', scopeType: 'tank', scopeId: 't7', source: 'manual', manualValue: 90, manualAsOf: iso(240) },

  // ---- Site-level toxic/target context (manual) ----
  { parameter: 'h2s', scopeType: 'site', scopeId: 'site-1', source: 'manual', manualValue: 5, manualAsOf: iso(600) },
];

/** Live sensor readings keyed by `${sensorId}:${channelId}`. */
export const READINGS: Record<string, MockReading> = {
  'TMP-A:temperature': { value: 14.2, asOf: iso(1), quality: 99 },
  'SAL-A:salinity': { value: 12.0, asOf: iso(2), quality: 98 },
  'NO3-A:nitrate': { value: 45, asOf: iso(3), quality: 96 },
  'PH-T1:ph': { value: 7.4, asOf: iso(1), quality: 97 },
  'PH-T2:ph': { value: 7.1, asOf: iso(1), quality: 97 },
  'PH-T3:ph': { value: 7.6, asOf: iso(2), quality: 95 },
  'PH-T5:ph': { value: 6.8, asOf: iso(42), quality: 90 }, // STALE (>15 min old)
  'DO-T1:do': { value: 8.9, asOf: iso(1), quality: 99 },
  'DO-T2:do': { value: 7.2, asOf: iso(1), quality: 99 },
  'DO-T3:do': { value: 6.1, asOf: iso(1), quality: 99 },
  'DO-T5:do': { value: 5.4, asOf: iso(1), quality: 40 }, // BAD-QUALITY
  'SAL-T3:salinity': { value: 18.0, asOf: iso(2), quality: 98 }, // override value differs from loop
  'TMP-T7:temperature': { value: 16.8, asOf: iso(1), quality: 99 },
  'SAL-T7:salinity': { value: 30.0, asOf: iso(1), quality: 98 },
  'PH-T7:ph': { value: 7.9, asOf: iso(1), quality: 97 },
  'DO-T7:do': { value: 9.5, asOf: iso(1), quality: 99, offline: true }, // OFFLINE
};

export const ALL_PARAMS: ParamKey[] = [
  'temperature',
  'salinity',
  'ph',
  'alkalinity',
  'calcium',
  'tan',
  'nitrate',
  'dissolvedOxygen',
  'co2',
  'h2s',
];

// ============================================================================
// CARD CANVAS mock catalog (P2): connected sensors + species→limit templates
// ============================================================================

/** A connected sensor channel available to bind as a card parameter source. */
export interface SensorCatalogEntry {
  id: string;
  label: string;
  parameter: ParamKey;
  channelId: string; // READINGS key suffix
  tankId?: string;
  loopId?: string;
  siteId?: string;
}

/** Mirrors the existing sensors; scope binding = tank / loop / site (denormalized like sensor.entity). */
export const SENSOR_CATALOG: SensorCatalogEntry[] = [
  { id: 'TMP-A', label: 'Loop-A Temp', parameter: 'temperature', channelId: 'temperature', loopId: 'loop-a' },
  { id: 'SAL-A', label: 'Loop-A Salinity', parameter: 'salinity', channelId: 'salinity', loopId: 'loop-a' },
  { id: 'NO3-A', label: 'Loop-A Nitrate', parameter: 'nitrate', channelId: 'nitrate', loopId: 'loop-a' },
  { id: 'PH-T1', label: 'Tank A-1 pH', parameter: 'ph', channelId: 'ph', tankId: 't1' },
  { id: 'PH-T2', label: 'Tank A-2 pH', parameter: 'ph', channelId: 'ph', tankId: 't2' },
  { id: 'PH-T3', label: 'Tank A-3 pH', parameter: 'ph', channelId: 'ph', tankId: 't3' },
  { id: 'PH-T5', label: 'Tank A-5 pH', parameter: 'ph', channelId: 'ph', tankId: 't5' },
  { id: 'DO-T1', label: 'Tank A-1 DO', parameter: 'dissolvedOxygen', channelId: 'do', tankId: 't1' },
  { id: 'DO-T2', label: 'Tank A-2 DO', parameter: 'dissolvedOxygen', channelId: 'do', tankId: 't2' },
  { id: 'DO-T3', label: 'Tank A-3 DO', parameter: 'dissolvedOxygen', channelId: 'do', tankId: 't3' },
  { id: 'DO-T5', label: 'Tank A-5 DO', parameter: 'dissolvedOxygen', channelId: 'do', tankId: 't5' },
  { id: 'SAL-T3', label: 'Tank A-3 Salinity', parameter: 'salinity', channelId: 'salinity', tankId: 't3' },
  { id: 'TMP-T7', label: 'Tank B-1 Temp', parameter: 'temperature', channelId: 'temperature', tankId: 't7' },
  { id: 'SAL-T7', label: 'Tank B-1 Salinity', parameter: 'salinity', channelId: 'salinity', tankId: 't7' },
  { id: 'PH-T7', label: 'Tank B-1 pH', parameter: 'ph', channelId: 'ph', tankId: 't7' },
  { id: 'DO-T7', label: 'Tank B-1 DO', parameter: 'dissolvedOxygen', channelId: 'do', tankId: 't7' },
];

/** Sensors available to a card scope for a given parameter (tank sees its loop + site too). */
export function sensorsForScope(
  scope: { kind: 'tank' | 'biofilter'; id: string },
  parameter: ParamKey,
): SensorCatalogEntry[] {
  const loopId = scope.kind === 'biofilter' ? scope.id : TANKS.find((t) => t.id === scope.id)?.loopId ?? undefined;
  const tankId = scope.kind === 'tank' ? scope.id : undefined;
  return SENSOR_CATALOG.filter(
    (s) => s.parameter === parameter && (
      (tankId && s.tankId === tankId) || (loopId && s.loopId === loopId) || s.siteId != null
    ),
  );
}

export interface SpeciesTemplate {
  id: string;
  name: string;
  limits: {
    tan: number; nh3Limit: number; co2Toxic: number; h2sLimitUgL: number;
    caMgL: number; targetPh: number; targetAlk: number;
  };
}

/** Mirrors farm-service parameter-templates.data.ts (subset) — default limits per species, editable. */
export const SPECIES_TEMPLATES: SpeciesTemplate[] = [
  { id: 'salmon_freshwater', name: 'Salmon Freshwater', limits: { tan: 0.5, nh3Limit: 0.0125, co2Toxic: 15, h2sLimitUgL: 5, caMgL: 40, targetPh: 7.0, targetAlk: 80 } },
  { id: 'salmon_seawater', name: 'Salmon Seawater', limits: { tan: 0.5, nh3Limit: 0.02, co2Toxic: 20, h2sLimitUgL: 5, caMgL: 400, targetPh: 7.8, targetAlk: 120 } },
  { id: 'sea_bass', name: 'Sea Bass / Sea Bream', limits: { tan: 0.6, nh3Limit: 0.025, co2Toxic: 25, h2sLimitUgL: 8, caMgL: 400, targetPh: 7.9, targetAlk: 130 } },
  { id: 'shrimp', name: 'Shrimp', limits: { tan: 1.0, nh3Limit: 0.05, co2Toxic: 30, h2sLimitUgL: 2, caMgL: 350, targetPh: 7.8, targetAlk: 140 } },
  { id: 'tilapia', name: 'Tilapia', limits: { tan: 2.0, nh3Limit: 0.1, co2Toxic: 40, h2sLimitUgL: 10, caMgL: 60, targetPh: 7.0, targetAlk: 100 } },
];

export const SAMPLING_PRESETS = ['Inlet', 'Outlet', 'Before biofilter', 'After biofilter', 'Sump'] as const;
