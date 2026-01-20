import { ObjectType, Field, Float, Int, registerEnumType } from '@nestjs/graphql';
import { IsString, IsOptional } from 'class-validator';

/**
 * Aggregation interval for time-series queries
 */
export enum AggregationInterval {
  ONE_MINUTE = '1 minute',
  FIVE_MINUTES = '5 minutes',
  FIFTEEN_MINUTES = '15 minutes',
  ONE_HOUR = '1 hour',
  FOUR_HOURS = '4 hours',
  ONE_DAY = '1 day',
  ONE_WEEK = '1 week',
}

registerEnumType(AggregationInterval, {
  name: 'AggregationInterval',
  description: 'Time bucket interval for data aggregation',
});

/**
 * Aggregated sensor readings for a time bucket
 */
@ObjectType('AggregatedReading')
export class AggregatedReadingType {
  @Field(() => Date)
  bucket!: Date;

  @Field(() => Int)
  count!: number;

  // Temperature
  @Field(() => Float, { nullable: true })
  avgTemperature?: number;

  @Field(() => Float, { nullable: true })
  minTemperature?: number;

  @Field(() => Float, { nullable: true })
  maxTemperature?: number;

  // pH
  @Field(() => Float, { nullable: true })
  avgPh?: number;

  @Field(() => Float, { nullable: true })
  minPh?: number;

  @Field(() => Float, { nullable: true })
  maxPh?: number;

  // Dissolved Oxygen
  @Field(() => Float, { nullable: true })
  avgDissolvedOxygen?: number;

  @Field(() => Float, { nullable: true })
  minDissolvedOxygen?: number;

  @Field(() => Float, { nullable: true })
  maxDissolvedOxygen?: number;

  // Salinity
  @Field(() => Float, { nullable: true })
  avgSalinity?: number;

  @Field(() => Float, { nullable: true })
  minSalinity?: number;

  @Field(() => Float, { nullable: true })
  maxSalinity?: number;

  // Ammonia
  @Field(() => Float, { nullable: true })
  avgAmmonia?: number;

  @Field(() => Float, { nullable: true })
  minAmmonia?: number;

  @Field(() => Float, { nullable: true })
  maxAmmonia?: number;

  // Nitrite
  @Field(() => Float, { nullable: true })
  avgNitrite?: number;

  // Nitrate
  @Field(() => Float, { nullable: true })
  avgNitrate?: number;

  // Turbidity
  @Field(() => Float, { nullable: true })
  avgTurbidity?: number;

  // Water Level
  @Field(() => Float, { nullable: true })
  avgWaterLevel?: number;
}

/**
 * Response for aggregated readings query
 */
@ObjectType('AggregatedReadingsResponse')
export class AggregatedReadingsResponse {
  @Field(() => String)
  sensorId!: string;

  @Field(() => String, { nullable: true })
  sensorName?: string;

  @Field(() => String)
  interval!: string;

  @Field(() => Date)
  startTime!: Date;

  @Field(() => Date)
  endTime!: Date;

  @Field(() => Int)
  totalDataPoints!: number;

  @Field(() => [AggregatedReadingType])
  data!: AggregatedReadingType[];
}
