import { ObjectType, Field, ID, Float, Int } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Sensor readings from PLC
 */
@ObjectType()
export class SensorReadings {
  @Field(() => Float, { nullable: true })
  oxygen?: number;

  @Field(() => Float, { nullable: true })
  temperature?: number;

  @Field(() => Float, { nullable: true })
  ph?: number;

  @Field(() => Float, { nullable: true })
  flowRate?: number;

  @Field(() => Float, { nullable: true })
  ammonia?: number;

  @Field(() => Float, { nullable: true })
  nitrite?: number;
}

/**
 * Actuator status from PLC
 */
@ObjectType()
export class ActuatorStatus {
  @Field(() => Int, { nullable: true })
  blowerSpeed?: number;

  @Field(() => Int, { nullable: true })
  doserSpeed?: number;

  @Field({ nullable: true })
  aerationOn?: boolean;

  @Field({ nullable: true })
  feedingInProgress?: boolean;
}

/**
 * Feeding status from PLC
 */
@ObjectType()
export class FeedingStatus {
  @Field({ nullable: true })
  lastFeedingTime?: Date;

  @Field(() => Float, { nullable: true })
  lastFeedingAmountKg?: number;

  @Field(() => Float, { nullable: true })
  dailyTotalKg?: number;

  @Field(() => Int, { nullable: true })
  feedingsCompleted?: number;

  @Field(() => Int, { nullable: true })
  feedingsRemaining?: number;
}

/**
 * PLC operational status
 */
@ObjectType()
export class PlcStatus {
  @Field({ nullable: true })
  mode?: string; // NORMAL, OFFLINE, MAINTENANCE, EMERGENCY

  @Field({ nullable: true })
  connectionStatus?: string;

  @Field({ nullable: true })
  lastParameterUpdate?: Date;

  @Field(() => Int, { nullable: true })
  activeAlarmCount?: number;

  @Field({ nullable: true })
  firmwareVersion?: string;

  @Field(() => Float, { nullable: true })
  cpuLoad?: number;

  @Field(() => Float, { nullable: true })
  memoryUsage?: number;
}

@ObjectType()
@Entity('plc_telemetry')
@Index(['tenantId', 'plcConnectionId', 'timestamp'])
export class PlcTelemetry {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column()
  @Index()
  tenantId!: string;

  @Field()
  @Column()
  plcConnectionId!: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  tankId?: string;

  @Field()
  @Column()
  @Index()
  timestamp!: Date;

  // Sensor readings - stored as JSON
  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  sensors!: SensorReadings;

  // Actuator status - stored as JSON
  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  actuators!: ActuatorStatus;

  // Feeding status - stored as JSON
  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  feeding!: FeedingStatus;

  // PLC status - stored as JSON
  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  plcStatus!: PlcStatus;

  // Reference to the active parameter set
  @Field({ nullable: true })
  @Column({ nullable: true })
  activeParameterId?: string;

  @Field()
  @CreateDateColumn()
  createdAt!: Date;
}
