import { runInTenantRead, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { isLoopHomogeneous } from '@aquaculture/shared-contracts';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { SensorChannelDescription, SensorChannelKey } from '@platform/event-contracts';
import { DataSource, type EntityManager } from 'typeorm';

import { holdsSiteWater } from '../data/water-chemistry-input-sets';
import {
  MACHINE_MEASUREMENT_SOURCES,
  WaterQualityMeasurement,
} from '../entities/water-quality-measurement.entity';
import {
  type ChannelSourcePriority,
  MeasurementPosition,
  WaterQualityParamEquipment,
} from '../entities/water-quality-param-equipment.entity';
import type { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';

import { bindingProblems } from './channel-binding-rules';
import { type FarmPlacement, loadFarmArrangement, loadFarmPlacement } from './channel-placement';
import { measurementUnitMatchSql } from './measurement-unit-reader';
import {
  liveChannelsAtLocation,
  type MeasurementPoint,
  representativeLocation,
  type SourceLocation,
} from './parameter-sources';
import {
  type ManualCandidateFacts,
  type ReadingLevel,
  resolveReading,
  type ResolvedReading,
} from './reading-resolution';
import { SensorChannelDirectory } from './sensor-channel-directory.service';

/** One parameter to read at a location, in a unit, no older than a window (null: any age). */
export interface ParameterReadAsk {
  readonly parameter: WaterQualityParameterConfig;
  readonly unit: string;
  readonly maxAgeMs: number | null;
}

/** A level of the chain before its channels are described. */
interface GatheredLevel {
  readonly location: SourceLocation;
  readonly inherited: boolean;
  readonly sources: readonly ChannelSourceRow[];
  readonly manual: ManualCandidateFacts | null;
}

type ChannelSourceRow = WaterQualityParamEquipment & {
  sensorId: string;
  channelKey: string;
  priority: ChannelSourcePriority;
};

/**
 * Gathers the facts `resolveReading` decides on (reading-resolution.ts) and
 * asks it — the one reader of "the value of a parameter at a point, now".
 *
 * 1. In a tenant read: the chain of places the value may come from (the
 *    location, then — for a loop-homogeneous quantity — the system and the
 *    site it belongs to, by farm's topology now), the live channel sources of
 *    each asked parameter there, and the latest manual sample.
 * 2. Outside any connection: every bound channel described by the sensor
 *    service (SensorChannelDirectory: fail-closed, a 503 rather than a guess).
 * 3. In a tenant read: farm's placement of the described sensors, so each
 *    channel is judged by the bind's own rule at read time (D12,
 *    FARM-MEDIUM-378) — a sensor moved away, a channel disabled or
 *    re-declared since it was bound is skipped with its problem codes.
 *
 * Callers authorize the point first (assertPointReadable).
 */
@Injectable()
export class ParameterReadingResolver {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly directory: SensorChannelDirectory,
  ) {}

  /** One parameter's answer, as of `asOf`. */
  async resolveOne(
    tenantId: string,
    location: SourceLocation,
    ask: ParameterReadAsk,
    asOf: Date,
  ): Promise<ResolvedReading> {
    const [answer] = await this.resolveAt(tenantId, location, [ask], asOf);
    if (answer === undefined) {
      throw new Error('The reading resolver answered no ask');
    }
    return answer.reading;
  }

  /** Each ask with its answer, in the asks' order, all as of `asOf`. */
  async resolveAt<Ask extends ParameterReadAsk>(
    tenantId: string,
    location: SourceLocation,
    asks: readonly Ask[],
    asOf: Date,
  ): Promise<{ ask: Ask; reading: ResolvedReading }[]> {
    if (asks.length === 0) {
      return [];
    }
    const gathered = await runInTenantRead(this.dataSource, 'farm', tenantId, (queryRunner) =>
      gatherLevels(queryRunner.manager, tenantId, location, asks, asOf),
    );
    const keys = uniqueKeys(gathered.flatMap(({ levels }) => levels.flatMap((l) => l.sources)));
    const described = keys.length === 0 ? [] : await this.directory.describe(tenantId, keys);
    const descriptions = new Map<string, SensorChannelDescription>(
      described.map((description) => [keyOf(description), description]),
    );
    const farm =
      described.length === 0
        ? null
        : await runInTenantRead(this.dataSource, 'farm', tenantId, (queryRunner) =>
            loadFarmPlacement(queryRunner.manager, tenantId, described),
          );
    return gathered.map(({ ask, levels }) => ({
      ask,
      reading: resolveReading(
        {
          parameter: { quantity: ask.parameter.effectiveQuantity, unit: ask.parameter.unit },
          unit: ask.unit,
          asOf,
          maxAgeMs: ask.maxAgeMs,
        },
        levels.map((level) => readingLevel(ask, level, descriptions, farm)),
      ),
    }));
  }
}

function readingLevel(
  ask: ParameterReadAsk,
  level: GatheredLevel,
  descriptions: ReadonlyMap<string, SensorChannelDescription>,
  farm: FarmPlacement | null,
): ReadingLevel {
  return {
    point: level.location.point,
    inherited: level.inherited,
    manual: level.manual,
    channels: level.sources.map((source) => {
      const description = descriptions.get(keyOf(source));
      if (description === undefined || farm === null) {
        // The directory answered one description per asked key (describesRequest).
        throw new Error(`Channel ${keyOf(source)} was asked of the directory but not described`);
      }
      return {
        sourceId: source.id,
        priority: source.priority,
        description,
        bindingProblems: bindingProblems(ask.parameter, level.location.point, description, farm),
      };
    }),
  };
}

function keyOf(key: SensorChannelKey): string {
  return `${key.sensorId}|${key.channelKey}`;
}

function uniqueKeys(sources: readonly ChannelSourceRow[]): SensorChannelKey[] {
  const keys = new Map<string, SensorChannelKey>();
  for (const { sensorId, channelKey } of sources) {
    keys.set(keyOf({ sensorId, channelKey }), { sensorId, channelKey });
  }
  return [...keys.values()];
}

/** Per ask, in order, its levels with their live channel sources and latest manual sample. */
async function gatherLevels<Ask extends ParameterReadAsk>(
  manager: EntityManager,
  tenantId: string,
  location: SourceLocation,
  asks: readonly Ask[],
  asOf: Date,
): Promise<{ ask: Ask; levels: GatheredLevel[] }[]> {
  const inherits = (ask: ParameterReadAsk): boolean =>
    ask.parameter.effectiveQuantity !== null && isLoopHomogeneous(ask.parameter.effectiveQuantity);
  const chain = await readingChain(manager, tenantId, location, asks.some(inherits));
  // One read of the channel sources per place, for every ask that reaches it.
  const places: { location: SourceLocation; depth: number; sources: ChannelSourceRow[] }[] = [];
  for (const [depth, place] of chain.entries()) {
    const askers = asks.filter((ask) => depth === 0 || inherits(ask));
    const rows =
      askers.length === 0
        ? []
        : await tenantManagerRepo(manager, WaterQualityParamEquipment, tenantId).find({
            where: liveChannelsAtLocation(
              askers.map((ask) => ask.parameter.id),
              place,
            ),
            order: { boundAt: 'ASC' },
          });
    places.push({ location: place, depth, sources: rows.filter(isChannelSource) });
  }
  const gathered: { ask: Ask; levels: GatheredLevel[] }[] = [];
  for (const ask of asks) {
    const levels: GatheredLevel[] = [];
    for (const { location: place, depth, sources } of places) {
      if (depth > 0 && !inherits(ask)) break;
      levels.push({
        location: place,
        inherited: depth > 0,
        sources: sources.filter((source) => source.parameterConfigId === ask.parameter.id),
        manual: await latestManualSample(manager, tenantId, place, ask.parameter.code, asOf),
      });
    }
    gathered.push({ ask, levels });
  }
  return gathered;
}

/** A channel source row: the channel-source CHECK makes all three present together. */
function isChannelSource(source: WaterQualityParamEquipment): source is ChannelSourceRow {
  return source.sensorId !== null && source.channelKey !== null && source.priority !== null;
}

/**
 * The location, then — when asked for — the places a loop-homogeneous value
 * may be inherited from (D2, FARM-HIGH-381), read from farm's topology now
 * (the arrangement placement uses):
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
async function readingChain(
  manager: EntityManager,
  tenantId: string,
  location: SourceLocation,
  inherit: boolean,
): Promise<SourceLocation[]> {
  const { point } = location;
  if (!inherit || point.kind === 'site') {
    return [location];
  }
  const ancestors: MeasurementPoint[] = [];
  if (point.kind === 'system') {
    const loop = await loadFarmArrangement(manager, tenantId, { units: [], systems: [point.id] });
    const siteId = loop.siteOfSystem.get(point.id);
    const type = loop.typeOfSystem.get(point.id);
    if (siteId !== undefined && type !== undefined && holdsSiteWater(type)) {
      ancestors.push({ kind: 'site', id: siteId });
    }
  } else {
    const unit = await loadFarmArrangement(manager, tenantId, { units: [point.id], systems: [] });
    const linked = [...(unit.systemsOfUnit.get(point.id) ?? [])];
    const loops = await loadFarmArrangement(manager, tenantId, { units: [], systems: linked });
    const live = linked.filter((systemId) => loops.typeOfSystem.has(systemId));
    if (live.length > 1) {
      return [location];
    }
    const [systemId] = live;
    const type = systemId === undefined ? undefined : loops.typeOfSystem.get(systemId);
    if (systemId !== undefined) ancestors.push({ kind: 'system', id: systemId });
    const siteId = unit.siteOfUnit.get(point.id);
    if (siteId !== undefined && (type === undefined || holdsSiteWater(type))) {
      ancestors.push({ kind: 'site', id: siteId });
    }
  }
  return [location, ...ancestors.map(representativeLocation)];
}

/**
 * The newest sample a person took at this point (manual, lab, calibration —
 * never a machine-provenance row) carrying a value under this code, taken by
 * `asOf`. Samples are of a unit (tank or equipment, named as every reader
 * names it) or of a loop (`systemId`); none is of a site, and none has a
 * position or depth, so only a point's representative location has one.
 */
async function latestManualSample(
  manager: EntityManager,
  tenantId: string,
  location: SourceLocation,
  code: string,
  asOf: Date,
): Promise<ManualCandidateFacts | null> {
  const { point } = location;
  if (
    point.kind === 'site' ||
    location.position !== MeasurementPosition.REPRESENTATIVE ||
    location.depthM !== null
  ) {
    return null;
  }
  const query = manager
    .createQueryBuilder(WaterQualityMeasurement, 'measurement')
    .select(['measurement.id', 'measurement.measuredAt', 'measurement.parameters'])
    .where('measurement.tenantId = :tenantId', { tenantId })
    .andWhere('jsonb_exists(measurement.parameters, :code)', { code })
    .andWhere('measurement.measuredAt <= :asOf', { asOf })
    .andWhere('measurement.source NOT IN (:...machine)', {
      machine: [...MACHINE_MEASUREMENT_SOURCES],
    });
  if (point.kind === 'system') {
    query.andWhere('measurement.systemId = :pointId', { pointId: point.id });
  } else {
    query.andWhere(measurementUnitMatchSql('measurement', '= :pointId'), { pointId: point.id });
  }
  const sample = await query
    .orderBy('measurement.measuredAt', 'DESC')
    .addOrderBy('measurement.id', 'DESC')
    .limit(1)
    .getOne();
  return sample === null
    ? null
    : { measurementId: sample.id, measuredAt: sample.measuredAt, value: sample.parameters[code] };
}
