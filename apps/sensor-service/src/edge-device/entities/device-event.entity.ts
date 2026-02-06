import {
  ObjectType,
  Field,
  ID,
  registerEnumType,
} from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum DeviceEventType {
  SELF_REGISTERED = 'self_registered',
  APPROVED = 'approved',
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  CONFIG_PUSHED = 'config_pushed',
  CONFIG_ACK = 'config_ack',
  DEPLOYMENT = 'deployment',
  REBOOT = 'reboot',
  ERROR = 'error',
  ALARM = 'alarm',
  HEARTBEAT_LOST = 'heartbeat_lost',
  DECOMMISSIONED = 'decommissioned',
}

registerEnumType(DeviceEventType, {
  name: 'DeviceEventType',
  description: 'Type of device lifecycle event',
});

export enum DeviceEventSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
}

registerEnumType(DeviceEventSeverity, {
  name: 'DeviceEventSeverity',
  description: 'Severity level of a device event',
});

@ObjectType()
@Entity('device_events')
@Index(['tenantId', 'deviceId'])
@Index(['tenantId', 'eventType'])
@Index(['createdAt'])
export class DeviceEvent {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Field({ nullable: true })
  @Column({ type: 'uuid', name: 'device_id', nullable: true })
  deviceId?: string;

  @Field(() => DeviceEventType)
  @Column({ name: 'event_type', type: 'enum', enum: DeviceEventType })
  eventType!: DeviceEventType;

  @Field(() => DeviceEventSeverity)
  @Column({ name: 'severity', type: 'enum', enum: DeviceEventSeverity, default: DeviceEventSeverity.INFO })
  severity!: DeviceEventSeverity;

  @Field()
  @Column({ name: 'message', type: 'text' })
  message!: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ name: 'metadata', type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
