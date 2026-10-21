/**
 * Production-plan GraphQL wire types (code-first inputs/outputs).
 */
import { Field, Float, ID, InputType, Int, ObjectType } from '@nestjs/graphql';
import {
  IsDateString,
  IsIn,
  IsInt,
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
import { Type } from 'class-transformer';

@InputType()
export class TemperatureScenarioPointInput {
  @Field()
  @IsDateString()
  date!: string;

  @Field(() => Float)
  @IsNumber()
  @Min(-5)
  @Max(45)
  celsius!: number;
}

@InputType()
export class CreateTemperatureScenarioInput {
  @Field(() => ID)
  @IsUUID()
  siteId!: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @Field(() => [TemperatureScenarioPointInput])
  @ValidateNested({ each: true })
  @Type(() => TemperatureScenarioPointInput)
  points!: TemperatureScenarioPointInput[];
}

@InputType()
export class TankGrowthProjectionInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @Field(() => Int, { nullable: true, defaultValue: 30 })
  @IsOptional()
  @IsInt()
  @Min(7)
  @Max(365)
  horizonDays?: number;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  scenarioId?: string;
}

@ObjectType()
export class TankProjectionDayResponse {
  @Field(() => Int)
  day!: number;

  @Field()
  date!: string;

  @Field(() => Float)
  temperatureC!: number;

  @Field(() => Float)
  avgWeightG!: number;

  @Field(() => Float)
  biomassKg!: number;

  @Field(() => Float)
  feedKg!: number;

  @Field(() => Float)
  capacityPercent!: number;
}

@ObjectType()
export class TankGrowthProjectionResponse {
  @Field(() => ID)
  unitId!: string;

  @Field()
  unitCode!: string;

  @Field()
  unitName!: string;

  @Field(() => ID)
  siteId!: string;

  @Field()
  siteName!: string;

  @Field(() => ID, { nullable: true })
  departmentId?: string | null;

  @Field(() => String, { nullable: true })
  departmentName?: string | null;

  @Field(() => ID)
  protocolId!: string;

  @Field()
  protocolName!: string;

  @Field(() => Int)
  fishCount!: number;

  @Field(() => Float)
  currentAvgWeightG!: number;

  @Field(() => Float)
  currentBiomassKg!: number;

  @Field(() => Float, { nullable: true })
  capacityKg?: number | null;

  @Field(() => Float)
  projectedAvgWeightG!: number;

  @Field(() => Float)
  projectedBiomassKg!: number;

  @Field(() => Float)
  totalFeedKg!: number;

  @Field(() => Float)
  peakCapacityPercent!: number;

  @Field(() => Int, { nullable: true })
  overCapacityDay?: number | null;

  @Field(() => [TankProjectionDayResponse])
  series!: TankProjectionDayResponse[];
}
