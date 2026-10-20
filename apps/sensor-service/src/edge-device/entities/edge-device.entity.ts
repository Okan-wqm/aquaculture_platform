import { ObjectType, Field, ID, Int, Float, registerEnumType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import {
  Check,
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { Auditable } from '../../infrastructure/audit';
import { boardForDeviceModel } from '../edge-boards';
import { BINDING_METHODS, type BindingMethod, type BoardProfile } from '../edge-contract';

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
  return state === DeviceLifecycleState.DECOMMISSIONED || state === DeviceLifecycleState.REVOKED;
}

/**
 * The states {@link isTerminalLifecycleState} leaves in service, for SQL
 * filters — the fleet a "devices online" figure or a device picker means.
 */
export const IN_SERVICE_STATES: readonly DeviceLifecycleState[] = Object.values(
  DeviceLifecycleState,
).filter((state) => !isTerminalLifecycleState(state));

/**
 * Which lifecycle states may hold an MQTT broker session — the ONE allow-list
 * the CONNECT check and the per-message ACL both consult.
 *
 * A device is on the broker only once an operator (or an auto-approving tenant
 * key) has put it into service: ACTIVE, or one of the states a device in
 * service moves through on its own (OFFLINE, MAINTENANCE, ERROR). Everything
 * else is refused: REGISTERED and PROVISIONING have not activated,
 * PENDING_APPROVAL is awaiting the approval gate (self-registration still hands
 * it a password — the agent contract requires one — so this predicate is what
 * keeps it off the broker), REVOKED and DECOMMISSIONED are terminal.
 *
 * A Record over the enum, not a list: adding a lifecycle state is a compile
 * error here until someone decides whether it may connect.
 */
const BROKER_SESSION_ALLOWED: Readonly<Record<DeviceLifecycleState, boolean>> = {
  [DeviceLifecycleState.REGISTERED]: false,
  [DeviceLifecycleState.PROVISIONING]: false,
  [DeviceLifecycleState.PENDING_APPROVAL]: false,
  [DeviceLifecycleState.ACTIVE]: true,
  [DeviceLifecycleState.OFFLINE]: true,
  [DeviceLifecycleState.MAINTENANCE]: true,
  [DeviceLifecycleState.ERROR]: true,
  [DeviceLifecycleState.REVOKED]: false,
  [DeviceLifecycleState.DECOMMISSIONED]: false,
};

/** True when a device in `state` may connect to and publish on the broker. */
export function mayHoldBrokerSession(state: DeviceLifecycleState): boolean {
  // `=== true`: a value outside the enum (a hand-edited row) is refused.
  return BROKER_SESSION_ALLOWED[state] === true;
}

/** The states {@link mayHoldBrokerSession} admits, for SQL filters. */
export const BROKER_SESSION_STATES: readonly DeviceLifecycleState[] =
  Object.values(DeviceLifecycleState).filter(mayHoldBrokerSession);

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
 * The Suderra OS board a hardware model is provisioned as (ADR-048 DEC-8.4):
 * derived from boards.json `cloud_device_models`, the one board vocabulary,
 * never kept here as a second copy. Null for a model the contract leaves on
 * the generic-Linux channel (`unmapped_device_models`) or maps only to a
 * pending board family (industrial_pc, SG-3): the cloud issues no Suderra OS
 * manifest for it.
 */
export function suderraOsBoardOf(model: DeviceModel): BoardProfile | null {
  const board = boardForDeviceModel(model);
  return board === null ? null : board.boardProfile;
}

/**
 * The release channel the device's agent runs on (ADR-048 DEC-1, DEC-28).
 * A device is `suderra_os` once it has reserved a Suderra OS provisioning
 * manifest — it proved the channel by fetching the device-bound manifest.
 * The channel decides how commands reach it: Suderra OS agents accept only
 * signed command envelopes (DEC-9.1), so the publisher refuses to publish to
 * one without the signer; generic-Linux agents keep the legacy path until
 * DEC-28 P2.
 */
export enum EdgeAgentChannel {
  GENERIC_LINUX = 'generic_linux',
  SUDERRA_OS = 'suderra_os',
}

registerEnumType(EdgeAgentChannel, {
  name: 'EdgeAgentChannel',
  description: 'Release channel of the edge agent (generic Linux or Suderra OS)',
});

/**
 * The two-phase provisioning token (ADR-048 DEC-5.7):
 * TOKEN_ISSUED → MANIFEST_RESERVED (Suderra OS: bound to the device binding,
 * re-fetchable by that binding until it expires) → ACTIVATION_PENDING
 * (credentials issued, re-issuable) → COMMITTED (the device's own credential
 * authenticated its first broker CONNECT). NO_TOKEN is a device that never
 * held a per-device token (tenant-key self-registration).
 *
 * The phase is DERIVED from the columns that carry it — never stored beside
 * them — so the row cannot hold a phase that disagrees with its token,
 * reservation and credential columns. {@link provisioningPhaseOf} is the one
 * derivation; the atomic transitions in ProvisioningService state their
 * conditions over the same columns.
 */
export enum ProvisioningPhase {
  NO_TOKEN = 'no_token',
  TOKEN_ISSUED = 'token_issued',
  MANIFEST_RESERVED = 'manifest_reserved',
  ACTIVATION_PENDING = 'activation_pending',
  COMMITTED = 'committed',
}

export function provisioningPhaseOf(
  device: Pick<
    EdgeDevice,
    | 'tokenUsedAt'
    | 'provisioningToken'
    | 'credentialsIssuedAt'
    | 'reservedBindingSha256'
    | 'reservationExpiresAt'
  >,
  now: Date,
): ProvisioningPhase {
  if (device.tokenUsedAt !== null) return ProvisioningPhase.COMMITTED;
  if (device.provisioningToken === null) return ProvisioningPhase.NO_TOKEN;
  if (device.credentialsIssuedAt !== null) return ProvisioningPhase.ACTIVATION_PENDING;
  if (
    device.reservedBindingSha256 !== null &&
    device.reservationExpiresAt !== null &&
    device.reservationExpiresAt > now
  ) {
    return ProvisioningPhase.MANIFEST_RESERVED;
  }
  return ProvisioningPhase.TOKEN_ISSUED;
}

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

const bindingMethodIn = (column: string): string =>
  `"${column}" IS NULL OR "${column}" IN (${BINDING_METHODS.map((m) => `'${m}'`).join(', ')})`;

/**
 * A binding column holds a contract binding method or nothing, so the
 * columns can be typed {@link BindingMethod} and no reader re-validates them.
 */
const BINDING_METHOD_CHECK = `(${bindingMethodIn('device_binding_method')}) AND (${bindingMethodIn('reserved_binding_method')})`;

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
@Index('IDX_edge_devices_serial_number', ['serialNumber'], {
  unique: true,
  where: 'serial_number IS NOT NULL',
})
@Index('IDX_edge_devices_tenant_fingerprint_machineid', { synchronize: false })
@Check('CHK_edge_devices_agent_channel', `"agent_channel" IN ('generic_linux', 'suderra_os')`)
@Check(
  'CHK_edge_devices_reservation_binding',
  '("reserved_binding_sha256" IS NULL) = ("reserved_binding_method" IS NULL)',
)
@Check(
  'CHK_edge_devices_device_binding',
  '("device_binding_sha256" IS NULL) = ("device_binding_method" IS NULL)',
)
@Check('CHK_edge_devices_binding_methods', BINDING_METHOD_CHECK)
@Check(
  'CHK_edge_devices_activation_receipt',
  '("activation_receipt" IS NULL) = ("activation_receipt_expires_at" IS NULL)',
)
@Check(
  'CHK_edge_devices_lifecycle_request',
  '("lifecycle_request" IS NULL) = ("maintenance_expires_at" IS NULL)',
)
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

  /**
   * When the current provisioning token was issued. A Suderra OS manifest is
   * issued only under a token younger than SUDERRA_OS_TOKEN_MAX_AGE_MS
   * (ADR-048 DEC-5.12); a row without the instant (a token issued before it
   * was recorded) issues none.
   */
  @Column({ name: 'token_issued_at', type: 'timestamptz', nullable: true })
  tokenIssuedAt!: Date | null;

  // Two-phase provisioning (ADR-048 DEC-5.7, DEC-5.8). See ProvisioningPhase.

  // varchar + CHECK rather than a Postgres enum type: tenant provisioning
  // replays this table's migrations into every tenant schema, and a column
  // needs no schema-level type that a second replay would collide with.
  // Public on purpose: the panel shows which re-provisioning flow applies
  // (a signed lifecycle statement for Suderra OS, a re-install for generic
  // Linux) and why a Suderra OS device refuses commands without a command key.
  @Field(() => EdgeAgentChannel, {
    description:
      'The release channel the agent runs on; a Suderra OS device accepts signed commands only (ADR-048 DEC-9.1)',
  })
  @Column({
    name: 'agent_channel',
    type: 'varchar',
    length: 16,
    default: EdgeAgentChannel.GENERIC_LINUX,
  })
  agentChannel!: EdgeAgentChannel;

  /** The binding a pending Suderra OS manifest reservation holds. */
  @Column({ type: 'varchar', name: 'reserved_binding_method', length: 32, nullable: true })
  reservedBindingMethod!: BindingMethod | null;

  @Column({ type: 'varchar', name: 'reserved_binding_sha256', length: 64, nullable: true })
  reservedBindingSha256!: string | null;

  @Column({ name: 'reservation_expires_at', type: 'timestamptz', nullable: true })
  reservationExpiresAt!: Date | null;

  /** Statement digest of the last manifest issued under the reservation (the receipt names it). */
  @Column({ type: 'varchar', name: 'issued_manifest_sha256', length: 64, nullable: true })
  issuedManifestSha256!: string | null;

  /** Credentials were issued for the pending activation; not yet committed. */
  @Column({ name: 'credentials_issued_at', type: 'timestamptz', nullable: true })
  credentialsIssuedAt!: Date | null;

  /** The device binding committed at first activation: the device's hardware identity (DEC-3.6). */
  @Column({ type: 'varchar', name: 'device_binding_method', length: 32, nullable: true })
  deviceBindingMethod!: BindingMethod | null;

  @Column({ type: 'varchar', name: 'device_binding_sha256', length: 64, nullable: true })
  deviceBindingSha256!: string | null;

  /**
   * Last update_seq the cloud signed for this device. One monotonic counter
   * serves every device-bound sequence (manifest, site config, lifecycle),
   * which keeps each kind strictly increasing (statements.json sequences).
   */
  @Column({
    name: 'edge_statement_seq',
    type: 'bigint',
    default: 0,
    transformer: {
      to: (value: number): number => value,
      from: (value: string | number): number => Number(value),
    },
  })
  edgeStatementSeq!: number;

  /**
   * The committed activation (DEC-5.8): set at the commit, kept through a
   * Suderra OS re-provisioning until the next commit replaces it, so the
   * cloud never forgets that a live device holds a committed identity. A
   * re-signed receipt keeps it (and activated_at, the manifest digest).
   */
  @Column({ name: 'activation_id', type: 'uuid', nullable: true })
  activationId!: string | null;

  /** When the committed activation's first session authenticated: the receipt's activated_at. */
  @Column({ name: 'activated_at', type: 'timestamptz', nullable: true })
  activatedAt!: Date | null;

  /** The activation receipt envelope awaiting the agent's hand-over to root. */
  @Column({ name: 'activation_receipt', type: 'text', nullable: true })
  activationReceipt!: string | null;

  /** The stored receipt's expires_at: a delivery re-signs a receipt close to it. */
  @Column({ name: 'activation_receipt_expires_at', type: 'timestamptz', nullable: true })
  activationReceiptExpiresAt!: Date | null;

  /** The last claimed delivery of the pending receipt (paces redelivery across replicas). */
  @Column({ name: 'activation_receipt_sent_at', type: 'timestamptz', nullable: true })
  activationReceiptSentAt!: Date | null;

  @Column({ name: 'activation_receipt_handed_at', type: 'timestamptz', nullable: true })
  activationReceiptHandedAt!: Date | null;

  /**
   * The signed device-lifecycle statement that opens a re-provisioning
   * window (DEC-5.14), stored with the token it was issued with and
   * delivered until the agent reports it handed to root or the window ends.
   */
  @Column({ name: 'lifecycle_request', type: 'text', nullable: true })
  lifecycleRequest!: string | null;

  @Column({ name: 'lifecycle_request_sent_at', type: 'timestamptz', nullable: true })
  lifecycleRequestSentAt!: Date | null;

  @Column({ name: 'lifecycle_request_handed_at', type: 'timestamptz', nullable: true })
  lifecycleRequestHandedAt!: Date | null;

  /** End of the re-provisioning window: the lifecycle statement's expires_at. */
  @Column({ name: 'maintenance_expires_at', type: 'timestamptz', nullable: true })
  maintenanceExpiresAt!: Date | null;

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
  @Column({
    name: 'temperature_celsius',
    type: 'decimal',
    precision: 5,
    scale: 2,
    nullable: true,
    transformer: new DecimalTransformer(),
  })
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
