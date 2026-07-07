import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

import { VfdBrand, VfdProtocol, VfdDeviceStatus } from './vfd.enums';
import { Auditable } from '../../infrastructure/audit';

/**
 * VFD connection status stored as JSONB
 */
export interface VfdConnectionStatus {
  isConnected: boolean;
  lastTestedAt?: Date;
  lastSuccessAt?: Date;
  lastError?: string;
  latencyMs?: number;
  consecutiveFailures?: number;
}

/**
 * Protocol-specific configuration stored as JSONB
 */
export interface ModbusRtuConfiguration {
  serialPort: string;
  slaveId: number;
  baudRate: number;
  dataBits: number;
  parity: 'none' | 'even' | 'odd';
  stopBits: number;
  timeout: number;
  retryCount: number;
}

export interface ModbusTcpConfiguration {
  host: string;
  port: number;
  unitId: number;
  connectionTimeout: number;
  responseTimeout: number;
}

export interface ProfibusDpConfiguration {
  stationAddress: number;
  baudRate: number;
  gsdFile?: string;
  ppoType: number;
}

export interface ProfinetConfiguration {
  deviceName: string;
  ipAddress: string;
  gsdmlFile?: string;
  updateCycleMs: number;
}

export interface EthernetIpConfiguration {
  ipAddress: string;
  tcpPort: number;
  udpPort: number;
  edsFile?: string;
  inputAssembly: number;
  outputAssembly: number;
  rpiMs: number;
}

export interface CanopenConfiguration {
  nodeId: number;
  baudRate: number;
  edsFile?: string;
  heartbeatMs: number;
}

export interface BacnetConfiguration {
  macAddress?: number;
  ipAddress?: string;
  udpPort: number;
  deviceInstance: number;
  bbmdAddress?: string;
}

export type VfdProtocolConfiguration =
  | ModbusRtuConfiguration
  | ModbusTcpConfiguration
  | ProfibusDpConfiguration
  | ProfinetConfiguration
  | EthernetIpConfiguration
  | CanopenConfiguration
  | BacnetConfiguration;

/**
 * VFD Device Entity
 * Stores VFD device configuration and status
 */
@Auditable()
@ObjectType({ description: 'VFD (Variable Frequency Drive) device' })
@Entity('vfd_devices')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'brand'])
@Index(['tenantId', 'protocol'])
export class VfdDevice {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ length: 255 })
  name!: string;

  @Field(() => VfdBrand)
  @Column({ type: 'varchar', length: 50 })
  brand!: VfdBrand;

  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 100, nullable: true })
  model?: string;

  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 100, nullable: true })
  serialNumber?: string;

  @Field(() => VfdProtocol)
  @Column({ type: 'varchar', length: 50 })
  protocol!: VfdProtocol;

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  protocolConfiguration!: VfdProtocolConfiguration & Record<string, unknown>;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  connectionStatus?: VfdConnectionStatus;

  @Field(() => VfdDeviceStatus)
  @Column({
    type: 'varchar',
    length: 50,
    default: VfdDeviceStatus.DRAFT,
  })
  status!: VfdDeviceStatus;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  tenantId!: string;

  @Field({ nullable: true })
  @Column({ type: 'uuid', name: 'farm_id', nullable: true })
  farmId?: string;

  @Field({ nullable: true })
  @Column({ type: 'uuid', name: 'tank_id', nullable: true })
  tankId?: string;

  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 255, nullable: true })
  location?: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  // SENSOR-HIGH-026: the registration wizard collects these but they had no
  // backing columns, so model series / pump linkage / tags were silently
  // dropped. (The wizard's free-text "notes" maps into `description` above.)
  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 100, name: 'model_series', nullable: true })
  modelSeries?: string;

  @Field({ nullable: true })
  @Column({ type: 'uuid', name: 'pump_id', nullable: true })
  pumpId?: string;

  @Field(() => [String], { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  tags?: string[];

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  customRegisterMappings?: Array<{
    parameterName: string;
    registerAddress: number;
    registerCount: number;
    functionCode: number;
    dataType: string;
    scalingFactor: number;
    offset: number;
    unit: string;
    byteOrder: string;
    wordOrder: string;
  }>;

  @Field()
  @Column({ type: 'int', name: 'poll_interval_ms', default: 1000 })
  pollIntervalMs!: number;

  @Field()
  @Column({ type: 'boolean', name: 'is_polling_enabled', default: true })
  isPollingEnabled!: boolean;

  @Field()
  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt!: Date;

  @Field({ nullable: true })
  @Column({ type: 'uuid', nullable: true })
  createdBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'uuid', nullable: true })
  updatedBy?: string;
}
