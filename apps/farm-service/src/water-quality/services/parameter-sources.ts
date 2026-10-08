import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { type EntityManager, type FindOptionsWhere, IsNull, Not } from 'typeorm';

import {
  MeasurementPosition,
  WaterQualityParamEquipment,
} from '../entities/water-quality-param-equipment.entity';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';

import type { MeasurementUnit } from './measurement-unit';

/**
 * The binding owner's vocabulary: where a parameter is sourced
 * (water_quality_param_equipment, FARM-HIGH-373).
 *
 * A measurement point is exactly one of a site, a system (a recirculating
 * loop), a tank (`tanks.id`, or an equipment row flagged as a tank — the
 * measurement-unit classifier decides) or non-tank water equipment, qualified
 * by a position and a depth. Every writer and reader of source rows goes
 * through these helpers, so a point is spelled one way.
 */
export type MeasurementPointKind = 'site' | 'system' | 'tank' | 'equipment';

export interface MeasurementPoint {
  kind: MeasurementPointKind;
  id: string;
}

/** A point qualified by where at it the source samples: the identity of a source location. */
export interface SourceLocation {
  point: MeasurementPoint;
  position: MeasurementPosition;
  depthM: number | null;
}

export type PointColumns = Pick<
  WaterQualityParamEquipment,
  'siteId' | 'systemId' | 'tankId' | 'equipmentId'
>;

/** The row columns of a point: its own set, the other three null. */
export function pointColumns(point: MeasurementPoint): PointColumns {
  return {
    siteId: point.kind === 'site' ? point.id : null,
    systemId: point.kind === 'system' ? point.id : null,
    tankId: point.kind === 'tank' ? point.id : null,
    equipmentId: point.kind === 'equipment' ? point.id : null,
  };
}

/** The point a row names (the one-point CHECK guarantees exactly one). */
export function pointOf(row: PointColumns): MeasurementPoint {
  if (row.siteId !== null) return { kind: 'site', id: row.siteId };
  if (row.systemId !== null) return { kind: 'system', id: row.systemId };
  if (row.tankId !== null) return { kind: 'tank', id: row.tankId };
  if (row.equipmentId !== null) return { kind: 'equipment', id: row.equipmentId };
  throw new Error('A parameter source row names no measurement point');
}

/** The location of a row. */
export function locationOf(row: WaterQualityParamEquipment): SourceLocation {
  return { point: pointOf(row), position: row.position, depthM: row.depthM };
}

/** The point a measurement unit is: a tank point or an equipment point. */
export function unitPoint(unit: MeasurementUnit): MeasurementPoint {
  return { kind: unit.kind, id: unit.id };
}

/** A unit's representative location, the one the manual-entry plan names. */
export function representativeLocation(point: MeasurementPoint): SourceLocation {
  return { point, position: MeasurementPosition.REPRESENTATIVE, depthM: null };
}

/** Live (not unbound) rows of one parameter at one location. */
export function liveAtLocation(
  parameterConfigId: string,
  location: SourceLocation,
): FindOptionsWhere<WaterQualityParamEquipment> {
  return {
    parameterConfigId,
    ...nullablePointWhere(location.point),
    position: location.position,
    depthM: location.depthM === null ? IsNull() : location.depthM,
    unboundAt: IsNull(),
  };
}

/** Live rows of every parameter at a point, at any position or depth. */
export function liveAtPoint(point: MeasurementPoint): FindOptionsWhere<WaterQualityParamEquipment> {
  return { ...nullablePointWhere(point), unboundAt: IsNull() };
}

function nullablePointWhere(point: MeasurementPoint): FindOptionsWhere<WaterQualityParamEquipment> {
  const columns = pointColumns(point);
  return {
    siteId: columns.siteId ?? IsNull(),
    systemId: columns.systemId ?? IsNull(),
    tankId: columns.tankId ?? IsNull(),
    equipmentId: columns.equipmentId ?? IsNull(),
  };
}

/**
 * The parameter config, locked FOR UPDATE: every write to a parameter's
 * sources or meaning (bind, unbind, replace, promote, declare, clear, the
 * manual-plan writers, config edits) takes this lock first, so they apply one
 * at a time per parameter and each sees the others' result (plan D8).
 */
