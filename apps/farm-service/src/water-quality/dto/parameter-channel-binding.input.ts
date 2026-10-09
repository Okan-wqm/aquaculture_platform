/**
 * Inputs of the parameter channel-binding API (FARM-HIGH-373, plan rev2 PR-3.2).
 *
 * A channel is named by its stable natural key (sensorId, channelKey), never
 * by the channel's UUID, which changes when a device is rediscovered.
 */
import { BadRequestException } from '@nestjs/common';
import { Field, Float, ID, InputType } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import {
  ChannelSourcePriority,
  MeasurementPosition,
} from '../entities/water-quality-param-equipment.entity';
import type { ChannelSourceTarget } from '../commands/bind-parameter-channel.command';
import type { MeasurementPoint, SourceLocation } from '../services/parameter-sources';

/** A measurement point: exactly one of the four ids (checked by sourceLocationOf). */
@InputType({
  description:
    'A measurement point: exactly one of a site, a system, a tank or non-tank water equipment',
})
export class MeasurementPointInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string | null;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  systemId?: string | null;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string | null;

  @Field(() => ID, { nullable: true, description: 'Non-tank water equipment (a tank is tankId)' })
  @IsOptional()
  @IsUUID()
  equipmentId?: string | null;
}

@InputType({ description: 'Bind a sensor channel as a source of a parameter at a point' })
export class BindParameterChannelInput {
  @Field(() => ID)
  @IsUUID()
  parameterConfigId!: string;

  @Field(() => MeasurementPointInput)
  @ValidateNested()
  @Type(() => MeasurementPointInput)
  point!: MeasurementPointInput;

  @Field(() => MeasurementPosition, {
    nullable: true,
    description: 'Where at the point the channel samples; representative when omitted',
  })
  @IsOptional()
  @IsEnum(MeasurementPosition)
  position?: MeasurementPosition | null;

  @Field(() => Float, { nullable: true, description: 'Sampling depth in metres' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999.99)
  depthM?: number | null;

  @Field(() => ID)
  @IsUUID()
  sensorId!: string;

  @Field()
  @IsString()
  @MaxLength(100) // the sensor service's channel_key is varchar(100)
  @IsNotEmpty()
  channelKey!: string;

  @Field(() => ChannelSourcePriority, {
    nullable: true,
    description: 'Primary unless given; a backup needs a primary at the same place',
  })
  @IsOptional()
  @IsEnum(ChannelSourcePriority)
  priority?: ChannelSourcePriority | null;
}

@InputType({ description: 'Swap the channel of a bound source in one step, keeping its place' })
export class ReplaceParameterChannelInput {
  @Field(() => ID, { description: 'The live channel source to replace' })
  @IsUUID()
  sourceId!: string;

  @Field(() => ID)
  @IsUUID()
  sensorId!: string;

  @Field()
  @IsString()
  @MaxLength(100) // the sensor service's channel_key is varchar(100)
  @IsNotEmpty()
  channelKey!: string;
}

@InputType({ description: 'Declare which measured quantity a parameter records' })
export class DeclareParameterQuantityInput {
  @Field(() => ID)
  @IsUUID()
  parameterConfigId!: string;

  @Field({ description: 'A measured-quantity id, e.g. tan, nh3, nitriteN' })
  @IsString()
  @MaxLength(32)
  quantity!: string;
}

/** The point an input names; exactly one of its ids, else 400. */
export function measurementPointOf(input: MeasurementPointInput): MeasurementPoint {
  const named: MeasurementPoint[] = [
    ...(input.siteId ? [{ kind: 'site' as const, id: input.siteId }] : []),
    ...(input.systemId ? [{ kind: 'system' as const, id: input.systemId }] : []),
    ...(input.tankId ? [{ kind: 'tank' as const, id: input.tankId }] : []),
    ...(input.equipmentId ? [{ kind: 'equipment' as const, id: input.equipmentId }] : []),
  ];
  const [point] = named;
  if (named.length !== 1 || point === undefined) {
    throw new BadRequestException(
      'Name exactly one measurement point: siteId, systemId, tankId or equipmentId',
    );
  }
  return point;
}

/** The location an input names: its point, at the representative position and no depth unless given. */
export function sourceLocationOf(input: {
  point: MeasurementPointInput;
  position?: MeasurementPosition | null;
  depthM?: number | null;
}): SourceLocation {
  return {
    point: measurementPointOf(input.point),
    position: input.position ?? MeasurementPosition.REPRESENTATIVE,
    depthM: input.depthM ?? null,
  };
}

/** The parameter, place and channel a bind or its dry run names. */
export function channelSourceTargetOf(input: BindParameterChannelInput): ChannelSourceTarget {
  return {
    parameterConfigId: input.parameterConfigId,
    location: sourceLocationOf(input),
    channel: { sensorId: input.sensorId, channelKey: input.channelKey },
  };
}
