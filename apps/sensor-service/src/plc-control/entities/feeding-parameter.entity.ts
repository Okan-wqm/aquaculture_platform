import { ObjectType, Field, ID, Float, Int, registerEnumType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

import { PlcConnection } from './plc-connection.entity';

export enum ParameterStatus {
  DRAFT = 'DRAFT',
  PENDING = 'PENDING', // Waiting to be sent to PLC
  SENT = 'SENT', // Sent to PLC
  ACKNOWLEDGED = 'ACKNOWLEDGED', // PLC confirmed receipt
  ACTIVE = 'ACTIVE', // Currently being used by PLC
  SUPERSEDED = 'SUPERSEDED', // Replaced by newer parameters
  ERROR = 'ERROR', // Failed to send or apply
}

registerEnumType(ParameterStatus, { name: 'ParameterStatus' });

/**
 * Feeding schedule entry - when and how much to feed
 */
@ObjectType()
export class FeedingScheduleEntry {
  @Field()
  time: string; // HH:mm format

  @Field({ nullable: true })
  feedType?: string;

  @Field(() => Float)
  amountKg: number;

  @Field(() => Int, { nullable: true })
  durationSeconds?: number;

  @Field(() => Int, { nullable: true })
  blowerSpeedPercent?: number;

  @Field(() => Int, { nullable: true })
  doserSpeedPercent?: number;
}

/**
 * Threshold configuration for safety limits
 */
@ObjectType()
export class ThresholdConfig {
  @Field(() => Float)
  oxygenMin: number;

  @Field(() => Float)
  oxygenCritical: number;

  @Field(() => Float)
  tempMax: number;

  @Field(() => Float)
  tempCritical: number;

  @Field(() => Float, { nullable: true })
  phMin?: number;

  @Field(() => Float, { nullable: true })
  phMax?: number;
}

/**
 * VFD (Variable Frequency Drive) settings
 */
@ObjectType()
export class VfdSettings {
  @Field(() => Int)
  blowerMinSpeed: number;

  @Field(() => Int)
  blowerMaxSpeed: number;

  @Field(() => Int)
  doserMinSpeed: number;

  @Field(() => Int)
  doserMaxSpeed: number;
}

@ObjectType()
@Entity('feeding_parameters')
@Index(['tenantId', 'plcConnectionId'])
@Index(['tenantId', 'status'])
export class FeedingParameter {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column()
  @Index()
  tenantId: string;

  @Field()
  @Column()
  plcConnectionId: string;

  @ManyToOne(() => PlcConnection)
  @JoinColumn({ name: 'plcConnectionId' })
  plcConnection: PlcConnection;

  @Field({ nullable: true })
  @Column({ nullable: true })
  tankId?: string;

  @Field()
  @Column()
  name: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  description?: string;

  @Field()
  @Column({ default: '1.0' })
  version: string;

  // Core feeding parameters
  @Field(() => Float)
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  biomassKg: number;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 5, scale: 3 })
  fcr: number; // Feed Conversion Ratio

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  targetDailyFeedKg: number;

  // Feeding schedule - stored as JSON
  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  schedule: FeedingScheduleEntry[];

  // Thresholds for safety - stored as JSON
  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  thresholds: ThresholdConfig;

  // VFD settings - stored as JSON
  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  vfdSettings: VfdSettings;

  @Field(() => ParameterStatus)
  @Column({ type: 'varchar', default: ParameterStatus.DRAFT })
  status: ParameterStatus;

  @Field({ nullable: true })
  @Column({ nullable: true })
  sentAt?: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  acknowledgedAt?: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  activatedAt?: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  errorMessage?: string;

  // Checksum for integrity verification
  @Field({ nullable: true })
  @Column({ nullable: true })
  checksum?: string;

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  createdBy?: string;
}
