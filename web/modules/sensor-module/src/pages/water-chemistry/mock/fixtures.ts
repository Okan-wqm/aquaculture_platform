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
