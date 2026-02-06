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

// Re-export types for backwards compatibility
export { BitDefinition, VfdRegisterMappingInput } from './vfd.types';

/**
 * VFD Register Mapping Entity
 * Stores brand-specific register addresses and configurations
 */
@ObjectType({ description: 'VFD register mapping configuration' })
@Entity('vfd_register_mappings')
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
  @Column({ type: 'varchar', length: 100, nullable: true })
  modelSeries?: string | null;

  @Field()
  @Column({ type: 'varchar', length: 100 })
  parameterName!: string;

  @Field()
  @Column({ type: 'varchar', length: 255 })
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
  @Column({ type: 'int', default: 1 })
  registerCount!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 3 })
  functionCode!: number;

  @Field(() => VfdDataType)
  @Column({ type: 'varchar', length: 50, default: VfdDataType.UINT16 })
  dataType!: VfdDataType;

  @Field(() => Float)
  @Column({ type: 'float', default: 1 })
  scalingFactor!: number;

  @Field(() => Float)
  @Column({ type: 'float', default: 0 })
  offset!: number;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 20, nullable: true })
  unit?: string | null;

  @Field(() => ByteOrder)
  @Column({ type: 'varchar', length: 10, default: ByteOrder.BIG })
  byteOrder!: ByteOrder;

  @Field(() => ByteOrder)
  @Column({ type: 'varchar', length: 10, default: ByteOrder.BIG })
  wordOrder!: ByteOrder;

  @Field()
  @Column({ type: 'boolean', default: false })
  isBitField!: boolean;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  bitDefinitions?: BitDefinition[] | null;

  @Field()
  @Column({ type: 'boolean', default: true })
  isReadable!: boolean;

  @Field()
  @Column({ type: 'boolean', default: false })
  isWritable!: boolean;

  @Field(() => Int)
  @Column({ type: 'int', default: 500 })
  recommendedPollIntervalMs!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  displayOrder!: number;

  @Field()
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Field()
  @Column({ type: 'boolean', default: false })
  isCritical!: boolean;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'float', nullable: true })
  minValue?: number | null;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'float', nullable: true })
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

