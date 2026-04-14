import {
  ObjectType,
  Field,
  ID,
} from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

import { Sensor } from './sensor.entity';

/**
 * Allowed user actions for channel detection proposals.
 */
export enum UserAction {
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

/**
 * ChannelDetectionLog entity - logs AI-driven channel detection attempts.
 * Tracks raw samples, AI analysis results, and user decisions on proposed channels.
 */
@ObjectType()
@Entity('channel_detection_log', { schema: 'sensor' })
@Index(['tenantId'])
@Index(['sensorId'])
export class ChannelDetectionLog {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Field()
  @Column({ type: 'uuid', name: 'sensor_id' })
  sensorId!: string;

  @Field(() => Sensor)
  @ManyToOne(() => Sensor, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sensor_id' })
  sensor?: Sensor;

  @Field(() => GraphQLJSON)
  @Column({ name: 'raw_sample', type: 'jsonb' })
  rawSample!: Record<string, unknown> | unknown[];

  @Field(() => GraphQLJSON)
  @Column({ name: 'ai_analysis', type: 'jsonb' })
  aiAnalysis!: Record<string, unknown>;

  @Field(() => GraphQLJSON)
  @Column({ name: 'proposed_channels', type: 'jsonb' })
  proposedChannels!: Record<string, unknown>[] | Record<string, unknown>;

  @Field({ nullable: true })
  @Column({ name: 'user_action', length: 20, nullable: true })
  userAction?: UserAction;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ name: 'final_channels', type: 'jsonb', nullable: true })
  finalChannels?: Record<string, unknown>[] | Record<string, unknown>;

  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
