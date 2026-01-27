import {
  ObjectType,
  Field,
  ID,
  Int,
  Float,
  registerEnumType,
} from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Device lifecycle state enum (IEC 62443 compliant)
 */
export enum DeviceLifecycleState {
  REGISTERED = 'registered',
  PROVISIONING = 'provisioning',
  PENDING_APPROVAL = 'pending_approval',
  ACTIVE = 'active',
  OFFLINE = 'offline',
  MAINTENANCE = 'maintenance',
  ERROR = 'error',
  REVOKED = 'revoked',
  DECOMMISSIONED = 'decommissioned',
}

registerEnumType(DeviceLifecycleState, {
  name: 'DeviceLifecycleState',
  description: 'Lifecycle state of the edge device',
});

/**
 * Device model enum
 */
export enum DeviceModel {
  REVOLUTION_PI_CONNECT_4 = 'revolution_pi_connect_4',
  REVOLUTION_PI_COMPACT = 'revolution_pi_compact',
  RASPBERRY_PI_4 = 'raspberry_pi_4',
  RASPBERRY_PI_5 = 'raspberry_pi_5',
  INDUSTRIAL_PC = 'industrial_pc',
  CUSTOM = 'custom',
}

registerEnumType(DeviceModel, {
  name: 'DeviceModel',
  description: 'Hardware model of the edge device',
});

/**
 * Security level enum (IEC 62443)
 */
export enum SecurityLevel {
  SL1 = 1, // Basic protection
  SL2 = 2, // Protection against intentional violation
  SL3 = 3, // Protection against sophisticated attacks
  SL4 = 4, // Protection against state-sponsored attacks
}

registerEnumType(SecurityLevel, {
  name: 'SecurityLevel',
  description: 'IEC 62443 Security Level (SL1-SL4)',
});

/**
 * Device health metrics interface
 */
export interface DeviceHealthMetrics {
  cpuUsage?: number;
  memoryUsage?: number;
  storageUsage?: number;
  temperatureCelsius?: number;
  uptimeSeconds?: number;
  networkLatencyMs?: number;
  lastHealthCheck?: Date;
}

/**
 * EdgeDevice entity - represents an industrial edge controller
 * (Revolution Pi, Raspberry Pi, Industrial PC)
 */
@ObjectType()
@Entity('edge_devices')
@Index(['tenantId', 'lifecycleState'])
@Index(['tenantId', 'siteId'])
@Index(['deviceCode'], { unique: true })
@Index(['mqttClientId'], { unique: true, where: 'mqtt_client_id IS NOT NULL' })
@Index(['serialNumber'], { unique: true, where: 'serial_number IS NOT NULL' })
export class EdgeDevice {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Tenant & Site Relations
  @Field()
  @Column({ name: 'tenant_id' })
  @Index()
  tenantId!: string;

  @Field({ nullable: true })
  @Column({ name: 'site_id', nullable: true })
  @Index()
  siteId?: string;

  // Identity
  @Field()
  @Column({ name: 'device_code', length: 50 })
  deviceCode!: string;

  @Field()
  @Column({ name: 'device_name', length: 100 })
  deviceName!: string;

  @Field(() => DeviceModel)
  @Column({ name: 'device_model', type: 'enum', enum: DeviceModel })
  deviceModel!: DeviceModel;

  @Field({ nullable: true })
  @Column({ name: 'serial_number', length: 100, nullable: true })
  serialNumber?: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  // Lifecycle
  @Field(() => DeviceLifecycleState)
  @Column({
    name: 'lifecycle_state',
    type: 'enum',
    enum: DeviceLifecycleState,
    default: DeviceLifecycleState.REGISTERED,
  })
  lifecycleState!: DeviceLifecycleState;

  @Field({ nullable: true })
  @Column({ name: 'commissioned_at', type: 'timestamptz', nullable: true })
  commissionedAt?: Date;

  @Field({ nullable: true })
  @Column({ name: 'commissioned_by', nullable: true })
  commissionedBy?: string;

  // Security (IEC 62443)
  @Field({ nullable: true })
  @Column({ name: 'mqtt_client_id', length: 100, nullable: true })
  mqttClientId?: string;

