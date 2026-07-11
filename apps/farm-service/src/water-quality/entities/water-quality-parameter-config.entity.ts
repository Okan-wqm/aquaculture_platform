/**
 * WaterQualityParameterConfig Entity - Dynamic Water Quality Parameter Configuration
 *
 * Tenant-specific configuration for water quality parameters.
 * Enables dynamic parameter definitions with species-specific limits,
 * display preferences, and threshold configuration.
 *
 * Features:
 * - Dynamic parameter definitions (code, name, unit, data type)
 * - Multi-level thresholds (optimal, warning, critical)
 * - Species-specific limit overrides (JSONB)
 * - Enum-type parameter support (text[] for allowed values)
 * - Display configuration (color, icon, order, visibility)
 * - Template-based provisioning
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
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import {
  ObjectType,
  Field,
  ID,
  Float,
  Int,
  registerEnumType,
} from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Parameter data type
 */
export enum ParameterDataType {
  NUMBER = 'number',
  ENUM = 'enum',
  BOOLEAN = 'boolean',
}

registerEnumType(ParameterDataType, {
  name: 'ParameterDataType',
  description: 'Data type of a water quality parameter value',
});

/**
 * Parameter group for categorization
 */
export enum ParameterGroup {
  BASIC = 'basic',
  NITROGEN_CYCLE = 'nitrogen_cycle',
  METALS = 'metals',
  BIOLOGICAL = 'biological',
  ORGANIC = 'organic',
  CUSTOM = 'custom',
}

registerEnumType(ParameterGroup, {
  name: 'ParameterGroup',
  description: 'Logical grouping for water quality parameters',
});

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Species-specific threshold limits
 */
export interface SpeciesLimitEntry {
  optimalMin?: number;
  optimalMax?: number;
  warningMin?: number;
  warningMax?: number;
  criticalMin?: number;
  criticalMax?: number;
}

/**
 * Species limits record keyed by species identifier
 */
export type SpeciesLimits = Record<string, SpeciesLimitEntry>;

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('water_quality_parameter_configs')
@Index(['tenantId', 'code'], { unique: true })
@Index(['tenantId', 'isActive', 'displayOrder'])
@Index(['tenantId', 'group'])
export class WaterQualityParameterConfig {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId!: string;

  // -------------------------------------------------------------------------
  // PARAMETER IDENTITY
  // -------------------------------------------------------------------------

  @Field({ description: 'Machine-readable code, e.g. temperature, dissolved_oxygen' })
  @Column({ type: 'varchar', length: 50 })
  code!: string;

  @Field({ description: 'Display name' })
  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Field({ description: 'Measurement unit, e.g. °C, mg/L, NTU' })
  @Column({ type: 'varchar', length: 30 })
  unit!: string;

  @Field(() => ParameterDataType, { description: 'Value data type' })
  @Column({
    type: 'enum',
    enum: ParameterDataType,
    default: ParameterDataType.NUMBER,
  })
  dataType!: ParameterDataType;

  @Field(() => Int, { description: 'Decimal places for number values' })
  @Column({ type: 'smallint', default: 2 })
  precision!: number;

  @Field(() => ParameterGroup, { description: 'Parameter group' })
  @Column({
    type: 'enum',
    enum: ParameterGroup,
    default: ParameterGroup.BASIC,
  })
  group!: ParameterGroup;

  // -------------------------------------------------------------------------
  // THRESHOLD LIMITS
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true, description: 'Optimal minimum value' })
  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true, transformer: new DecimalTransformer() })
  optimalMin?: number;

  @Field(() => Float, { nullable: true, description: 'Optimal maximum value' })
  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true, transformer: new DecimalTransformer() })
  optimalMax?: number;

  @Field(() => Float, { nullable: true, description: 'Warning minimum value' })
  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true, transformer: new DecimalTransformer() })
  warningMin?: number;

  @Field(() => Float, { nullable: true, description: 'Warning maximum value' })
  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true, transformer: new DecimalTransformer() })
  warningMax?: number;

  @Field(() => Float, { nullable: true, description: 'Critical minimum value' })
  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true, transformer: new DecimalTransformer() })
  criticalMin?: number;

  @Field(() => Float, { nullable: true, description: 'Critical maximum value' })
  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true, transformer: new DecimalTransformer() })
  criticalMax?: number;

  // -------------------------------------------------------------------------
  // SPECIES-SPECIFIC LIMITS
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true, description: 'Species-specific threshold overrides' })
  @Column({ type: 'jsonb', nullable: true })
  speciesLimits?: SpeciesLimits;

  // -------------------------------------------------------------------------
  // ENUM VALUES (for dataType=ENUM)
  // -------------------------------------------------------------------------

  @Field(() => [String], { nullable: true, description: 'Allowed values when dataType is ENUM' })
  @Column({ type: 'text', array: true, nullable: true })
  enumValues?: string[];

  // -------------------------------------------------------------------------
  // DISPLAY CONFIGURATION
  // -------------------------------------------------------------------------

  @Field({ description: 'Chart line/bar color (hex)' })
  @Column({ type: 'varchar', length: 9, default: '#3b82f6' })
  chartColor!: string;

  @Field({ nullable: true, description: 'Icon identifier' })
  @Column({ type: 'varchar', length: 50, nullable: true })
  icon?: string;

  @Field(() => Int, { description: 'Display ordering' })
  @Column({ type: 'smallint', default: 0 })
  displayOrder!: number;

  @Field({ description: 'Visible in UI lists and charts' })
  @Column({ default: true })
  isVisible!: boolean;

  @Field({ description: 'Required during measurement entry' })
  @Column({ default: false })
  isRequired!: boolean;

  @Field({ description: 'Parameter is active and available for use' })
  @Column({ default: true })
  isActive!: boolean;

  @Field({ nullable: true, description: 'Chart Y-axis group (left or right)' })
  @Column({ type: 'varchar', length: 20, nullable: true, default: 'left' })
  chartAxisGroup?: string;

  @Field({ description: 'Show in quick-access measurement panel' })
  @Column({ default: false })
  isQuickAccess!: boolean;

  @Field({ nullable: true, description: 'Source template identifier if provisioned from template' })
  @Column({ type: 'varchar', length: 50, nullable: true })
  templateSource?: string;

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
