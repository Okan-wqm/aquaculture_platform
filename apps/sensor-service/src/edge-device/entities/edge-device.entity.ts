import {
  ObjectType,
  Field,
  ID,
  Int,
  Float,
  registerEnumType,
} from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { Auditable } from '../../infrastructure/audit';

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

/**
 * SENSOR-MEDIUM-008: terminal lifecycle states a device can never leave by
 * re-provisioning / activation / maintenance toggling. REVOKED is terminal
 * alongside DECOMMISSIONED — a revoked device must not be silently
 * re-activated back into service.
 */
export function isTerminalLifecycleState(state: DeviceLifecycleState): boolean {
  return (
    state === DeviceLifecycleState.DECOMMISSIONED ||
    state === DeviceLifecycleState.REVOKED
  );
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
  /** Raspberry Pi 4 with SX1302 LoRa concentrator HAT */
  RASPBERRY_PI_4_LORA = 'raspberry_pi_4_lora',
  /** Raspberry Pi 5 with SX1302 LoRa concentrator HAT */
  RASPBERRY_PI_5_LORA = 'raspberry_pi_5_lora',
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
@Auditable()
@ObjectType()
@Entity('edge_devices')
@Index(['tenantId', 'lifecycleState'])
@Index(['tenantId', 'siteId'])
@Index(['deviceCode'], { unique: true })
@Index(['mqttClientId'], { unique: true, where: 'mqtt_client_id IS NOT NULL' })
@Index('IDX_edge_devices_serial_number', ['serialNumber'], { unique: true, where: 'serial_number IS NOT NULL' })
@Index('IDX_edge_devices_tenant_fingerprint_machineid', { synchronize: false })
export class EdgeDevice {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Tenant & Site Relations
  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
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
  @Column({ type: 'varchar', name: 'provisioning_token', length: 64, nullable: true })
  provisioningToken!: string | null;

  @Field({ nullable: true })
  @Column({ name: 'token_expires_at', type: 'timestamptz', nullable: true })
  tokenExpiresAt?: Date;

  @Column({ name: 'token_used_at', type: 'timestamptz', nullable: true })
  tokenUsedAt!: Date | null;

  // MQTT Credentials (password hash stored, never exposed via GraphQL)
  @Column({ type: 'varchar', name: 'mqtt_password_hash', length: 128, nullable: true })
  mqttPasswordHash!: string | null;

  // Device Fingerprint (collected during activation)
  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  fingerprint!: {
    cpuSerial?: string;
    macAddresses?: string[];
    machineId?: string;
    hostname?: string;
  } | null;

  // Agent Version
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', name: 'agent_version', length: 30, nullable: true })
  agentVersion!: string | null;

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

  // Configuration Sync (SENSOR-HIGH-064)
  // The I/O config the device most recently CONFIRMED applying, tracked by a
  // content hash of the pushed agent config + the ack timestamp. Set only when a
  // real `update_io_config` ack arrives (correlated by commandId), never on
  // publish — so the operator sees the truthful applied state, not an optimistic
  // "pushed" state.
  @Field({ nullable: true })
  @Column({ name: 'applied_config_hash', type: 'varchar', length: 64, nullable: true })
  appliedConfigHash?: string;

  @Field({ nullable: true })
  @Column({ name: 'last_config_ack_at', type: 'timestamptz', nullable: true })
  lastConfigAckAt?: Date;

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
  // DecimalTransformer: device temperature reported by the edge device for health monitoring.
  // Temperature thresholds (overheating alerts) use numeric comparison; string comparison breaks them.
  @Column({ name: 'temperature_celsius', type: 'decimal', precision: 5, scale: 2, nullable: true, transformer: new DecimalTransformer() })
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
    lorawan?: boolean;
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
