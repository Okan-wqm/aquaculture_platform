import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

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
@Entity('vfd_readings', { schema: 'sensor' })
@Index(['vfdDeviceId', 'timestamp'])
@Index(['tenantId', 'timestamp'])
@Index(['vfdDeviceId'])
@Index(['timestamp'])
export class VfdReading {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  @Index()
  vfdDeviceId!: string;

  @ManyToOne(() => VfdDevice, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vfdDeviceId' })
  vfdDevice!: VfdDevice;

  @Column({ type: 'uuid' })
  @Index()
  tenantId!: string;

  @Column({ type: 'jsonb' })
  parameters!: VfdParameters;

  @Column({ type: 'jsonb', nullable: true })
  statusBits?: VfdStatusBits;

  @Column({ type: 'jsonb', nullable: true })
  rawValues?: Record<string, number>;

  @Column({ type: 'int', nullable: true })
  latencyMs?: number;

  @Column({ type: 'boolean', default: true })
  isValid!: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true })
  errorMessage?: string;

  @Column({ type: 'timestamp with time zone' })
  @Index()
  timestamp!: Date;

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
