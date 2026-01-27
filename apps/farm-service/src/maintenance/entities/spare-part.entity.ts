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

export interface StorageLocation {
  warehouse?: string;
  shelf?: string;
  bin?: string;
  notes?: string;
}

@Entity('spare_parts')
@Index(['tenantId', 'partNumber'], { unique: true })
@Index(['tenantId', 'code'], { unique: true })
@Index(['tenantId', 'status'])
@Index(['tenantId', 'equipmentTypeId'])
@Index(['tenantId', 'supplierId'])
export class SparePart {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  @Index()
  tenantId: string;

  @Column({ length: 255 })
  name: string;

  @Column({ length: 50 })
  code: string;

  @Column({ length: 100 })
  partNumber: string; // Üretici parça numarası

  @Column({ type: 'text', nullable: true })
  description?: string;

  /**
   * Bu yedek parça hangi ekipman tipi için kullanılır
   * NULL ise genel parça (birden fazla tip için)
   */
  @Column('uuid', { nullable: true })
  equipmentTypeId?: string;

  @ManyToOne('EquipmentType', { nullable: true })
  @JoinColumn({ name: 'equipmentTypeId' })
  equipmentType?: EquipmentType;

  /**
   * Uyumlu ekipman tipleri (equipmentTypeId NULL ise)
   */
  @Column({ type: 'simple-array', nullable: true })
  compatibleEquipmentTypes?: string[];

  @Column('uuid', { nullable: true })
  supplierId?: string;

  @ManyToOne('Supplier', { nullable: true })
  @JoinColumn({ name: 'supplierId' })
  supplier?: Supplier;

  @Column({ length: 100, nullable: true })
  manufacturer?: string;

  @Column({ type: 'int', default: 0 })
  quantity: number; // Mevcut stok

  @Column({ type: 'int', default: 0 })
  minStock: number; // Minimum stok seviyesi

  @Column({ type: 'int', default: 0 })
  maxStock: number; // Maximum stok seviyesi

  @Column({ type: 'int', default: 0 })
  reorderPoint: number; // Yeniden sipariş noktası

  @Column({ length: 20, default: 'piece' })
  unit: string; // piece, set, box, kg, liter, meter

  @Column({
    type: 'enum',
    enum: SparePartStatus,
    default: SparePartStatus.IN_STOCK,
  })
  status: SparePartStatus;

  @Column({ type: 'jsonb', nullable: true })
  location?: StorageLocation;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  unitPrice?: number;

  @Column({ length: 3, default: 'TRY' })
  currency: string;

  @Column({ type: 'jsonb', nullable: true })
  specifications?: Record<string, unknown>;

  @Column({ type: 'int', nullable: true })
  leadTimeDays?: number; // Tedarik süresi

  @Column({ type: 'date', nullable: true })
  lastOrderDate?: Date;

  @Column({ type: 'date', nullable: true })
  lastUsedDate?: Date;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Column('uuid', { nullable: true })
  createdBy?: string;

  @Column('uuid', { nullable: true })
  updatedBy?: string;

  @VersionColumn()
  version: number;
}
