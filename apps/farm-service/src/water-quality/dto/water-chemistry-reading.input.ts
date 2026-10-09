/**
 * Inputs of the water-chemistry reading API (plan rev2 PR-4).
 *
 * @module WaterQuality/DTO
 */
import { Field, Float, ID, InputType, Int } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { MeasurementPosition } from '../entities/water-quality-param-equipment.entity';

import { MeasurementPointInput } from './parameter-channel-binding.input';

/** A year: a window longer than this asks for nothing a window should mean. */
const MAX_AGE_SECONDS_LIMIT = 31_536_000;

@InputType({ description: 'A parameter to read at a measurement point, now' })
export class ResolvedParameterValueInput {
  @Field(() => ID)
  @IsUUID()
  parameterConfigId!: string;

  @Field(() => MeasurementPointInput)
  @ValidateNested()
  @Type(() => MeasurementPointInput)
  point!: MeasurementPointInput;

  @Field(() => MeasurementPosition, {
    nullable: true,
    description: 'Where at the point; representative when omitted (manual samples are only there)',
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

  @Field(() => Int, {
    nullable: true,
    description: 'Skip a value older than this many seconds; any age when omitted',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_AGE_SECONDS_LIMIT)
  maxAgeSeconds?: number | null;
}
