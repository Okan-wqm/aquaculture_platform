/**
 * CreateBatchWaterQuality Input DTO
 *
 * Batch creation of water quality measurements for multiple equipment.
 * Supports up to 50 measurements per request with idempotency.
 *
 * @module WaterQuality
 */
import { InputType, Field, ID } from '@nestjs/graphql';
import {
  IsUUID,
  IsOptional,
  IsDate,
  IsEnum,
  IsArray,
  IsString,
  MaxLength,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import GraphQLJSON from 'graphql-type-json';
import { MeasurementSource } from '../entities/water-quality-measurement.entity';
import { ValidateDynamicParameters } from '../validators/dynamic-parameters.validator';

@InputType()
export class BatchMeasurementItem {
  @Field(() => ID)
  @IsUUID()
  equipmentId!: string;

  @Field(() => GraphQLJSON)
  @ValidateDynamicParameters()
  dynamicParameters!: Record<string, number | string | boolean>;

  @Field(() => ID)
  @IsUUID()
  idempotencyKey!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

@InputType()
export class CreateBatchWaterQualityInput {
  @Field()
  @IsDate()
  @Type(() => Date)
  measuredAt!: Date;

  @Field(() => MeasurementSource, { defaultValue: MeasurementSource.MANUAL })
  @IsEnum(MeasurementSource)
  source!: MeasurementSource;

  @Field(() => [BatchMeasurementItem])
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BatchMeasurementItem)
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  measurements!: BatchMeasurementItem[];
}
