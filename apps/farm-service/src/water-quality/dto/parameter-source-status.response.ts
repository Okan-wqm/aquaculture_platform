/**
 * What the binding UI reads about a parameter's sources (FARM-HIGH-373).
 *
 * A channel's live facts are the sensor service's: farm copies none of them
 * into its rows and asks the directory on every read. The problem codes are
 * the shared-contracts vocabulary (CHANNEL_BINDING_PROBLEMS), so the UI keys
 * its messages on one list.
 */
import { CHANNEL_BINDING_PROBLEM, type ChannelBindingProblem } from '@aquaculture/shared-contracts';
import { Field, Float, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import type {
  SensorChannelDescription,
  SensorChannelPresence,
  SensorSampleQuality,
} from '@platform/event-contracts';

import { WaterQualityParamEquipment } from '../entities/water-quality-param-equipment.entity';

// The problem codes' GraphQL enum is the shared-contracts table itself.
registerEnumType(CHANNEL_BINDING_PROBLEM, {
  name: 'ChannelBindingProblem',
  description: 'Why a sensor channel cannot feed a parameter at a point',
});

// The sensor subgraph's own enums, repeated value for value: one GraphQL type
// per name across the supergraph.
const ChannelPresenceEnum: Record<SensorChannelPresence, SensorChannelPresence> = {
  FOUND: 'FOUND',
  NO_SENSOR: 'NO_SENSOR',
  NO_CHANNEL: 'NO_CHANNEL',
};
registerEnumType(ChannelPresenceEnum, {
  name: 'ChannelPresence',
  description: 'Whether a (sensorId, channelKey) names a live channel, or what is missing',
});

const SampleQualityEnum: Record<SensorSampleQuality, SensorSampleQuality> = {
  GOOD: 'GOOD',
  UNCERTAIN: 'UNCERTAIN',
  BAD: 'BAD',
};
registerEnumType(SampleQualityEnum, {
  name: 'SampleQuality',
  description: 'OPC-UA quality band of a sample, classified by the sensor service',
});

@ObjectType({ description: 'A bound sensor channel as the sensor service describes it now' })
export class BoundChannelStatus {
  @Field(() => ID)
  sensorId!: string;

  @Field()
  channelKey!: string;

  @Field(() => ChannelPresenceEnum)
  presence!: SensorChannelPresence;

  @Field(() => Boolean, { nullable: true })
  sensorActive!: boolean | null;

  @Field(() => Boolean, { nullable: true })
  enabled!: boolean | null;

  @Field(() => String, { nullable: true, description: 'Effective measured quantity' })
  quantity!: string | null;

  @Field(() => String, { nullable: true })
  quantityFamily!: string | null;

  @Field(() => String, { nullable: true })
  unit!: string | null;

  @Field(() => Float, { nullable: true })
  latestValue!: number | null;

  @Field(() => Date, { nullable: true })
  latestAt!: Date | null;

  @Field(() => SampleQualityEnum, { nullable: true })
  latestQuality!: SensorSampleQuality | null;

  @Field(() => Date, { nullable: true, description: 'When the unit or quantity last changed' })
  configuredAt!: Date | null;

  @Field(() => Date, { nullable: true, description: 'Null: no calibration schedule' })
  calibrationDueAt!: Date | null;
}

/** The status of a described channel, its wire dates as dates. */
export function boundChannelStatus(description: SensorChannelDescription): BoundChannelStatus {
  const at = (iso: string | null): Date | null => (iso === null ? null : new Date(iso));
  return {
    sensorId: description.sensorId,
    channelKey: description.channelKey,
    presence: description.presence,
    sensorActive: description.sensorActive,
    enabled: description.enabled,
    quantity: description.quantity,
    quantityFamily: description.quantityFamily,
    unit: description.unit,
    latestValue: description.latestValue,
    latestAt: at(description.latestAt),
    latestQuality: description.latestQuality,
    configuredAt: at(description.configuredAt),
    calibrationDueAt: at(description.calibrationDueAt),
  };
}

@ObjectType({ description: 'A source of a parameter at a point, with its channel as it is now' })
export class ParameterSourceStatus {
  @Field(() => WaterQualityParamEquipment)
  source!: WaterQualityParamEquipment;

  @Field(() => BoundChannelStatus, { nullable: true, description: 'Null for a manual source' })
  channel!: BoundChannelStatus | null;

  @Field(() => [CHANNEL_BINDING_PROBLEM], {
    description: 'Why the channel cannot feed the parameter here now; empty when it can',
  })
  problems!: ChannelBindingProblem[];
}

@ObjectType({ description: 'Whether a channel could be bound as a source, without binding it' })
export class ChannelBindingCheck {
  @Field(() => BoundChannelStatus)
  channel!: BoundChannelStatus;

  @Field(() => [CHANNEL_BINDING_PROBLEM])
  problems!: ChannelBindingProblem[];
}

@ObjectType({ description: 'An unbound channel source, and the backup promoted in its place' })
export class ParameterChannelUnbinding {
  @Field(() => WaterQualityParamEquipment)
  unbound!: WaterQualityParamEquipment;

  @Field(() => WaterQualityParamEquipment, { nullable: true })
  promoted!: WaterQualityParamEquipment | null;
}
