/**
 * Feeding Protocol Response Types for GraphQL
 */
import { ObjectType, Field, Int, Float, ID, registerEnumType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-type-json';
import { StandardPaginatedResponse } from '@aquaculture/backend-common';
import { FeedType } from '../entities/feed.entity';

/**
 * Temperature Range Response
 */
@ObjectType()
export class TemperatureRangeResponse {
  @Field(() => Float)
  min!: number;

  @Field(() => Float)
  max!: number;

  @Field()
  unit!: string;

  @Field(() => Float, { description: 'Multiplier applied to normal feeding rate' })
  feedingMultiplier!: number;
}

/**
 * Feeding Schedule Entry Response
 */
@ObjectType()
export class FeedingScheduleEntryResponse {
  @Field({ description: 'Feeding time (e.g., "08:00", "12:00")' })
  time!: string;

  @Field(() => Float, { description: 'Percentage of daily amount' })
  percentOfDaily!: number;

  @Field({ nullable: true })
  notes?: string;
}

/**
 * Feeding Schedule Adjustments Response
 */
@ObjectType()
export class FeedingScheduleAdjustmentsResponse {
  @Field(() => Float, { nullable: true, description: 'Reduction percentage for low oxygen' })
  lowOxygenReduction?: number;

  @Field(() => Float, { nullable: true, description: 'Reduction percentage post stress' })
  postStressReduction?: number;

  @Field(() => Float, { nullable: true, description: 'Fasting hours before medication' })
  preMedicationFasting?: number;
}

/**
 * Feeding Schedule Response
 */
@ObjectType()
export class FeedingScheduleResponse {
  @Field(() => Int)
  totalMealsPerDay!: number;

  @Field(() => [FeedingScheduleEntryResponse])
  schedule!: FeedingScheduleEntryResponse[];

  @Field(() => FeedingScheduleAdjustmentsResponse, { nullable: true })
  adjustments?: FeedingScheduleAdjustmentsResponse;
}

/**
 * Growth Stage Protocol Response
 */
@ObjectType()
export class GrowthStageProtocolResponse {
  @Field(() => Float)
  minWeight!: number;

  @Field(() => Float)
  maxWeight!: number;

  @Field()
  weightUnit!: string;

  @Field(() => Float, { description: 'Feed percentage of body weight' })
  feedPercent!: number;

  @Field(() => FeedingScheduleResponse)
  schedule!: FeedingScheduleResponse;

  @Field({ nullable: true })
  notes?: string;
}

/**
 * Optimal Temperature Response
 */
@ObjectType()
export class OptimalTemperatureResponse {
  @Field(() => Float)
  min!: number;

  @Field(() => Float)
  max!: number;

  @Field()
  unit!: string;
}

/**
 * Special Conditions Response
 */
@ObjectType()
export class SpecialConditionsResponse {
  @Field({ nullable: true })
  spawningPeriod?: string;

  @Field({ nullable: true })
  winterFeeding?: string;

  @Field({ nullable: true })
  diseaseOutbreak?: string;

  @Field({ nullable: true })
  waterQualityIssues?: string;
}

/**
 * Feeding Protocol Response
 */
@ObjectType()
export class FeedingProtocolResponse {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  tenantId!: string;

  @Field()
  name!: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => ID, { nullable: true })
  feedId?: string;

  @Field()
  species!: string;

  @Field(() => FeedType)
  stage!: FeedType;

  @Field(() => [TemperatureRangeResponse], { nullable: true })
  temperatureRanges?: TemperatureRangeResponse[];

  @Field(() => [GrowthStageProtocolResponse], { nullable: true })
  growthStageProtocols?: GrowthStageProtocolResponse[];

  @Field(() => FeedingScheduleResponse, { nullable: true })
  defaultSchedule?: FeedingScheduleResponse;

  @Field(() => Float, { nullable: true, description: 'Target Feed Conversion Ratio' })
  targetFcr?: number;

  @Field(() => Float, { nullable: true, description: 'Minimum dissolved oxygen level (mg/L)' })
  minDissolvedOxygen?: number;

  @Field(() => OptimalTemperatureResponse, { nullable: true })
  optimalTemperature?: OptimalTemperatureResponse;

  @Field(() => SpecialConditionsResponse, { nullable: true })
  specialConditions?: SpecialConditionsResponse;

  @Field({ nullable: true })
  notes?: string;

  @Field()
  isActive!: boolean;

  @Field()
  isDefault!: boolean;

  @Field(() => ID, { nullable: true })
  createdBy?: string;

  @Field(() => ID, { nullable: true })
  updatedBy?: string;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;

  @Field(() => Int)
  version!: number;
}

/**
 * Paginated Feeding Protocols Response
 */
@ObjectType()
export class PaginatedFeedingProtocolsResponse extends StandardPaginatedResponse(FeedingProtocolResponse) {}
