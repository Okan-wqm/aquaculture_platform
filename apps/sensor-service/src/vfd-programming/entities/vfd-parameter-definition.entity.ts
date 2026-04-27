import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from 'typeorm';
import { ObjectType, Field, ID, Int, Float } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

import {
  VfdBrand,
  VfdParameterGroup,
  RiskLevel,
} from '../../vfd/entities/vfd.enums';

/**
 * VFD Parameter Definition Entity
 * Writable VFD parameter definitions seeded from brand config files.
 * Can be customized per-tenant via DB overrides.
 */
@ObjectType({ description: 'VFD writable parameter definition' })
@Entity('vfd_parameter_definitions', { schema: 'sensor' })
@Index(['brand'])
@Index(['brand', 'group'])
@Unique(['brand', 'modelSeries', 'parameterName'])
export class VfdParameterDefinition {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field({ nullable: true })
  @Column({ type: 'uuid', name: 'tenant_id', nullable: true })
  tenantId?: string;

  @Field(() => VfdBrand)
  @Column({ type: 'varchar', length: 50 })
  brand!: VfdBrand;

  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 100, name: 'model_series', nullable: true })
  modelSeries?: string;

  @Field()
  @Column({ type: 'varchar', length: 100, name: 'parameter_name' })
  parameterName!: string;

  @Field()
  @Column({ type: 'varchar', length: 255, name: 'display_name' })
  displayName!: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field()
  @Column({ type: 'varchar', length: 50, default: 'configuration' })
  category!: string;

  @Field(() => VfdParameterGroup)
  @Column({ type: 'varchar', length: 50, name: 'group' })
  group!: VfdParameterGroup;

  @Field(() => Int)
  @Column({ type: 'int', name: 'register_address' })
  registerAddress!: number;

  @Field(() => Int)
  @Column({ type: 'int', name: 'register_count', default: 1 })
  registerCount!: number;

  @Field(() => Int)
  @Column({ type: 'int', name: 'function_code', default: 6 })
  functionCode!: number;

  @Field()
  @Column({ type: 'varchar', length: 50, name: 'data_type', default: 'uint16' })
  dataType!: string;

  @Field(() => Float)
  @Column({ type: 'float', name: 'scaling_factor', default: 1 })
  scalingFactor!: number;

  @Field(() => Float)
  @Column({ type: 'float', default: 0 })
  offset!: number;

  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 20, nullable: true })
  unit?: string;

  @Field()
  @Column({ type: 'varchar', length: 10, name: 'byte_order', default: 'big' })
  byteOrder!: string;

  @Field()
  @Column({ type: 'varchar', length: 10, name: 'word_order', default: 'big' })
  wordOrder!: string;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'float', name: 'min_value', nullable: true })
  minValue?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'float', name: 'max_value', nullable: true })
  maxValue?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'float', name: 'default_value', nullable: true })
  defaultValue?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'float', nullable: true })
  step?: number;

  @Field(() => RiskLevel)
  @Column({ type: 'varchar', length: 20, name: 'risk_level', default: 'medium' })
  riskLevel!: RiskLevel;

  @Field()
  @Column({ type: 'boolean', name: 'requires_motor_stop', default: false })
  requiresMotorStop!: boolean;

  @Field()
  @Column({ type: 'boolean', name: 'is_readable', default: true })
  isReadable!: boolean;

  @Field()
  @Column({ type: 'boolean', name: 'is_writable', default: true })
  isWritable!: boolean;

  @Field()
  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive!: boolean;

  @Field(() => Int)
  @Column({ type: 'int', name: 'display_order', default: 0 })
  displayOrder!: number;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @Field()
  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt!: Date;
}
