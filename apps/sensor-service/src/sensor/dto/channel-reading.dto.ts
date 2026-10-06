import { Field, Float, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

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
}

/** One channel's bucketed history over the requested range. */
@ObjectType()
export class ChannelSeries {
  @Field(() => ID)
  channelId!: string;

  @Field()
  channelKey!: string;

  @Field(() => [ChannelSeriesPoint])
  points!: ChannelSeriesPoint[];
}

@ObjectType()
export class ChannelSeriesResponse {
  @Field(() => ID)
  sensorId!: string;

  /** The bucket width actually used (requested, or chosen from the range). */
  @Field()
  interval!: string;

  @Field(() => Date)
  startTime!: Date;

  @Field(() => Date)
  endTime!: Date;

  @Field(() => [ChannelSeries])
  channels!: ChannelSeries[];
}
