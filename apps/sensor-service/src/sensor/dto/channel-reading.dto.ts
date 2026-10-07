import type { MetricTierName } from '@aquaculture/shared-contracts';
import { Field, Float, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import { AggregationInterval } from './aggregated-reading.dto';

/**
 * Channel-generic read models over sensor_metrics (SENSOR-HIGH-138).
 *
 * The SensorReading projection carries a fixed nine-parameter vocabulary, so a
 * channel outside it (conductivity, ORP, CO2, a vendor key) cannot be read at
 * all. These types are keyed by the channel itself — whatever a sensor's
 * sensor_data_channels rows define is what a client can read.
 */

export enum ChannelAlertLevel {
  NORMAL = 'normal',
  WARNING = 'warning',
  CRITICAL = 'critical',
}

registerEnumType(ChannelAlertLevel, {
  name: 'ChannelAlertLevel',
  description: "A channel value's position against the channel's own alert thresholds",
});

/**
 * The store a series was read from. Its values must be exactly the tier
 * policy's tier names (checked at compile time below).
 */
export enum MetricSourceTier {
  RAW = 'raw',
  MINUTE = 'minute',
  HOUR = 'hour',
  DAY = 'day',
}

type ExactlyTrue<T extends true> = T;
export type MetricSourceTierMatchesPolicy = ExactlyTrue<
  [`${MetricSourceTier}`] extends [MetricTierName]
    ? [MetricTierName] extends [`${MetricSourceTier}`]
      ? true
      : false
    : false
>;

/** The GraphQL enum member for a policy tier (values are identical). */
export function metricSourceTierOf(tier: MetricTierName): MetricSourceTier {
  const member = Object.values(MetricSourceTier).find((value) => value === tier);
  if (member === undefined) {
    throw new Error(`MetricSourceTier has no member for ${tier}`);
  }
  return member;
}

registerEnumType(MetricSourceTier, {
  name: 'MetricSourceTier',
  description: 'The store a series was read from: raw rows or a rollup tier',
});

/** A half-open time window [start, end). */
@ObjectType()
export class TimeWindow {
  @Field(() => Date)
  start!: Date;

  @Field(() => Date)
  end!: Date;
}

/** One enabled channel of a sensor with its last-known value. */
@ObjectType()
export class ChannelLatestValue {
  @Field(() => ID)
  sensorId!: string;

  @Field(() => ID)
  channelId!: string;

  @Field()
  channelKey!: string;

  @Field()
  displayLabel!: string;

  @Field({ nullable: true })
  unit?: string;

  @Field({ nullable: true })
  unitSymbol?: string;

  @Field(() => Int)
  displayOrder!: number;

  /** Rendering precision from the channel's display settings. */
  @Field(() => Int, { nullable: true })
  precision?: number;

  /** Null when the channel has reported nothing inside the freshness window. */
  @Field(() => Float, { nullable: true })
  value?: number;

  @Field(() => Date, { nullable: true })
  time?: Date;

  @Field(() => Int, { nullable: true })
  qualityCode?: number;

  /** Null when there is no value to classify. */
  @Field(() => ChannelAlertLevel, { nullable: true })
  alertLevel?: ChannelAlertLevel;
}

@ObjectType()
export class ChannelSeriesPoint {
  @Field(() => Date)
  bucket!: Date;

  @Field(() => Float)
  avg!: number;

  @Field(() => Float, { nullable: true })
  min?: number;

  @Field(() => Float, { nullable: true })
  max?: number;

  @Field(() => Int)
  count!: number;

  /** Samples in the bucket below GOOD quality (still counted in avg/min/max). */
  @Field(() => Int)
  badCount!: number;
}

/** One channel's bucketed history over the requested range. */
@ObjectType()
export class ChannelSeries {
  @Field(() => ID)
  channelId!: string;

  @Field()
  channelKey!: string;

  @Field()
  displayLabel!: string;

  /** The channel's unit now; history is labelled with it. */
  @Field({ nullable: true })
  unit?: string;

  @Field({ nullable: true })
  unitSymbol?: string;

  @Field(() => Int, { nullable: true })
  precision?: number;

  /** False for a channel disabled since — its history is still returned. */
  @Field()
  enabled!: boolean;

  @Field(() => [ChannelSeriesPoint])
  points!: ChannelSeriesPoint[];

  /**
   * Stretches of the range with no stored sample, in bucket steps. A chart
   * draws them as breaks, never as a line across the missing data.
   */
  @Field(() => [TimeWindow])
  gaps!: TimeWindow[];
}

@ObjectType()
export class ChannelSeriesResponse {
  @Field(() => ID)
  sensorId!: string;

  /** The bucket width actually used (requested, or chosen from the range). */
  @Field({ deprecationReason: 'Use resolution' })
  interval!: string;

  /**
   * The bucket width actually returned: the requested one, or the range's,
   * but never finer than the store's own bucket.
   */
  @Field(() => AggregationInterval)
  resolution!: AggregationInterval;

  /** The store the points were read from. */
  @Field(() => MetricSourceTier)
  sourceTier!: MetricSourceTier;

  /** The time zone the bucket boundaries are aligned in. */
  @Field()
  bucketTimeZone!: string;

  /** The longest range one request may span, in seconds. */
  @Field(() => Int)
  maxRangeSeconds!: number;

  @Field(() => Date)
  startTime!: Date;

  @Field(() => Date)
  endTime!: Date;

  @Field(() => [ChannelSeries])
  channels!: ChannelSeries[];
}

/** The first and last stored sample of one channel. */
@ObjectType()
export class ChannelDataBounds {
  @Field(() => ID)
  sensorId!: string;

  @Field(() => ID)
  channelId!: string;

  /** From the daily rollup, which keeps every day indefinitely. */
  @Field(() => Date, { nullable: true })
  firstSampleAt?: Date;

  @Field(() => Date, { nullable: true })
  lastSampleAt?: Date;
}
