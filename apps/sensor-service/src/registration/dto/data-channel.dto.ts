import { InputType, Field, ID, ObjectType, Float, Int } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

import {
  ChannelDataType,
  DiscoverySource,
} from '../../database/entities/sensor-data-channel.entity';

// === Input Types ===

@InputType()
export class AlertThresholdValueInput {
  @Field(() => Float, { nullable: true })
  low?: number;

  @Field(() => Float, { nullable: true })
  high?: number;
}

@InputType()
export class AlertThresholdsInput {
  @Field(() => AlertThresholdValueInput, { nullable: true })
  warning?: AlertThresholdValueInput;

  @Field(() => AlertThresholdValueInput, { nullable: true })
  critical?: AlertThresholdValueInput;

  @Field(() => Float, { nullable: true })
  hysteresis?: number;
}

@InputType()
export class ChannelDisplaySettingsInput {
  @Field({ nullable: true })
  color?: string;

  @Field({ nullable: true })
  icon?: string;

  @Field({ nullable: true })
  widgetType?: string;

  @Field(() => Int, { nullable: true })
  precision?: number;

  @Field({ nullable: true })
  showOnDashboard?: boolean;

  @Field(() => GraphQLJSON, { nullable: true })
  chartConfig?: Record<string, unknown>;
}

@InputType()
export class CreateDataChannelInput {
  @Field()
  channelKey!: string;

  @Field()
  displayLabel!: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => ChannelDataType, { nullable: true, defaultValue: ChannelDataType.NUMBER })
  dataType?: ChannelDataType;

  @Field({ nullable: true })
  unit?: string;

  @Field({ nullable: true })
  dataPath?: string;

  @Field(() => Float, { nullable: true })
  minValue?: number;

  @Field(() => Float, { nullable: true })
  maxValue?: number;

  @Field({ nullable: true, defaultValue: false })
  calibrationEnabled?: boolean;

  @Field(() => Float, { nullable: true, defaultValue: 1.0 })
  calibrationMultiplier?: number;

  @Field(() => Float, { nullable: true, defaultValue: 0.0 })
  calibrationOffset?: number;

  @Field(() => AlertThresholdsInput, { nullable: true })
  alertThresholds?: AlertThresholdsInput;

  @Field(() => ChannelDisplaySettingsInput, { nullable: true })
  displaySettings?: ChannelDisplaySettingsInput;

  @Field({ nullable: true, defaultValue: true })
  isEnabled?: boolean;

  @Field(() => Int, { nullable: true })
  displayOrder?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  sampleValue?: unknown;
}

@InputType()
export class UpdateDataChannelInput {
  @Field(() => ID)
  channelId!: string;

  @Field({ nullable: true })
  displayLabel?: string;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  unit?: string;

  @Field({ nullable: true })
  dataPath?: string;

  @Field(() => Float, { nullable: true })
  minValue?: number;

  @Field(() => Float, { nullable: true })
  maxValue?: number;

  @Field({ nullable: true })
  calibrationEnabled?: boolean;

  @Field(() => Float, { nullable: true })
  calibrationMultiplier?: number;

  @Field(() => Float, { nullable: true })
  calibrationOffset?: number;

  @Field(() => AlertThresholdsInput, { nullable: true })
  alertThresholds?: AlertThresholdsInput;

  @Field(() => ChannelDisplaySettingsInput, { nullable: true })
  displaySettings?: ChannelDisplaySettingsInput;

  @Field({ nullable: true })
  isEnabled?: boolean;

  @Field(() => Int, { nullable: true })
  displayOrder?: number;
}

@InputType()
export class DiscoverChannelsInput {
  @Field()
  protocolCode!: string;

  @Field(() => GraphQLJSON)
  protocolConfiguration!: Record<string, unknown>;

  @Field(() => GraphQLJSON, { nullable: true })
  sampleData?: unknown;

  @Field({ nullable: true, defaultValue: 'json' })
  payloadFormat?: string;
}

