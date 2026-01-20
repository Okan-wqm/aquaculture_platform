/**
 * Record Mortality DTO
 * @module Batch/DTO
 */
import { InputType, Field, Float, Int } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsEnum,
  IsNumber,
  IsUUID,
  IsDateString,
  IsBoolean,
  Min,
  MaxLength,
  ValidateNested,
  IsArray,
} from 'class-validator';
import { Type } from 'class-transformer';
import GraphQLJSON from 'graphql-type-json';
import { MortalityCause } from '../entities/mortality-record.entity';

@InputType()
export class WaterQualitySnapshotInput {
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  temperature?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  ph?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  dissolvedOxygen?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  ammonia?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  nitrite?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  salinity?: number;
}

@InputType('DetailedMortalityInput')
export class DetailedMortalityInput {
  @Field()
  @IsNotEmpty()
  @IsUUID()
  batchId: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  pondId?: string;

  @Field()
  @IsNotEmpty()
  @IsDateString()
  recordDate: string;

  @Field(() => Int)
  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  count: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  estimatedBiomassLoss?: number;

  @Field(() => MortalityCause, { defaultValue: MortalityCause.UNKNOWN })
  @IsEnum(MortalityCause)
  cause: MortalityCause;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  causeDetail?: string;

  @Field(() => WaterQualitySnapshotInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => WaterQualitySnapshotInput)
  waterQualitySnapshot?: WaterQualitySnapshotInput;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  symptoms?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  behaviorObservations?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  physicalCondition?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  actionsTaken?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  recommendations?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  labSampleTaken?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}
