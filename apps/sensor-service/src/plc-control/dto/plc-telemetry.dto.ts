import { InputType, Field, ID, Int, ObjectType, Float } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import {
  IsOptional,
  IsUUID,
  IsDate,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { StandardPaginatedResponse } from '@aquaculture/backend-common/pagination';

import { PlcTelemetry } from '../entities/plc-telemetry.entity';

/**
 * Filter input for querying PLC telemetry
 */
@InputType('PlcTelemetryFilterInput')
export class PlcTelemetryFilterDto {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  plcConnectionId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  fromDate?: Date;

  @Field({ nullable: true })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  toDate?: Date;

  @Field(() => Int, { nullable: true, defaultValue: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  page?: number;

  @Field(() => Int, { nullable: true, defaultValue: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}

/**
 * Time range input for telemetry queries
 */
@InputType('TelemetryTimeRangeInput')
export class TelemetryTimeRangeDto {
  @Field()
  @IsDate()
  @Type(() => Date)
  from!: Date;

  @Field()
  @IsDate()
  @Type(() => Date)
  to!: Date;
}

/**
 * Paginated PLC telemetry response
 */
@ObjectType('PaginatedPlcTelemetry')
export class PaginatedPlcTelemetryDto extends StandardPaginatedResponse(PlcTelemetry) {}

/**
 * Statistics for a sensor value
 * NOTE: Must be defined before PlcTelemetryStatsDto to avoid circular reference
 */
@ObjectType('SensorStats')
export class SensorStats {
  @Field(() => Float, { nullable: true })
  min?: number;

  @Field(() => Float, { nullable: true })
  max?: number;

  @Field(() => Float, { nullable: true })
  avg?: number;

  @Field(() => Float, { nullable: true })
  stdDev?: number;

  @Field(() => Int)
  count!: number;
}

/**
 * Telemetry statistics
 */
@ObjectType('PlcTelemetryStats')
export class PlcTelemetryStatsDto {
  @Field(() => ID)
  plcConnectionId!: string;

  @Field()
  from!: Date;

  @Field()
  to!: Date;

  @Field(() => Int)
  totalRecords!: number;

  @Field(() => SensorStats)
  oxygen!: SensorStats;

  @Field(() => SensorStats)
  temperature!: SensorStats;

  @Field(() => SensorStats, { nullable: true })
  ph?: SensorStats;

  @Field(() => SensorStats, { nullable: true })
  flowRate?: SensorStats;
}

/**
 * Feeding statistics from telemetry
 */
@ObjectType('FeedingStats')
export class FeedingStatsDto {
  @Field(() => Float)
  totalFeedKg!: number;

  @Field(() => Int)
  totalFeedings!: number;

  @Field(() => Float)
  avgFeedingAmountKg!: number;

  @Field({ nullable: true })
  lastFeedingTime?: Date;

  @Field(() => Float, { nullable: true })
  lastFeedingAmountKg?: number;
}

/**
 * Actuator usage statistics
 */
@ObjectType('ActuatorUsageStats')
export class ActuatorUsageStatsDto {
  @Field(() => Float)
  avgBlowerSpeed!: number;

  @Field(() => Float)
  avgDoserSpeed!: number;

  @Field(() => Float)
  aerationOnTimePercent!: number;

  @Field(() => Float)
  feedingTimePercent!: number;
}

/**
 * Latest telemetry summary
 */
@ObjectType('LatestTelemetrySummary')
export class LatestTelemetrySummaryDto {
  @Field(() => ID)
  plcConnectionId!: string;

  @Field()
  timestamp!: Date;

  @Field(() => Float, { nullable: true })
  oxygen?: number;

  @Field(() => Float, { nullable: true })
  temperature?: number;

  @Field(() => Float, { nullable: true })
  ph?: number;

  @Field(() => Float, { nullable: true })
  flowRate?: number;

  @Field(() => Int, { nullable: true })
  blowerSpeed?: number;

  @Field(() => Int, { nullable: true })
  doserSpeed?: number;

  @Field({ nullable: true })
  aerationOn?: boolean;

  @Field({ nullable: true })
  feedingInProgress?: boolean;

  @Field({ nullable: true })
  plcMode?: string;

  @Field(() => Int, { nullable: true })
  activeAlarmCount?: number;
}
