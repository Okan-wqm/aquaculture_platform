import {
  InputType,
  Field,
  Int,
  Float,
  ObjectType,
} from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

import { IoType, IoDataType } from '../entities/device-io-config.entity';
import {
  DeviceLifecycleState,
  DeviceModel,
  EdgeDevice,
} from '../entities/edge-device.entity';

// Re-export enums for GraphQL schema
export { DeviceLifecycleState, DeviceModel };

/**
 * Input for registering a new edge device
 */
@InputType()
export class RegisterEdgeDeviceInput {
  @Field({ nullable: true })
  siteId?: string;

  @Field()
  deviceCode!: string;

  @Field()
  deviceName!: string;

  @Field(() => DeviceModel)
  deviceModel!: DeviceModel;

  @Field({ nullable: true })
  serialNumber?: string;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  timezone?: string;
}

/**
 * Input for updating an edge device
 */
@InputType()
export class UpdateEdgeDeviceInput {
  @Field({ nullable: true })
  deviceName?: string;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  siteId?: string;

  @Field({ nullable: true })
  timezone?: string;

  @Field(() => Int, { nullable: true })
  scanRateMs?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  config?: Record<string, unknown>;

  @Field(() => GraphQLJSON, { nullable: true })
  capabilities?: Record<string, boolean>;

  @Field(() => [String], { nullable: true })
  tags?: string[];
}

/**
 * Input for adding I/O configuration
 */
@InputType()
export class AddIoConfigInput {
  @Field()
  tagName!: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => IoType)
  ioType!: IoType;

  @Field(() => IoDataType)
  dataType!: IoDataType;

  @Field(() => Int)
  moduleAddress!: number;

  @Field(() => Int)
  channel!: number;

  @Field(() => Float, { nullable: true })
  rawMin?: number;

  @Field(() => Float, { nullable: true })
  rawMax?: number;

  @Field(() => Float, { nullable: true })
  engMin?: number;

  @Field(() => Float, { nullable: true })
  engMax?: number;

  @Field({ nullable: true })
  engUnit?: string;

  @Field(() => Int, { nullable: true })
  modbusFunction?: number;

  @Field(() => Int, { nullable: true })
  modbusSlaveId?: number;

  @Field(() => Int, { nullable: true })
  modbusRegister?: number;

  @Field(() => Int, { nullable: true })
  gpioPin?: number;

  @Field({ nullable: true })
  gpioMode?: string;

  @Field({ nullable: true })
  invertValue?: boolean;

  @Field(() => Float, { nullable: true })
  alarmHH?: number;

  @Field(() => Float, { nullable: true })
  alarmH?: number;

  @Field(() => Float, { nullable: true })
  alarmL?: number;

  @Field(() => Float, { nullable: true })
  alarmLL?: number;

  @Field(() => Float, { nullable: true })
  deadband?: number;
}

/**
 * Input for updating I/O configuration
 */
@InputType()
export class UpdateIoConfigInput {
  @Field({ nullable: true })
  description?: string;

  @Field(() => Float, { nullable: true })
  rawMin?: number;

  @Field(() => Float, { nullable: true })
  rawMax?: number;

  @Field(() => Float, { nullable: true })
  engMin?: number;

  @Field(() => Float, { nullable: true })
  engMax?: number;

  @Field({ nullable: true })
  engUnit?: string;

  @Field({ nullable: true })
  invertValue?: boolean;

  @Field(() => Float, { nullable: true })
  alarmHH?: number;

  @Field(() => Float, { nullable: true })
  alarmH?: number;

  @Field(() => Float, { nullable: true })
  alarmL?: number;

  @Field(() => Float, { nullable: true })
  alarmLL?: number;

  @Field(() => Float, { nullable: true })
  deadband?: number;

  @Field({ nullable: true })
  isActive?: boolean;
}

/**
 * Edge device connection (paginated list)
 */
@ObjectType()
export class EdgeDeviceConnection {
  @Field(() => [EdgeDevice])
  items!: EdgeDevice[];

  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  page!: number;

  @Field(() => Int)
  limit!: number;
}

/**
 * State count for statistics
 */
@ObjectType()
export class StateCount {
  @Field(() => DeviceLifecycleState)
  state!: DeviceLifecycleState;

  @Field(() => Int)
  count!: number;
}

/**
 * Model count for statistics
 */
@ObjectType()
export class ModelCount {
  @Field(() => DeviceModel)
  model!: DeviceModel;

  @Field(() => Int)
  count!: number;
}

/**
 * Edge device statistics
 */
@ObjectType()
export class EdgeDeviceStats {
  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  online!: number;

  @Field(() => Int)
  offline!: number;

  @Field(() => [StateCount])
  byState!: StateCount[];

  @Field(() => [ModelCount])
  byModel!: ModelCount[];
}

/**
 * Ping result from edge device
 */
@ObjectType()
export class PingResult {
  @Field()
  success!: boolean;

  @Field(() => Int, { nullable: true, description: 'Round-trip latency in milliseconds' })
  latencyMs?: number;

  @Field({ description: 'Device code that was pinged' })
  deviceCode!: string;

  @Field({ description: 'Timestamp of ping result' })
  timestamp!: Date;

  @Field({ nullable: true, description: 'Error message if ping failed' })
  error?: string;
}
