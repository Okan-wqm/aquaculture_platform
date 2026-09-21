/**
 * SparePart Entity - Yedek parçalar
 * Ekipmanlar için stokta tutulan yedek parçalar
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
  VersionColumn,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import { DecimalScalar } from '@aquaculture/backend-common/graphql';
import {
  ObjectType,
  Field,
  ID,
  Float,
  Int,
  registerEnumType,
} from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
// Note: Supplier and EquipmentType are referenced via string to avoid circular dependency
// Type-only imports for TypeScript type checking
import type { EquipmentType } from '../../equipment/entities/equipment-type.entity';
import type { Supplier } from '../../supplier/entities/supplier.entity';

export enum SparePartStatus {
  IN_STOCK = 'in_stock',
  LOW_STOCK = 'low_stock',
  OUT_OF_STOCK = 'out_of_stock',
  ON_ORDER = 'on_order',
  DISCONTINUED = 'discontinued',
}

registerEnumType(SparePartStatus, {
  name: 'SparePartStatus',
  description: 'Yedek parça stok durumu',
});

export interface StorageLocation {
  warehouse?: string;
  shelf?: string;
  bin?: string;
  notes?: string;
}

@ObjectType()
@Entity('spare_parts')
@Index(['tenantId', 'partNumber'], { unique: true })
@Index(['tenantId', 'code'], { unique: true })
@Index(['tenantId', 'status'])
@Index(['tenantId', 'equipmentTypeId'])
@Index(['tenantId', 'supplierId'])
export class SparePart {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId!: string;

  @Field()
  @Column({ length: 255 })
  name!: string;

  @Field()
  @Column({ length: 50 })
  code!: string;

  @Field()
  @Column({ length: 100 })
  partNumber!: string; // Üretici parça numarası

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  /**
   * Bu yedek parça hangi ekipman tipi için kullanılır
   * NULL ise genel parça (birden fazla tip için)
   */
  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  equipmentTypeId?: string;

  @ManyToOne('EquipmentType', { nullable: true })
  @JoinColumn({ name: 'equipmentTypeId' })
  equipmentType?: EquipmentType;

  /**
   * Uyumlu ekipman tipleri (equipmentTypeId NULL ise)
   */
  @Field(() => [String], { nullable: true })
  @Column({ type: 'simple-array', nullable: true })
  compatibleEquipmentTypes?: string[];

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  supplierId?: string;

  @ManyToOne('Supplier', { nullable: true })
  @JoinColumn({ name: 'supplierId' })
  supplier?: Supplier;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  manufacturer?: string;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  quantity!: number; // Mevcut stok

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  minStock!: number; // Minimum stok seviyesi

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  maxStock!: number; // Maximum stok seviyesi

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  reorderPoint!: number; // Yeniden sipariş noktası

  @Field()
  @Column({ length: 20, default: 'piece' })
  unit!: string; // piece, set, box, kg, liter, meter

  @Field(() => SparePartStatus)
  @Column({
    type: 'enum',
    enum: SparePartStatus,
    default: SparePartStatus.IN_STOCK,
  })
  status!: SparePartStatus;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  location?: StorageLocation;

  @Field(() => Float, {
    nullable: true,
    deprecationReason: 'Use unitPriceDecimal (exact decimal string, ADR-0004).',
  })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  unitPrice?: number;

  /** Exact-decimal wire form of `unitPrice` (ADR-0004 / DATA-MEDIUM-009). */
  @Field(() => DecimalScalar, { nullable: true })
  get unitPriceDecimal(): number | null {
    return this.unitPrice ?? null;
  }

  @Field()
  @Column({ length: 3, default: 'TRY' })
  currency!: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  specifications?: Record<string, unknown>;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  leadTimeDays?: number; // Tedarik süresi

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  lastOrderDate?: Date;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  lastUsedDate?: Date;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Field()
  @Column({ default: true })
  isActive!: boolean;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  createdBy?: string;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  updatedBy?: string;

  @Field(() => Int)
  @VersionColumn()
  version!: number;
}
