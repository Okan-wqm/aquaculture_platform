import {
  ObjectType,
  Field,
  ID,
  Float,
  Int,
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
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';

import { Sensor } from './sensor.entity';

/**
 * Data channel data type enum
 */
export enum ChannelDataType {
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  STRING = 'string',
  ENUM = 'enum',
}

registerEnumType(ChannelDataType, {
  name: 'ChannelDataType',
  description: 'Data type of the channel value',
});

/**
 * Discovery source enum
 */
export enum DiscoverySource {
  AUTO = 'auto',
  MANUAL = 'manual',
  TEMPLATE = 'template',
}

registerEnumType(DiscoverySource, {
  name: 'DiscoverySource',
  description: 'How the channel was discovered/created',
});

/**
 * Alert threshold configuration interface
 */
export interface AlertThresholdConfig {
  warning?: {
    low?: number;
    high?: number;
  };
  critical?: {
    low?: number;
    high?: number;
  };
  hysteresis?: number;
  deadbandSeconds?: number;
}

/**
 * Calibration polynomial for non-linear calibration
 * value = a0 + a1*x + a2*x^2 + a3*x^3 + ...
 */
export interface CalibrationPolynomial {
  coefficients: number[];
}

/**
 * Protocol-specific configuration for different sensor protocols
 */
export interface ProtocolConfig {
  // MQTT specific
  topic?: string;
  jsonPath?: string;
  payloadFormat?: 'json' | 'csv' | 'text' | 'binary';

  // Modbus specific
  registerAddress?: number;
  registerCount?: number;
  functionCode?: number;
  dataType?: 'INT16' | 'UINT16' | 'INT32' | 'UINT32' | 'FLOAT32' | 'FLOAT64';
  byteOrder?: 'ABCD' | 'DCBA' | 'BADC' | 'CDAB';
  scaleFactor?: number;

  // OPC-UA specific
  nodeId?: string;
  namespaceIndex?: number;
  browsePath?: string;

  // Polling configuration
  pollingIntervalMs?: number;
  timeout?: number;
}

/**
 * Channel display settings interface for dashboard visualization
 */
export interface ChannelDisplaySettings {
  color?: string;
  icon?: string;
  widgetType?: 'gauge' | 'sparkline' | 'number' | 'status';
  precision?: number;
  showOnDashboard?: boolean;
  chartConfig?: Record<string, unknown>;
}

/**
 * GraphQL type for alert thresholds
 */
@ObjectType()
export class AlertThreshold {
  @Field(() => Float, { nullable: true })
  low?: number;

  @Field(() => Float, { nullable: true })
  high?: number;
}

@ObjectType()
export class AlertThresholds {
  @Field(() => AlertThreshold, { nullable: true })
  warning?: AlertThreshold;

  @Field(() => AlertThreshold, { nullable: true })
  critical?: AlertThreshold;

  @Field(() => Float, { nullable: true })
  hysteresis?: number;
}

/**
 * GraphQL type for display settings
 */
@ObjectType()
export class DisplaySettings {
  @Field({ nullable: true })
  color?: string;

  @Field({ nullable: true })
  icon?: string;

  @Field({ nullable: true })
  widgetType?: string;

  @Field(() => Int, { nullable: true })
  precision?: number;

  @Field({ nullable: true })
  showOnDashboard?: boolean;

  @Field(() => GraphQLJSON, { nullable: true })
  chartConfig?: Record<string, unknown>;
}

/**
 * SensorDataChannel entity - represents a data channel/metric from a sensor
 *
 * A sensor can have multiple data channels. For example, a multi-parameter
 * water quality sensor might report temperature, pH, dissolved oxygen, etc.
 * Each channel can be individually configured with calibration, thresholds,
 * and display settings.
 */
@ObjectType()
@Entity('sensor_data_channels') // Schema comes from search_path (tenant-specific)
@Index(['sensorId', 'isEnabled'])
@Index(['tenantId', 'channelKey'])
@Unique(['sensorId', 'channelKey'])
export class SensorDataChannel {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column()
  @Index()
  sensorId: string;

  @Field(() => Sensor)
  @ManyToOne(() => Sensor, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sensorId' })
  sensor: Sensor;

  @Field()
  @Column()
  @Index()
  tenantId: string;

  // === Core Identification ===

  @Field()
  @Column({ length: 100 })
  channelKey: string;

  @Field()
  @Column({ length: 200 })
  displayLabel: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field(() => ChannelDataType)
  @Column({ type: 'enum', enum: ChannelDataType, default: ChannelDataType.NUMBER })
  dataType: ChannelDataType;

  @Field({ nullable: true })
  @Column({ length: 50, nullable: true })
  unit?: string;

  @Field({ nullable: true })
  @Column({ name: 'unit_symbol', length: 10, nullable: true })
  unitSymbol?: string;

  // === Physical & Operational Bounds ===

  @Field(() => Float, { nullable: true })
  @Column({ name: 'physical_min', type: 'double precision', nullable: true })
  physicalMin?: number;

  @Field(() => Float, { nullable: true })
  @Column({ name: 'physical_max', type: 'double precision', nullable: true })
  physicalMax?: number;

  @Field(() => Float, { nullable: true })
  @Column({ name: 'operational_min', type: 'double precision', nullable: true })
  operationalMin?: number;

  @Field(() => Float, { nullable: true })
  @Column({ name: 'operational_max', type: 'double precision', nullable: true })
  operationalMax?: number;

  // === Data Path (for extracting from raw payload) ===

  @Field({ nullable: true })
  @Column({ length: 255, nullable: true })
  dataPath?: string;

  // === Validation Range ===

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 15, scale: 6, nullable: true })
  minValue?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 15, scale: 6, nullable: true })
  maxValue?: number;

  // === Calibration Settings ===

  @Field()
  @Column({ default: false })
  calibrationEnabled: boolean;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 15, scale: 6, default: 1.0 })
  calibrationMultiplier: number;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 15, scale: 6, default: 0.0 })
  calibrationOffset: number;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  lastCalibratedAt?: Date;

  @Field({ nullable: true })
  @Column({ name: 'next_calibration_due', type: 'timestamptz', nullable: true })
  nextCalibrationDue?: Date;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ name: 'calibration_polynomial', type: 'jsonb', nullable: true })
  calibrationPolynomial?: CalibrationPolynomial;

  // === Protocol Configuration ===

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ name: 'protocol_config', type: 'jsonb', nullable: true })
  protocolConfig?: ProtocolConfig;

  // === Alert Thresholds ===

  @Field(() => AlertThresholds, { nullable: true })
  @Column('jsonb', { nullable: true })
  alertThresholds?: AlertThresholdConfig;

  // === Dashboard Display Settings ===

  @Field(() => DisplaySettings, { nullable: true })
  @Column('jsonb', { nullable: true })
  displaySettings?: ChannelDisplaySettings;

  // === Discovery Metadata ===

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  discoveredAt?: Date;

  @Field(() => DiscoverySource, { nullable: true })
  @Column({ type: 'enum', enum: DiscoverySource, nullable: true })
  discoverySource?: DiscoverySource;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column('jsonb', { nullable: true })
  sampleValue?: unknown;

  // === Status & Ordering ===

  @Field()
  @Column({ default: true })
  isEnabled: boolean;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  displayOrder: number;

  // === Timestamps ===

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;

  // === Helper Methods ===

  /**
   * Apply calibration to a raw value
   * Supports both linear (multiplier + offset) and polynomial calibration
   */
  applyCalibration(rawValue: number): number {
    if (!this.calibrationEnabled) {
      return rawValue;
    }

    // Polynomial calibration takes precedence
    if (this.calibrationPolynomial?.coefficients?.length) {
      return this.calibrationPolynomial.coefficients.reduce(
        (sum, coef, power) => sum + coef * Math.pow(rawValue, power),
        0
      );
    }

    // Linear calibration: y = mx + b
    return (rawValue * Number(this.calibrationMultiplier)) + Number(this.calibrationOffset);
  }

  /**
   * Check if a value is within valid range
   * Uses legacy minValue/maxValue for backward compatibility
   */
  isWithinRange(value: number): boolean {
    if (this.minValue !== null && value < Number(this.minValue)) {
      return false;
    }
    if (this.maxValue !== null && value > Number(this.maxValue)) {
      return false;
    }
    return true;
  }

  /**
   * Check if a value is within physical bounds
   */
  isWithinPhysicalBounds(value: number): boolean {
    if (this.physicalMin !== undefined && value < this.physicalMin) {
      return false;
    }
    if (this.physicalMax !== undefined && value > this.physicalMax) {
      return false;
    }
    return true;
  }

  /**
   * Check if a value is within operational bounds
   */
  isWithinOperationalBounds(value: number): boolean {
    if (this.operationalMin !== undefined && value < this.operationalMin) {
      return false;
    }
    if (this.operationalMax !== undefined && value > this.operationalMax) {
      return false;
    }
    return true;
  }

  /**
   * Validate a value and return detailed result
   */
  validateValue(value: number): { valid: boolean; reason?: string; level?: 'physical' | 'operational' } {
    if (!this.isWithinPhysicalBounds(value)) {
      return {
        valid: false,
        reason: value < (this.physicalMin ?? -Infinity)
          ? 'Below physical minimum'
          : 'Above physical maximum',
        level: 'physical',
      };
    }
    if (!this.isWithinOperationalBounds(value)) {
      return {
        valid: true, // Still valid but outside operational range
        reason: value < (this.operationalMin ?? -Infinity)
          ? 'Below operational minimum'
          : 'Above operational maximum',
        level: 'operational',
      };
    }
    return { valid: true };
  }

  /**
   * Get alert level for a value
   */
  getAlertLevel(value: number): 'normal' | 'warning' | 'critical' {
    if (!this.alertThresholds) {
      return 'normal';
    }

    const { warning, critical } = this.alertThresholds;

    // Check critical first
    if (critical) {
      if (critical.low !== undefined && value < critical.low) return 'critical';
      if (critical.high !== undefined && value > critical.high) return 'critical';
    }

    // Check warning
    if (warning) {
      if (warning.low !== undefined && value < warning.low) return 'warning';
      if (warning.high !== undefined && value > warning.high) return 'warning';
    }

    return 'normal';
  }
}
