import {
  CHANNEL_BINDING_PROBLEM,
  channelProblems,
  type ChannelBindingProblem,
  type QuantityId,
} from '@aquaculture/shared-contracts';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { SensorChannelDescription, SensorChannelKey } from '@platform/event-contracts';
import type { EntityManager } from 'typeorm';

import {
  ChannelSourcePriority,
  type WaterQualityParamEquipment,
} from '../entities/water-quality-param-equipment.entity';
import type { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';

import { type FarmPlacement, loadFarmPlacement, placedAt } from './channel-placement';
import type { MeasurementPoint } from './parameter-sources';

/**
 * The farm side of "can this channel feed this parameter here": the shared
 * rule (exact quantity, convertible units, live channel —
 * `channelProblems`) plus placement, which only farm can decide. The bind
 * command, its dry run and every read of a bound source call this, so a
 * source shown as healthy is one the bind would accept today (plan D12:
 * read-time problems are authoritative).
 */
export function bindingProblems(
  parameter: WaterQualityParameterConfig,
  point: MeasurementPoint,
  channel: SensorChannelDescription,
  farm: FarmPlacement,
): ChannelBindingProblem[] {
  const problems = channelProblems(
    { quantity: parameter.effectiveQuantity, unit: parameter.unit },
    channel,
  );
  // Where a missing sensor stands is unknown, not "elsewhere".
  if (channel.presence !== 'NO_SENSOR' && !placedAt(point, channel, farm)) {
    problems.push(CHANNEL_BINDING_PROBLEM.NOT_AT_POINT);
  }
  return problems;
}

/** bindingProblems with farm's placement read for this channel. */
export async function assessChannel(
  manager: EntityManager,
  tenantId: string,
  parameter: WaterQualityParameterConfig,
  point: MeasurementPoint,
  channel: SensorChannelDescription,
): Promise<ChannelBindingProblem[]> {
  const farm = await loadFarmPlacement(manager, tenantId, [channel]);
  return bindingProblems(parameter, point, channel, farm);
}

/**
 * Why a channel cannot take this priority among the live channel sources of
 * the parameter at the location, or null. One primary and one backup; a
 * backup stands behind a primary; a channel is a source once.
 */
export function priorityConflict(
  live: readonly WaterQualityParamEquipment[],
  channel: SensorChannelKey,
  priority: ChannelSourcePriority,
): Error | null {
  if (
    live.some(
      (source) => source.sensorId === channel.sensorId && source.channelKey === channel.channelKey,
    )
  ) {
    return new ConflictException('This channel is already a source of the parameter here');
  }
  const holder = live.find((source) => source.priority === priority);
  if (holder !== undefined) {
    return new ConflictException(
      `The parameter already has a ${priority} source here; replace or unbind it first`,
    );
  }
  if (
    priority === ChannelSourcePriority.BACKUP &&
    !live.some((source) => source.priority === ChannelSourcePriority.PRIMARY)
  ) {
    return new BadRequestException('A backup needs a primary source at the same place');
  }
  return null;
}

/** What a parameter means, as a bind read it before its transaction. */
export interface QuantitySnapshot {
  readonly code: string;
  readonly unit: string;
  readonly declaredQuantity: QuantityId | null;
  readonly effectiveQuantity: QuantityId | null;
}

export function quantitySnapshot(config: WaterQualityParameterConfig): QuantitySnapshot {
  return {
    code: config.code,
    unit: config.unit,
    declaredQuantity: config.declaredQuantity,
    effectiveQuantity: config.effectiveQuantity,
  };
}

/**
 * Inside the write, under the parameter's lock: the parameter is still active
 * and means what it meant when the channel was checked, else 409 — the caller
 * re-checks against the new meaning rather than bind on a stale one.
 */
export function assertParameterUnchanged(
  config: WaterQualityParameterConfig,
  snapshot: QuantitySnapshot,
): void {
  if (!config.isActive) {
    throw new ConflictException('The parameter was deactivated; nothing was bound');
  }
  const now = quantitySnapshot(config);
  if (
    now.code !== snapshot.code ||
    now.unit !== snapshot.unit ||
    now.declaredQuantity !== snapshot.declaredQuantity ||
    now.effectiveQuantity !== snapshot.effectiveQuantity
  ) {
    throw new ConflictException(
      'The parameter’s code, unit or quantity changed while binding; check the channel again',
    );
  }
}
