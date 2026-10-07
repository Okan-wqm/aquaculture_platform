import { Field, Float, ID, InputType, ObjectType, registerEnumType } from '@nestjs/graphql';
import {
  MAX_DESCRIBED_CHANNELS,
  type SensorChannelDescription,
  type SensorChannelPresence,
  type SensorSampleQuality,
} from '@platform/event-contracts';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * GraphQL view of the sensor channel description contract
 * (`@platform/event-contracts` sensor-channel-queries): the same answer farm
 * gets over NATS, so a picker and a binding cannot see different channels.
 */
export const ChannelPresence = {
  FOUND: 'FOUND',
  NO_SENSOR: 'NO_SENSOR',
  NO_CHANNEL: 'NO_CHANNEL',
} as const satisfies { [P in SensorChannelPresence]: P };

registerEnumType(ChannelPresence, {
  name: 'ChannelPresence',
  description: 'Whether a (sensorId, channelKey) names a live channel, or what is missing',
});

export const SampleQuality = {
  GOOD: 'GOOD',
  UNCERTAIN: 'UNCERTAIN',
  BAD: 'BAD',
} as const satisfies { [Q in SensorSampleQuality]: Q };

registerEnumType(SampleQuality, {
  name: 'SampleQuality',
  description: 'OPC-UA quality band of a sample, classified by the sensor service',
});

@InputType()
export class SensorChannelKeyInput {
  @Field(() => ID)
  @IsUUID()
  sensorId!: string;

  @Field()
  @IsString()
  @MaxLength(100)
  channelKey!: string;
}

/**
 * The keys to describe. Wrapped in an input object because the global
 * ValidationPipe does not validate a bare array argument: here every key is
 * validated and the request is capped like the NATS contract.
 */
@InputType()
export class ChannelsByKeyInput {
  @Field(() => [SensorChannelKeyInput])
  @IsArray()
  @ArrayMaxSize(MAX_DESCRIBED_CHANNELS)
  @ValidateNested({ each: true })
  @Type(() => SensorChannelKeyInput)
  keys!: SensorChannelKeyInput[];
}

@ObjectType()
export class SensorChannelDescriptionType {
  @Field(() => ID)
  sensorId!: string;

  @Field()
  channelKey!: string;

  @Field(() => ChannelPresence)
  presence!: SensorChannelPresence;

  @Field(() => Boolean, { nullable: true })
  sensorActive!: boolean | null;

  @Field(() => ID, { nullable: true })
  siteId!: string | null;

  @Field(() => ID, { nullable: true })
  systemId!: string | null;

  @Field(() => ID, { nullable: true })
  tankId!: string | null;

  @Field(() => ID, { nullable: true })
  channelId!: string | null;

  @Field(() => Boolean, { nullable: true })
  enabled!: boolean | null;

  @Field(() => String, { nullable: true, description: 'Effective measured quantity' })
  quantity!: string | null;

  @Field(() => String, { nullable: true })
  quantityFamily!: string | null;

  @Field(() => String, { nullable: true })
  unit!: string | null;

  @Field(() => Date, {
    nullable: true,
    description: 'Null: the channel has no calibration schedule (not "not due")',
  })
  calibrationDueAt!: Date | null;

  @Field(() => Date, {
    nullable: true,
    description: 'When the unit or quantity last changed; latest* is never older',
  })
  configuredAt!: Date | null;

  @Field(() => Float, { nullable: true })
  latestValue!: number | null;

  @Field(() => Date, { nullable: true })
  latestAt!: Date | null;

  @Field(() => SampleQuality, { nullable: true })
  latestQuality!: SensorSampleQuality | null;
}

/** The wire description (ISO dates) as the GraphQL type (Date scalars). */
export function toDescriptionType(
  description: SensorChannelDescription,
): SensorChannelDescriptionType {
  return {
    ...description,
    calibrationDueAt:
      description.calibrationDueAt === null ? null : new Date(description.calibrationDueAt),
    configuredAt: description.configuredAt === null ? null : new Date(description.configuredAt),
    latestAt: description.latestAt === null ? null : new Date(description.latestAt),
  };
}