  @Field({ nullable: true })
  @Column({ name: 'certificate_thumbprint', length: 64, nullable: true })
  certificateThumbprint?: string;

  @Field({ nullable: true })
  @Column({ name: 'certificate_expires_at', type: 'timestamptz', nullable: true })
  certificateExpiresAt?: Date;

  @Field(() => Int, { nullable: true })
  @Column({ name: 'security_level', type: 'int', default: 2 })
  securityLevel?: number;

  // Provisioning
  @Column({ name: 'provisioning_token', length: 64, nullable: true })
  provisioningToken?: string;

  @Field({ nullable: true })
  @Column({ name: 'token_expires_at', type: 'timestamptz', nullable: true })
  tokenExpiresAt?: Date;

  @Column({ name: 'token_used_at', type: 'timestamptz', nullable: true })
  tokenUsedAt?: Date;

  // MQTT Credentials (password hash stored, never exposed via GraphQL)
  @Column({ name: 'mqtt_password_hash', length: 128, nullable: true })
  mqttPasswordHash?: string;

  // Device Fingerprint (collected during activation)
  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  fingerprint?: {
    cpuSerial?: string;
    macAddresses?: string[];
    machineId?: string;
    hostname?: string;
  };

  // Agent Version
  @Field({ nullable: true })
  @Column({ name: 'agent_version', length: 30, nullable: true })
  agentVersion?: string;

  // Connection
  @Field({ nullable: true })
  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt?: Date;

  @Field()
  @Column({ name: 'is_online', default: false })
  isOnline!: boolean;

  @Field(() => Int, { nullable: true })
  @Column({ name: 'connection_quality', type: 'int', nullable: true })
  connectionQuality?: number;

  @Field({ nullable: true })
  @Column({ name: 'ip_address', type: 'inet', nullable: true })
  ipAddress?: string;

  // Firmware
  @Field({ nullable: true })
  @Column({ name: 'firmware_version', length: 30, nullable: true })
  firmwareVersion?: string;

  @Field({ nullable: true })
  @Column({ name: 'firmware_updated_at', type: 'timestamptz', nullable: true })
  firmwareUpdatedAt?: Date;

  @Field({ nullable: true })
  @Column({ name: 'target_firmware_version', length: 30, nullable: true })
  targetFirmwareVersion?: string;

  // Health Metrics
  @Field(() => Int, { nullable: true })
  @Column({ name: 'cpu_usage', type: 'int', nullable: true })
  cpuUsage?: number;

  @Field(() => Int, { nullable: true })
  @Column({ name: 'memory_usage', type: 'int', nullable: true })
  memoryUsage?: number;

  @Field(() => Int, { nullable: true })
  @Column({ name: 'storage_usage', type: 'int', nullable: true })
  storageUsage?: number;

  @Field(() => Float, { nullable: true })
  @Column({ name: 'temperature_celsius', type: 'decimal', precision: 5, scale: 2, nullable: true })
  temperatureCelsius?: number;

  @Field(() => Int, { nullable: true })
  @Column({ name: 'uptime_seconds', type: 'bigint', nullable: true })
  uptimeSeconds?: number;

  // Configuration
  @Field({ nullable: true })
  @Column({ length: 50, default: 'UTC' })
  timezone?: string;

  @Field(() => Int, { nullable: true })
  @Column({ name: 'scan_rate_ms', type: 'int', default: 100 })
  scanRateMs?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  config?: Record<string, unknown>;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  capabilities?: {
    modbus?: boolean;
    gpio?: boolean;
    analogIo?: boolean;
    serial?: boolean;
    canBus?: boolean;
    profinet?: boolean;
  };

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ name: 'tags', type: 'jsonb', nullable: true })
  tags?: string[];

  // Timestamps
  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Field({ nullable: true })
  @Column({ name: 'created_by', nullable: true })
  createdBy?: string;

  // Statistics (computed fields)
  @Field(() => Int, { nullable: true })
  sensorCount?: number;

  @Field(() => Int, { nullable: true })
  programCount?: number;

  @Field(() => Int, { nullable: true })
  activeAlarmCount?: number;
}
