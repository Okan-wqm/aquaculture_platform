import { Field, Float, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import type { SensorChannelDescription, SensorChannelPresence } from '@platform/event-contracts';
import { IsString, IsUUID, MaxLength } from 'class-validator';

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

  @Field(() => Date, { nullable: true })
  calibrationDueAt!: Date | null;

  @Field(() => Float, { nullable: true })
  latestValue!: number | null;

  @Field(() => Date, { nullable: true })
  latestAt!: Date | null;

  @Field(() => Int, { nullable: true })
  latestQualityCode!: number | null;
}

/** The wire description (ISO dates) as the GraphQL type (Date scalars). */
export function toDescriptionType(
  description: SensorChannelDescription,
): SensorChannelDescriptionType {
  return {
    ...description,
    calibrationDueAt:
      description.calibrationDueAt === null ? null : new Date(description.calibrationDueAt),
    latestAt: description.latestAt === null ? null : new Date(description.latestAt),
  };
}
