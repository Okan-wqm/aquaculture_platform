import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import {
  ObjectType,
  Field,
  ID,
  registerEnumType,
} from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { SensorProtocol } from './sensor-protocol.entity';

/**
 * Sensor type enum
 */
export enum SensorType {
  TEMPERATURE = 'temperature',
  PH = 'ph',
  DISSOLVED_OXYGEN = 'dissolved_oxygen',
  SALINITY = 'salinity',
  AMMONIA = 'ammonia',
  NITRITE = 'nitrite',
  NITRATE = 'nitrate',
  TURBIDITY = 'turbidity',
  WATER_LEVEL = 'water_level',
  MULTI_PARAMETER = 'multi_parameter',
}

registerEnumType(SensorType, {
  name: 'SensorType',
  description: 'Type of sensor',
});

/**
 * Sensor status enum
 */
export enum SensorStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  MAINTENANCE = 'maintenance',
  ERROR = 'error',
  OFFLINE = 'offline',
}

registerEnumType(SensorStatus, {
  name: 'SensorStatus',
  description: 'Current status of the sensor',
});

/**
 * Sensor registration status enum
 */
export enum SensorRegistrationStatus {
  DRAFT = 'draft',
  PENDING_TEST = 'pending_test',
  TESTING = 'testing',
  TEST_FAILED = 'test_failed',
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
}

registerEnumType(SensorRegistrationStatus, {
  name: 'SensorRegistrationStatus',
  description: 'Registration workflow status of the sensor',
});

/**
 * Sensor role enum - determines parent-child relationship
 */
export enum SensorRole {
  PARENT = 'parent',
  CHILD = 'child',
}

registerEnumType(SensorRole, {
  name: 'SensorRole',
  description: 'Role of sensor in parent-child hierarchy',
});

/**
 * Connection status interface for JSONB storage
 */
export interface SensorConnectionStatus {
  isConnected: boolean;
  lastTestedAt?: Date;
  lastSuccessfulConnection?: Date;
  lastError?: string;
  errorCode?: string;
  latencyMs?: number;
  signalStrength?: number;
  batteryLevel?: number;
  firmwareVersion?: string;
  diagnostics?: Record<string, unknown>;
}

/**
 * Sensor entity - represents an IoT sensor device
 */
@ObjectType()
@Entity('sensors') // Schema comes from search_path (tenant-specific)
@Index(['tenantId', 'status'])
@Index(['pondId'])
@Index(['serialNumber'], { unique: true })
@Index(['tenantId', 'siteId'])
@Index(['tenantId', 'departmentId'])
@Index(['tenantId', 'systemId'])
@Index(['tenantId', 'equipmentId'])
export class Sensor {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column()
  name: string;

  @Field()
  @Column({ name: 'serial_number', unique: true })
  serialNumber: string;

  @Field(() => SensorType)
  @Column({ type: 'enum', enum: SensorType })
  type: SensorType;

  @Field({ nullable: true })
  @Column({ nullable: true })
  manufacturer?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  model?: string;

  @Field({ nullable: true })
  @Column({ name: 'firmware_version', nullable: true })
  firmwareVersion?: string;

  @Field(() => SensorStatus)
  @Column({ type: 'enum', enum: SensorStatus, default: SensorStatus.ACTIVE })
  status: SensorStatus;

  @Field()
  @Column({ name: 'tenant_id' })
  @Index()
  tenantId: string;

  @Field({ nullable: true })
  @Column({ name: 'pond_id', nullable: true })
  @Index()
  pondId?: string;

  @Field({ nullable: true })
  @Column({ name: 'farm_id', nullable: true })
  farmId?: string;

  @Field({ nullable: true })
  @Column({ name: 'tank_id', nullable: true })
  @Index()
  tankId?: string;

  // New location hierarchy fields (Sites/Departments/Systems/Equipment)
  @Field({ nullable: true })
  @Column({ name: 'site_id', nullable: true })
  @Index()
  siteId?: string;

  @Field({ nullable: true })
  @Column({ name: 'department_id', nullable: true })
  @Index()
  departmentId?: string;

