/**
 * WaterQualityParamEquipment Entity - Parameter x Equipment Junction
 *
 * Links water quality parameters to specific equipment (tanks, ponds,
 * biofilters, drum filters, etc.) with per-mapping monitoring settings.
 *
 * Features:
 * - Many-to-many junction between parameter configs and equipment
 * - Configurable monitoring frequency per mapping
 * - Optional sensor device linkage
 * - Per-mapping alert enable/disable
 * - Unique constraint per tenant+parameter+equipment
 *
 * @module WaterQuality
 */
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
import {
  ObjectType,
  Field,
  ID,
  registerEnumType,
} from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import { WaterQualityParameterConfig } from './water-quality-parameter-config.entity';

/**
 * Lightweight GraphQL type for equipment references.
 * Avoids circular import of the full Equipment entity.
 */
@ObjectType('EquipmentRef')
class EquipmentRef {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  code!: string;

  @Field({ nullable: true })
  description?: string;
}

// ============================================================================
// ENUMS
// ============================================================================

/**
 * How frequently this parameter is monitored on the linked equipment
 */
export enum MonitoringFrequency {
  CONTINUOUS = 'continuous',
  HOURLY = 'hourly',
  DAILY = 'daily',
  WEEKLY = 'weekly',
  ON_DEMAND = 'on_demand',
}

registerEnumType(MonitoringFrequency, {
  name: 'MonitoringFrequency',
  description: 'Frequency at which a water quality parameter is monitored on equipment',
});

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('water_quality_param_equipment')
@Index(['tenantId', 'parameterConfigId', 'equipmentId'], { unique: true })
@Index(['tenantId', 'equipmentId'])
@Index(['tenantId', 'parameterConfigId'])
export class WaterQualityParamEquipment {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId!: string;

  // -------------------------------------------------------------------------
  // FOREIGN KEYS
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  parameterConfigId!: string;

  @Field()
  @Column('uuid')
  equipmentId!: string;

  // -------------------------------------------------------------------------
  // MONITORING SETTINGS
  // -------------------------------------------------------------------------

  @Field({ description: 'Whether this parameter-equipment mapping is active' })
  @Column({ default: true })
  isActive!: boolean;

  @Field(() => MonitoringFrequency, { description: 'How often this parameter is monitored on the equipment' })
  @Column({
    type: 'enum',
    enum: MonitoringFrequency,
    default: MonitoringFrequency.ON_DEMAND,
  })
  monitoringFrequency!: MonitoringFrequency;

  @Field({ nullable: true, description: 'Linked sensor device UUID' })
  @Column({ type: 'uuid', nullable: true })
  sensorId?: string;

  @Field({ description: 'Whether alerts are enabled for this mapping' })
  @Column({ default: true })
  alertEnabled!: boolean;

  @Field({ nullable: true, description: 'Free-text notes for this mapping' })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  // -------------------------------------------------------------------------
  // RELATIONS
  // -------------------------------------------------------------------------

  @Field(() => WaterQualityParameterConfig)
  @ManyToOne(() => WaterQualityParameterConfig)
  @JoinColumn({ name: 'parameterConfigId' })
  parameterConfig!: WaterQualityParameterConfig;

  @Field(() => EquipmentRef, { nullable: true })
  @ManyToOne('Equipment')
  @JoinColumn({ name: 'equipmentId' })
  equipment?: EquipmentRef;

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
