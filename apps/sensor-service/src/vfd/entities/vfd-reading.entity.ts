import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ObjectType, Field, ID, Int } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

import { VfdDevice } from './vfd-device.entity';

/**
 * VFD parameters from reading
 */
export interface VfdParameters {
  // Motor performance
  outputFrequency?: number;
  motorSpeed?: number;
  motorCurrent?: number;
  motorVoltage?: number;
  dcBusVoltage?: number;
  outputPower?: number;
  motorTorque?: number;
  powerFactor?: number;

  // Energy
  energyConsumption?: number;
  runningHours?: number;
  powerOnHours?: number;
  startCount?: number;

  // Thermal
  driveTemperature?: number;
  motorThermal?: number;
  controlCardTemperature?: number;
  ambientTemperature?: number;

  // Status/Fault
  statusWord?: number;
  faultCode?: number;
  warningWord?: number;
  alarmWord?: number;

  // Reference
  speedReference?: number;
  frequencyReference?: number;

  // Allow additional custom parameters
  [key: string]: number | undefined;
}

/**
 * Parsed status bits from status word
 */
export interface VfdStatusBits {
  ready?: boolean;
  running?: boolean;
  fault?: boolean;
  warning?: boolean;
  atSetpoint?: boolean;
  direction?: 'forward' | 'reverse';
  voltageEnabled?: boolean;
  quickStopActive?: boolean;
  switchOnDisabled?: boolean;
  remote?: boolean;
  targetReached?: boolean;
  internalLimit?: boolean;
}

/**
 * VFD Reading Entity
 * Stores VFD parameter readings with timestamp
 */
@ObjectType({ description: 'VFD device reading with parameters' })
@Entity('vfd_readings', { schema: 'sensor' })
@Index(['vfdDeviceId', 'timestamp'])
@Index(['tenantId', 'timestamp'])
export class VfdReading {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'vfd_device_id' })
  @Index()
  vfdDeviceId!: string;

  @Field(() => VfdDevice, { nullable: true })
  @ManyToOne(() => VfdDevice, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vfd_device_id' })
  vfdDevice?: VfdDevice;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  tenantId!: string;

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  parameters!: VfdParameters;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  statusBits?: VfdStatusBits;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  rawValues?: Record<string, number>;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  latencyMs?: number;

  @Field()
  @Column({ type: 'boolean', default: true })
  isValid!: boolean;

  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 255, nullable: true })
  errorMessage?: string;

  @Field()
  @Column({ type: 'timestamp with time zone' })
  @Index()
  timestamp!: Date;

  @Field()
  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt!: Date;
}

/**
 * VFD Reading aggregated statistics
 */
export interface VfdReadingStats {
  vfdDeviceId: string;
  period: 'hour' | 'day' | 'week' | 'month';
  timestamp: Date;
  avgOutputFrequency?: number;
  maxOutputFrequency?: number;
  minOutputFrequency?: number;
  avgMotorCurrent?: number;
  maxMotorCurrent?: number;
  avgOutputPower?: number;
  maxOutputPower?: number;
  totalEnergy?: number;
  runningMinutes?: number;
  faultCount?: number;
  warningCount?: number;
}