@InputType()
export class SaveDiscoveredChannelsInput {
  @Field(() => ID)
  sensorId!: string;

  @Field(() => [CreateDataChannelInput])
  channels!: CreateDataChannelInput[];

  @Field({ nullable: true, defaultValue: false })
  replaceExisting?: boolean;
}

@InputType()
export class ReorderChannelsInput {
  @Field(() => ID)
  sensorId!: string;

  @Field(() => [ID])
  channelIds!: string[];
}

// === Output Types ===

@ObjectType('ChannelSensorInfo')
export class ChannelSensorInfoType {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field({ nullable: true })
  type?: string;
}

@ObjectType()
export class AlertThresholdValueType {
  @Field(() => Float, { nullable: true })
  low?: number;

  @Field(() => Float, { nullable: true })
  high?: number;
}

@ObjectType()
export class AlertThresholdsType {
  @Field(() => AlertThresholdValueType, { nullable: true })
  warning?: AlertThresholdValueType;

  @Field(() => AlertThresholdValueType, { nullable: true })
  critical?: AlertThresholdValueType;

  @Field(() => Float, { nullable: true })
  hysteresis?: number;
}

@ObjectType()
export class ChannelDisplaySettingsType {
  @Field({ nullable: true })
  color?: string;

  @Field({ nullable: true })
  icon?: string;

  @Field({ nullable: true })
  widgetType?: string;

  @Field(() => Int, { nullable: true })
  precision?: number;

  @Field({ nullable: true })
  showOnDashboard?: boolean;

  @Field(() => GraphQLJSON, { nullable: true })
  chartConfig?: Record<string, unknown>;
}

@ObjectType()
export class DataChannelType {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  sensorId!: string;

  @Field(() => ChannelSensorInfoType, { nullable: true })
  sensor?: ChannelSensorInfoType;

  @Field()
  tenantId!: string;

  @Field()
  channelKey!: string;

  @Field()
  displayLabel!: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => ChannelDataType)
  dataType!: ChannelDataType;

  @Field({ nullable: true })
  unit?: string;

  @Field({ nullable: true })
  dataPath?: string;

  @Field(() => Float, { nullable: true })
  minValue?: number;

  @Field(() => Float, { nullable: true })
  maxValue?: number;

  @Field()
  calibrationEnabled!: boolean;

  @Field(() => Float)
  calibrationMultiplier!: number;

  @Field(() => Float)
  calibrationOffset!: number;

  @Field({ nullable: true })
  lastCalibratedAt?: Date;

  @Field(() => AlertThresholdsType, { nullable: true })
  alertThresholds?: AlertThresholdsType;

  @Field(() => ChannelDisplaySettingsType, { nullable: true })
  displaySettings?: ChannelDisplaySettingsType;

  @Field({ nullable: true })
  discoveredAt?: Date;

  @Field(() => DiscoverySource, { nullable: true })
  discoverySource?: DiscoverySource;

  @Field(() => GraphQLJSON, { nullable: true })
  sampleValue?: unknown;

  @Field()
  isEnabled!: boolean;

  @Field(() => Int)
  displayOrder!: number;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

@ObjectType()
export class DiscoveredChannelType {
  @Field()
  channelKey!: string;

  @Field()
  suggestedLabel!: string;

  @Field(() => ChannelDataType)
  inferredDataType!: ChannelDataType;

  @Field({ nullable: true })
  inferredUnit?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  sampleValue?: unknown;

  @Field({ nullable: true })
  dataPath?: string;

  @Field(() => Float, { nullable: true })
  suggestedMin?: number;

  @Field(() => Float, { nullable: true })
  suggestedMax?: number;
}

@ObjectType()
export class DiscoveryResultType {
  @Field()
  success!: boolean;

  @Field(() => [DiscoveredChannelType])
  channels!: DiscoveredChannelType[];

  @Field(() => GraphQLJSON, { nullable: true })
  sampleData?: Record<string, unknown>;

  @Field({ nullable: true })
  error?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  rawPayload?: unknown;
}
