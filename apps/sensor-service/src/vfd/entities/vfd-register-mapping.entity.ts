import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from 'typeorm';

import { VfdBrand, VfdParameterCategory, VfdDataType, ByteOrder } from './vfd.enums';

/**
 * Bit definitions for control/status words
 */
export interface BitDefinition {
  bit: number;
  name: string;
  description?: string;
}

/**
 * VFD Register Mapping Entity
 * Stores brand-specific register addresses and configurations
 */
@Entity('vfd_register_mappings', { schema: 'sensor' })
@Index(['brand'])
@Index(['brand', 'modelSeries'])
@Index(['brand', 'parameterName'])
@Index(['category'])
@Unique(['brand', 'modelSeries', 'parameterName'])
export class VfdRegisterMapping {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 50 })
  brand: VfdBrand;

  @Column({ type: 'varchar', length: 100, nullable: true })
  modelSeries?: string | null;

  @Column({ type: 'varchar', length: 100 })
  parameterName: string;

  @Column({ type: 'varchar', length: 255 })
  displayName: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @Column({ type: 'varchar', length: 50 })
  category: VfdParameterCategory;

  @Column({ type: 'int' })
  registerAddress: number;

  @Column({ type: 'int', default: 1 })
  registerCount: number;

  @Column({ type: 'int', default: 3 })
  functionCode: number;

  @Column({ type: 'varchar', length: 50, default: VfdDataType.UINT16 })
  dataType: VfdDataType;

  @Column({ type: 'float', default: 1 })
  scalingFactor: number;

  @Column({ type: 'float', default: 0 })
  offset: number;

  @Column({ type: 'varchar', length: 20, nullable: true })
  unit?: string | null;

  @Column({ type: 'varchar', length: 10, default: ByteOrder.BIG })
  byteOrder: ByteOrder;

  @Column({ type: 'varchar', length: 10, default: ByteOrder.BIG })
  wordOrder: ByteOrder;

  @Column({ type: 'boolean', default: false })
  isBitField: boolean;

  @Column({ type: 'jsonb', nullable: true })
  bitDefinitions?: BitDefinition[] | null;

  @Column({ type: 'boolean', default: true })
  isReadable: boolean;

  @Column({ type: 'boolean', default: false })
  isWritable: boolean;

  @Column({ type: 'int', default: 500 })
  recommendedPollIntervalMs: number;

  @Column({ type: 'int', default: 0 })
  displayOrder: number;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'boolean', default: false })
  isCritical: boolean;

  @Column({ type: 'float', nullable: true })
  minValue?: number | null;

  @Column({ type: 'float', nullable: true })
  maxValue?: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date;
}

/**
 * Input type for creating register mappings (used in brand configs)
 */
export interface VfdRegisterMappingInput {
  brand: VfdBrand;
  modelSeries?: string;
  parameterName: string;
  displayName: string;
  description?: string;
  category: VfdParameterCategory;
  registerAddress: number;
  registerCount?: number;
  functionCode?: number;
  dataType?: VfdDataType;
  scalingFactor?: number;
  offset?: number;
  unit?: string;
  byteOrder?: ByteOrder;
  wordOrder?: ByteOrder;
  isBitField?: boolean;
  bitDefinitions?: BitDefinition[];
  isReadable?: boolean;
  isWritable?: boolean;
  recommendedPollIntervalMs?: number;
  displayOrder?: number;
  isCritical?: boolean;
  minValue?: number;
  maxValue?: number;
}
