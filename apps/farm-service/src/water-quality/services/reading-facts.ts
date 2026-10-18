import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { isLoopHomogeneous } from '@aquaculture/shared-contracts';
import type { EntityManager } from 'typeorm';

import { holdsSiteWater } from '../data/water-chemistry-input-sets';
import { MACHINE_MEASUREMENT_SOURCES } from '../entities/water-quality-measurement.entity';
import {
  type ChannelSourcePriority,
  MeasurementPosition,
  WaterQualityParamEquipment,
} from '../entities/water-quality-param-equipment.entity';
import type { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';

import { type FarmArrangement, loadFarmArrangement } from './channel-placement';
import { measurementUnitMatchSql } from './measurement-unit-reader';
import {
  liveChannelsAtLocation,
  locationOf,
  type MeasurementPoint,
  representativeLocation,
  type SourceLocation,
} from './parameter-sources';
import type { ManualCandidateFacts } from './reading-resolution';

/**
 * The facts the reading resolver decides on, gathered for many locations at
 * once (FARM-MEDIUM-447): whatever the number of locations and asks, a fixed
 * number of statements in the caller's tenant read —
 *
 * - the inheritance chains: two farm-arrangement reads (the asked units, then
 *   the loops they and the asked systems are in), only when an ask inherits;
 * - every place's live channel sources: one read;
 * - every place's latest manual sample of every asked code: one read.
 *
 * One location is a batch of one, so a single point and a site's units are
 * read by the same code (parameter-reading-resolver.service.ts).
 */

/** One parameter to read at a location, in a unit, no older than a window (null: any age). */
export interface ParameterReadAsk {
  readonly parameter: WaterQualityParameterConfig;
  readonly unit: string;
  readonly maxAgeMs: number | null;
}

/** A location and the asks read there. */
export interface ReadingRequest<Ask extends ParameterReadAsk> {
  readonly location: SourceLocation;
  readonly asks: readonly Ask[];
}

/** A level of the chain before its channels are described. */
export interface GatheredLevel {
  readonly location: SourceLocation;
  readonly inherited: boolean;
  readonly sources: readonly ChannelSourceRow[];
  readonly manual: ManualCandidateFacts | null;
}

export type ChannelSourceRow = WaterQualityParamEquipment & {
  sensorId: string;
  channelKey: string;
  priority: ChannelSourcePriority;
};

/** A place of a request's chain, at its depth, and the asks that reach it. */
interface Reach<Ask extends ParameterReadAsk> {
  readonly place: SourceLocation;
  readonly depth: number;
  readonly askers: readonly Ask[];
}

/** Whether an ask's quantity may be inherited from the loop or the site (D2). */
function inherits(ask: ParameterReadAsk): boolean {
  return (
    ask.parameter.effectiveQuantity !== null && isLoopHomogeneous(ask.parameter.effectiveQuantity)
  );
}

/** Per request (in order), each of its asks (in order) with its levels. */
export async function gatherReadingFacts<Ask extends ParameterReadAsk>(
  manager: EntityManager,
  tenantId: string,
  requests: readonly ReadingRequest<Ask>[],
  asOf: Date,
): Promise<{ ask: Ask; levels: GatheredLevel[] }[][]> {
  const chains = await readingChains(
    manager,
    tenantId,
    requests.map(({ location, asks }) => ({ location, inherit: asks.some(inherits) })),
  );
  const reaches: Reach<Ask>[][] = requests.map(({ asks }, index) =>
    (chains[index] ?? []).map((place, depth) => ({
      place,
      depth,
      askers: asks.filter((ask) => depth === 0 || inherits(ask)),
    })),
  );
  const every = reaches.flat();
  const sources = await liveChannelSources(manager, tenantId, every);
  const samples = await latestManualSamples(manager, tenantId, every, asOf);
  return requests.map(({ asks }, index) =>
    asks.map((ask) => ({
      ask,
      levels: (reaches[index] ?? [])
        .filter(({ depth }) => depth === 0 || inherits(ask))
        .map(({ place, depth }) => ({
          location: place,
          inherited: depth > 0,
          sources: (sources.get(locationKey(place)) ?? []).filter(
            (source) => source.parameterConfigId === ask.parameter.id,
          ),
          manual:
            samples.get(
              sampleKey(sampledKindOf(place.point), place.point.id, ask.parameter.code),
            ) ?? null,
        })),
    })),
  );
}

/** A location's identity: its point, position and depth. */
function locationKey(location: SourceLocation): string {
  const { point, position, depthM } = location;
  return `${point.kind}|${point.id}|${position}|${depthM === null ? '' : String(depthM)}`;
}

/**
 * Every reached place's live channel sources of the parameters asked there,
 * in one read (an OR of each place's predicate, liveChannelsAtLocation, the
 * one spelling of "live channels at a location"), grouped by location in
 * bind order.
 */
async function liveChannelSources(
  manager: EntityManager,
  tenantId: string,
  reaches: readonly Reach<ParameterReadAsk>[],
): Promise<Map<string, ChannelSourceRow[]>> {
  const wanted = new Map<string, { location: SourceLocation; parameterIds: Set<string> }>();
  for (const { place, askers } of reaches) {
    if (askers.length === 0) continue;
    const key = locationKey(place);
    const entry = wanted.get(key) ?? { location: place, parameterIds: new Set<string>() };
    for (const ask of askers) entry.parameterIds.add(ask.parameter.id);
    wanted.set(key, entry);
  }
  const byLocation = new Map<string, ChannelSourceRow[]>();
  if (wanted.size === 0) {
    return byLocation;
  }
  const rows = await tenantManagerRepo(manager, WaterQualityParamEquipment, tenantId).find({
    where: [...wanted.values()].map(({ location, parameterIds }) =>
      liveChannelsAtLocation([...parameterIds], location),
    ),
    order: { boundAt: 'ASC' },
  });
  for (const row of rows) {
    if (!isChannelSource(row)) continue;
    const key = locationKey(locationOf(row));
    const at = byLocation.get(key) ?? [];
    at.push(row);
    byLocation.set(key, at);
  }
  return byLocation;
}

/** A channel source row: the channel-source CHECK makes all three present together. */
function isChannelSource(source: WaterQualityParamEquipment): source is ChannelSourceRow {
  return source.sensorId !== null && source.channelKey !== null && source.priority !== null;
}

/**
 * The places a loop-homogeneous value may be inherited from (D2,
 * FARM-HIGH-381), read from farm's topology now (the arrangement placement
 * uses), per wanted location in order; a location that does not inherit is
 * its own chain:
 *
 * - a tank or equipment in exactly one live system: that system; then its
 *   site only when the system's type says it holds site water (OPEN in
 *   SYSTEM_WATER_OF_TYPE: flow-through, raceway, pond, cage). A
 *   recirculating loop is isolated from site water (nitrification consumes
 *   its alkalinity and calcium, its salinity drifts, its temperature is its
 *   own), and a hatchery, nursery or "other" system may be one, so neither
 *   takes the intake's value (FARM-HIGH-381, FARM-MEDIUM-383);
 * - a tank or equipment in no live system: its site;
 * - a tank or equipment in two or more live systems: nothing — which loop's
 *   water it holds is not known;
 * - a system: its site, only when its type says it holds site water.
 */
async function readingChains(
  manager: EntityManager,
  tenantId: string,
  wanted: readonly { readonly location: SourceLocation; readonly inherit: boolean }[],
): Promise<SourceLocation[][]> {
  const inheriting = wanted
    .filter(({ inherit, location }) => inherit && location.point.kind !== 'site')
    .map(({ location }) => location.point);
  const topology = await loadUnitLoops(
    manager,
    tenantId,
    inheriting.filter((point) => point.kind !== 'system').map((point) => point.id),
    inheriting.filter((point) => point.kind === 'system').map((point) => point.id),
  );
  return wanted.map(({ location, inherit }) =>
    inherit ? chainOf(location, topology) : [location],
  );
}

function chainOf(location: SourceLocation, topology: UnitLoops): SourceLocation[] {
  const { point } = location;
  if (point.kind === 'site') {
    return [location];
  }
  const ancestors: MeasurementPoint[] = [];
  if (point.kind === 'system') {
    const siteId = topology.loops.siteOfSystem.get(point.id);
    const type = topology.loops.typeOfSystem.get(point.id);
    if (siteId !== undefined && type !== undefined && holdsSiteWater(type)) {
      ancestors.push({ kind: 'site', id: siteId });
    }
  } else {
    const live = liveLoopsOf(point.id, topology);
    if (live.length > 1) {
      return [location];
    }
    const [systemId] = live;
    const type = systemId === undefined ? undefined : topology.loops.typeOfSystem.get(systemId);
    if (systemId !== undefined) ancestors.push({ kind: 'system', id: systemId });
    const siteId = topology.units.siteOfUnit.get(point.id);
    if (siteId !== undefined && (type === undefined || holdsSiteWater(type))) {
      ancestors.push({ kind: 'site', id: siteId });
    }
  }
  return [location, ...ancestors.map(representativeLocation)];
}

/** Farm's arrangement of some units, and of the live loops they and some systems are. */
interface UnitLoops {
  readonly units: FarmArrangement;
  readonly loops: FarmArrangement;
}

/** Two arrangement reads whatever the count: the units, then every system they are linked to. */
async function loadUnitLoops(
  manager: EntityManager,
  tenantId: string,
  unitIds: readonly string[],
  systemIds: readonly string[],
): Promise<UnitLoops> {
  const units = await loadFarmArrangement(manager, tenantId, { units: unitIds, systems: [] });
  const linked = unitIds.flatMap((unitId) => [...(units.systemsOfUnit.get(unitId) ?? [])]);
  const loops = await loadFarmArrangement(manager, tenantId, {
    units: [],
    systems: [...systemIds, ...linked],
  });
  return { units, loops };
}

/** The live systems a unit is linked to (a deleted system is not one). */
function liveLoopsOf(unitId: string, topology: UnitLoops): string[] {
  return [...(topology.units.systemsOfUnit.get(unitId) ?? [])].filter((systemId) =>
    topology.loops.typeOfSystem.has(systemId),
  );
}

/**
 * The live systems a tank or equipment belongs to, read from farm's topology
 * now — the one rule inheritance (readingChains) and the water-chemistry
 * input set's loop (loopSystemIds) both apply: exactly one is its loop, none
 * means no loop, two or more mean which loop's water it holds is unknown.
 */
export async function liveSystemsOfUnit(
  manager: EntityManager,
  tenantId: string,
  unitId: string,
): Promise<string[]> {
  return liveLoopsOf(unitId, await loadUnitLoops(manager, tenantId, [unitId], []));
}

/** Samples are filed by unit (tank or equipment, one id either way) or by loop. */
type SampledKind = 'unit' | 'system';

function sampledKindOf(point: MeasurementPoint): SampledKind {
  return point.kind === 'system' ? 'system' : 'unit';
}

function sampleKey(kind: SampledKind, pointId: string, code: string): string {
  return `${kind}|${pointId}|${code}`;
}

interface LatestSampleRow {
  readonly kind: SampledKind;
  readonly pointId: string;
  readonly code: string;
  readonly id: string;
  readonly measuredAt: Date;
  readonly value: unknown;
}

/**
 * For every reached place a person samples at and every code asked there, the
 * newest sample a person took (manual, lab, calibration — never a
 * machine-provenance row) carrying a value under the code, taken by `asOf`.
 * Samples are of a unit (tank or equipment, named as every reader names it)
 * or of a loop (`systemId`); none is of a site, and none has a position or
 * depth, so only a point's representative location has one.
 *
 * One statement: per (point, code) a LATERAL newest-first LIMIT 1 over the
 * (tenantId, tankId | equipmentId | systemId, measuredAt) indexes, so each
 * pair costs an index probe, not a scan of the unit's history. The window is
 * not applied here: a sample older than the ask's window is still the
 * candidate the resolver reports as passed over (OLDER_THAN_WINDOW).
 */
async function latestManualSamples(
  manager: EntityManager,
  tenantId: string,
  reaches: readonly Reach<ParameterReadAsk>[],
  asOf: Date,
): Promise<Map<string, ManualCandidateFacts>> {
  const asked: Record<SampledKind, Map<string, { pointId: string; code: string }>> = {
    unit: new Map(),
    system: new Map(),
  };
  for (const { place, askers } of reaches) {
    if (!sampledAt(place)) continue;
    const kind = sampledKindOf(place.point);
    for (const { parameter } of askers) {
      asked[kind].set(sampleKey(kind, place.point.id, parameter.code), {
        pointId: place.point.id,
        code: parameter.code,
      });
    }
  }
  const samples = new Map<string, ManualCandidateFacts>();
  if (asked.unit.size === 0 && asked.system.size === 0) {
    return samples;
  }
  const column = (kind: SampledKind, field: 'pointId' | 'code'): string[] =>
    [...asked[kind].values()].map((pair) => pair[field]);
  const rows: LatestSampleRow[] = await manager.query(
    `${newestSampleSql('unit', measurementUnitMatchSql('m', '= asked."pointId"'), '$4', '$5')}
     UNION ALL
     ${newestSampleSql('system', 'm."systemId" = asked."pointId"', '$6', '$7')}`,
    [
      tenantId,
      asOf,
      [...MACHINE_MEASUREMENT_SOURCES],
      column('unit', 'pointId'),
      column('unit', 'code'),
      column('system', 'pointId'),
      column('system', 'code'),
    ],
  );
  for (const row of rows) {
    samples.set(sampleKey(row.kind, row.pointId, row.code), {
      measurementId: row.id,
      measuredAt: row.measuredAt,
      value: row.value,
    });
  }
  return samples;
}

/** Whether a person's sample can be of this location (a unit's or loop's representative one). */
function sampledAt(location: SourceLocation): boolean {
  return (
    location.point.kind !== 'site' &&
    location.position === MeasurementPosition.REPRESENTATIVE &&
    location.depthM === null
  );
}

/**
 * The newest human sample per asked (point, code) pair of one kind; `$1` the
 * tenant, `$2` asOf, `$3` the machine sources. Built from constants only.
 */
function newestSampleSql(
  kind: SampledKind,
  pointMatch: string,
  pointsParam: string,
  codesParam: string,
): string {
  return `SELECT '${kind}' AS kind, asked."pointId", asked.code, latest.id, latest."measuredAt", latest.value
       FROM unnest(${pointsParam}::uuid[], ${codesParam}::text[]) AS asked("pointId", code)
       CROSS JOIN LATERAL (
         SELECT m.id, m."measuredAt", m.parameters -> asked.code AS value
           FROM water_quality_measurements m
          WHERE m."tenantId" = $1
            AND ${pointMatch}
            AND jsonb_exists(m.parameters, asked.code)
            AND m."measuredAt" <= $2
            AND m.source::text <> ALL ($3::text[])
          ORDER BY m."measuredAt" DESC, m.id DESC
          LIMIT 1
       ) latest`;
}
