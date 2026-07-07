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

import { VfdBrand, VfdParameterCategory, VfdDataType, ByteOrder } from './vfd.enums';
import { BitDefinition } from './vfd.types';

// Re-export types for backwards compatibility (isolatedModules requires
// the `type` modifier on type-only re-exports).
export type { BitDefinition, VfdRegisterMappingInput } from './vfd.types';

/**
 * VFD Register Mapping Entity
 * Stores brand-specific register addresses and configurations.
 *
 * SENSOR-MEDIUM-009: these are GLOBAL vendor reference data (Danfoss/ABB
 * register addresses) — identical for every tenant, with no tenantId column and
 * no per-tenant write path exposed (the resolver only reads; seedBrandMappings /
 * createCustomMapping are internal-only). It is therefore a cross-tenant table
 * pinned to the `sensor` schema (declares `schema:`), NOT a per-tenant clone.
 * Reads resolve to the single `sensor.vfd_register_mappings` regardless of
 * search_path; the built-in code mappings remain the fallback for brands not
 * present in the table.
 */
@ObjectType({ description: 'VFD register mapping configuration' })
@Entity({ name: 'vfd_register_mappings', schema: 'sensor' })
@Index(['brand'])
@Index(['brand', 'modelSeries'])
@Index(['brand', 'parameterName'])
@Index(['category'])
@Unique(['brand', 'modelSeries', 'parameterName'])
export class VfdRegisterMapping {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field(() => VfdBrand)
  @Column({ type: 'varchar', length: 50 })
  brand!: VfdBrand;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', name: 'model_series', length: 100, nullable: true })
  modelSeries?: string | null;

  @Field()
  @Column({ type: 'varchar', name: 'parameter_name', length: 100 })
  parameterName!: string;

  @Field()
  @Column({ type: 'varchar', name: 'display_name', length: 255 })
  displayName!: string;

  @Field(() => String, { nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @Field(() => VfdParameterCategory)
  @Column({ type: 'varchar', length: 50 })
  category!: VfdParameterCategory;

  @Field(() => Int)
  @Column({ type: 'int' })
  registerAddress!: number;

  @Field(() => Int)
  @Column({ type: 'int', name: 'register_count', default: 1 })
  registerCount!: number;

  @Field(() => Int)
  @Column({ type: 'int', name: 'function_code', default: 3 })
  functionCode!: number;

  @Field(() => VfdDataType)
  @Column({ type: 'varchar', name: 'data_type', length: 50, default: VfdDataType.UINT16 })
  dataType!: VfdDataType;

  @Field(() => Float)
  @Column({ type: 'numeric', precision: 15, scale: 6, name: 'scaling_factor', default: 1 })
  scalingFactor!: number;

  @Field(() => Float)
  @Column({ type: 'numeric', precision: 15, scale: 6, default: 0 })
  offset!: number;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 20, nullable: true })
  unit?: string | null;

  @Field(() => ByteOrder)
  @Column({ type: 'varchar', name: 'byte_order', length: 10, default: ByteOrder.BIG })
  byteOrder!: ByteOrder;

  @Field(() => ByteOrder)
  @Column({ type: 'varchar', name: 'word_order', length: 10, default: ByteOrder.BIG })
  wordOrder!: ByteOrder;

  @Field()
  @Column({ type: 'boolean', name: 'is_bit_field', default: false })
  isBitField!: boolean;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', name: 'bit_definitions', nullable: true })
  bitDefinitions?: BitDefinition[] | null;

  @Field()
  @Column({ type: 'boolean', name: 'is_readable', default: true })
  isReadable!: boolean;

  @Field()
  @Column({ type: 'boolean', name: 'is_writable', default: false })
  isWritable!: boolean;

  @Field(() => Int)
  @Column({ type: 'int', name: 'recommended_poll_interval_ms', default: 500 })
  recommendedPollIntervalMs!: number;

  @Field(() => Int)
  @Column({ type: 'int', name: 'display_order', default: 0 })
  displayOrder!: number;

  @Field()
  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive!: boolean;

  @Field()
  @Column({ type: 'boolean', name: 'is_critical', default: false })
  isCritical!: boolean;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'numeric', precision: 15, scale: 6, name: 'min_value', nullable: true })
  minValue?: number | null;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'numeric', precision: 15, scale: 6, name: 'max_value', nullable: true })
  maxValue?: number | null;

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