  @Field({ nullable: true })
  @Column({ name: 'system_id', nullable: true })
  @Index()
  systemId?: string;

  @Field({ nullable: true })
  @Column({ name: 'equipment_id', nullable: true })
  @Index()
  equipmentId?: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  location?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column('jsonb', { nullable: true })
  metadata?: Record<string, unknown>;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column('jsonb', { nullable: true })
  configuration?: Record<string, unknown>;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ name: 'calibration_data', type: 'jsonb', nullable: true })
  calibrationData?: Record<string, unknown>;

  // Protocol related fields
  @Field({ nullable: true })
  @Column({ name: 'protocol_id', nullable: true })
  @Index()
  protocolId?: string;

  @Field(() => SensorProtocol, { nullable: true })
  @ManyToOne(() => SensorProtocol, { nullable: true })
  @JoinColumn({ name: 'protocol_id' })
  protocol?: SensorProtocol;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ name: 'protocol_configuration', type: 'jsonb', nullable: true })
  protocolConfiguration?: Record<string, unknown>;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ name: 'connection_status', type: 'jsonb', nullable: true })
  connectionStatus?: SensorConnectionStatus;

  @Field(() => SensorRegistrationStatus)
  @Column({
    name: 'registration_status',
    type: 'enum',
    enum: SensorRegistrationStatus,
    default: SensorRegistrationStatus.DRAFT,
  })
  registrationStatus: SensorRegistrationStatus;

  @Field({ nullable: true })
  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt?: Date;

  @Field({ nullable: true })
  @Column({ name: 'last_calibrated_at', type: 'timestamptz', nullable: true })
  lastCalibratedAt?: Date;

  @Field()
  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Field({ nullable: true })
  @Column({ name: 'created_by', nullable: true })
  createdBy?: string;

  // Parent-Child Relationship Fields
  @Field(() => ID, { nullable: true })
  @Column({ name: 'parent_id', nullable: true })
  @Index()
  parentId?: string;

  @Field(() => Sensor, { nullable: true })
  @ManyToOne(() => Sensor, sensor => sensor.childSensors, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'parent_id' })
  parentSensor?: Sensor;

  @Field(() => [Sensor], { nullable: true })
  @OneToMany(() => Sensor, sensor => sensor.parentSensor)
  childSensors?: Sensor[];

  @Field()
  @Column({ name: 'is_parent_device', default: false })
  isParentDevice: boolean;

  @Field({ nullable: true })
  @Column({ name: 'data_path', nullable: true, length: 255 })
  dataPath?: string;

  @Field(() => SensorRole, { nullable: true })
  @Column({ name: 'sensor_role', type: 'enum', enum: SensorRole, nullable: true })
  sensorRole?: SensorRole;

  @Field({ nullable: true })
  @Column({ nullable: true })
  unit?: string;

  @Field({ nullable: true })
  @Column({ name: 'min_value', type: 'float', nullable: true })
  minValue?: number;

  @Field({ nullable: true })
  @Column({ name: 'max_value', type: 'float', nullable: true })
  maxValue?: number;

  @Field({ nullable: true })
  @Column({ name: 'calibration_enabled', default: false })
  calibrationEnabled?: boolean;

  @Field({ nullable: true })
  @Column({ name: 'calibration_multiplier', type: 'decimal', precision: 10, scale: 6, nullable: true })
  calibrationMultiplier?: number;

  @Field({ nullable: true })
  @Column({ name: 'calibration_offset', type: 'decimal', precision: 10, scale: 6, nullable: true })
  calibrationOffset?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ name: 'alert_thresholds', type: 'jsonb', nullable: true })
  alertThresholds?: {
    warning?: { low?: number; high?: number };
    critical?: { low?: number; high?: number };
  };

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ name: 'display_settings', type: 'jsonb', nullable: true })
  displaySettings?: {
    showOnDashboard?: boolean;
    widgetType?: string;
    color?: string;
    sortOrder?: number;
    decimalPlaces?: number;
  };
}
