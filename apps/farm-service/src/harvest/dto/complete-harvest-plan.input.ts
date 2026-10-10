/**
 * CompleteHarvestPlanInput DTO
 *
 * The counted results that complete a harvest plan (FARM-HIGH-395). The
 * mutation took four bare scalars, which the ValidationPipe never sees, so a
 * zero or negative count/weight reached the stock movement. The bounds match
 * CreateHarvestRecordInput — completing a plan writes the same harvest
 * records — and the quality class is the caller's own input, never a default
 * (FARM-HIGH-396).
 *
 * @module Harvest/DTO
 */
import { InputType, Field, Float, Int, ID } from '@nestjs/graphql';
import { IsEnum, IsInt, IsNotEmpty, IsNumber, IsPositive, IsUUID, Max, Min } from 'class-validator';

import { QualityClass } from '../entities/harvest-record.entity';

@InputType()
export class CompleteHarvestPlanInput {
  @Field(() => ID, { description: 'Harvest plan ID' })
  @IsNotEmpty()
  @IsUUID()
  id!: string;

  @Field(() => Int, { description: 'Counted number of fish harvested' })
  @IsInt()
  @Min(1)
  actualQuantity!: number;

  // maxDecimalPlaces matches the stored decimal(12,2) column, so a resent
  // completion compares equal to the stored one (idempotent replay) instead
  // of differing in a third decimal the column dropped.
  @Field(() => Float, { description: 'Harvested biomass in kg (at most 2 decimals)' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Min(0.01)
  actualBiomass!: number;

  // decimal(10,2) column — same reason as actualBiomass.
  @Field(() => Float, { description: 'Average weight in grams (at most 2 decimals)' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Min(0.01)
  @Max(100000)
  actualAvgWeight!: number;

  @Field(() => QualityClass, {
    description: 'Norwegian quality class (kvalitetsklasse) of the harvest — the stored SSoT.',
  })
  @IsEnum(QualityClass)
  qualityClass!: QualityClass;
}