export async function lockParameterConfig(
  manager: EntityManager,
  tenantId: string,
  parameterConfigId: string,
): Promise<WaterQualityParameterConfig> {
  const config = await tenantManagerRepo(manager, WaterQualityParameterConfig, tenantId).findOne({
    where: { id: parameterConfigId },
    lock: { mode: 'pessimistic_write' },
  });
  if (config === null) {
    throw new NotFoundException(
      `Parameter config '${parameterConfigId}' not found for this tenant`,
    );
  }
  return config;
}

/** The live channel sources of a parameter, anywhere (a parameter's meaning is fixed while any exists). */
export async function liveChannelSourceCount(
  manager: EntityManager,
  tenantId: string,
  parameterConfigId: string,
): Promise<number> {
  return manager
    .createQueryBuilder(WaterQualityParamEquipment, 'source')
    .where('source.tenantId = :tenantId', { tenantId })
    .andWhere('source.parameterConfigId = :parameterConfigId', { parameterConfigId })
    .andWhere('source.channelKey IS NOT NULL')
    .andWhere('source.unboundAt IS NULL')
    .getCount();
}

/**
 * Ends live sources, stamped with the database clock (the row's boundAt is
 * database time too, and the CHECK requires unboundAt >= boundAt). Returns how
 * many were live.
 */
export async function unbindSources(
  manager: EntityManager,
  tenantId: string,
  sourceIds: readonly string[],
  unboundBy: string,
): Promise<number> {
  if (sourceIds.length === 0) {
    return 0;
  }
  const result = await manager
    .createQueryBuilder()
    .update(WaterQualityParamEquipment)
    .set({ unboundAt: () => 'now()', unboundBy })
    .where('"tenantId" = :tenantId', { tenantId })
    .andWhere('"id" IN (:...sourceIds)', { sourceIds: [...sourceIds] })
    .andWhere('"unboundAt" IS NULL')
    .execute();
  return result.affected ?? 0;
}

/** The live channel sources of a parameter at a location, locked FOR UPDATE (the caller holds the parameter lock). */
export async function liveChannelSourcesAt(
  manager: EntityManager,
  tenantId: string,
  parameterConfigId: string,
  location: SourceLocation,
): Promise<WaterQualityParamEquipment[]> {
  return tenantManagerRepo(manager, WaterQualityParamEquipment, tenantId).find({
    where: { ...liveAtLocation(parameterConfigId, location), channelKey: Not(IsNull()) },
    order: { boundAt: 'ASC' },
    lock: { mode: 'pessimistic_write' },
  });
}

/** A live channel source by id, or 404; a manual source is refused (it is a plan line). */
export async function findLiveChannelSource(
  manager: EntityManager,
  tenantId: string,
  sourceId: string,
): Promise<WaterQualityParamEquipment> {
  const source = await tenantManagerRepo(manager, WaterQualityParamEquipment, tenantId).findOne({
    where: { id: sourceId, unboundAt: IsNull() },
  });
  if (source === null) {
    throw new NotFoundException(`No live parameter source '${sourceId}' in this tenant`);
  }
  if (source.channelKey === null) {
    throw new BadRequestException('This is a manual plan line, not a channel source');
  }
  return source;
}

/**
 * Closes every live source at these points — manual plan lines and channel
 * sources alike — in the caller's transaction: a deleted tank or system is no
 * longer a place a parameter is measured (plan D12). The rows stay as history.
 */
export async function closeSourcesAtPoints(
  manager: EntityManager,
  tenantId: string,
  points: readonly MeasurementPoint[],
  unboundBy: string,
): Promise<number> {
  const ids = (kind: MeasurementPointKind): string[] =>
    points.filter((point) => point.kind === kind).map((point) => point.id);
  const byKind = {
    siteId: ids('site'),
    systemId: ids('system'),
    tankId: ids('tank'),
    equipmentId: ids('equipment'),
  };
  const clauses = Object.entries(byKind)
    .filter(([, list]) => list.length > 0)
    .map(([column]) => `"${column}" IN (:...${column})`);
  if (clauses.length === 0) {
    return 0;
  }
  const result = await manager
    .createQueryBuilder()
    .update(WaterQualityParamEquipment)
    .set({ unboundAt: () => 'now()', unboundBy })
    .where('"tenantId" = :tenantId', { tenantId })
    .andWhere('"unboundAt" IS NULL')
    .andWhere(`(${clauses.join(' OR ')})`, byKind)
    .execute();
  return result.affected ?? 0;
}
