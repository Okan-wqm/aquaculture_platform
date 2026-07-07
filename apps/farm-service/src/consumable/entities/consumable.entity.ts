/**
 * Consumable Entity - General consumable items
 * Nets, ropes, PPE, spare parts, tools, etc.
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
import { registerEnumType } from '@nestjs/graphql';
import type { Supplier } from '../../supplier/entities/supplier.entity';

export enum ConsumableCategory {
  NET = 'net',
  ROPE = 'rope',
  PPE = 'ppe',
  SPARE_PART = 'spare_part',
  OXYGEN = 'oxygen',
  PACKAGING = 'packaging',
  CLEANING = 'cleaning',
  TOOL = 'tool',
  ELECTRICAL = 'electrical',
  PIPE_FITTING = 'pipe_fitting',
  OTHER = 'other',
}

registerEnumType(ConsumableCategory, {
  name: 'ConsumableCategory',
  description: 'Category of consumable item',
});

export enum ConsumableStatus {
  AVAILABLE = 'available',
  LOW_STOCK = 'low_stock',
  OUT_OF_STOCK = 'out_of_stock',
  DISCONTINUED = 'discontinued',
}

registerEnumType(ConsumableStatus, {
  name: 'ConsumableStatus',
  description: 'Status of the consumable',
});

@Entity('consumables')
@Index(['tenantId', 'code'], { unique: true })
@Index(['tenantId', 'category'])
@Index(['tenantId', 'status'])
export class Consumable {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  tenantId!: string;

  @Column({ length: 255 })
  name!: string;

  @Column({ length: 50 })
  code!: string;

  @Column({
    type: 'varchar',
    length: 30,
    default: ConsumableCategory.OTHER,
  })
  category!: ConsumableCategory;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ length: 20, default: 'pcs' })
  unit!: string;

  @Column({ length: 255, nullable: true })
  brand?: string;

  @Column({ type: 'uuid', name: 'supplier_id', nullable: true })
  @Index()
  supplierId?: string;

  @ManyToOne('Supplier', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'supplier_id' })
  supplier?: Supplier;

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0, transformer: new DecimalTransformer() })
  quantity!: number;

  // DecimalTransformer: minStock threshold compared against current quantity to trigger reorder alerts.
  // String comparison produces wrong results — e.g., "5.0" > "10.0" lexicographically.
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0, name: 'min_stock', transformer: new DecimalTransformer() })
  minStock!: number;

  @Column({
    type: 'varchar',
    length: 20,
    default: ConsumableStatus.AVAILABLE,
  })
  status!: ConsumableStatus;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true, name: 'unit_price', transformer: new DecimalTransformer() })
  unitPrice?: number;

  @Column({ length: 3, default: 'NOK' })
  currency!: string;

  // Storage conditions
  @Column({ type: 'decimal', precision: 5, scale: 1, nullable: true, name: 'storage_temp_min', transformer: new DecimalTransformer() })
  storageTempMin?: number;

  @Column({ type: 'decimal', precision: 5, scale: 1, nullable: true, name: 'storage_temp_max', transformer: new DecimalTransformer() })
  storageTempMax?: number;

  @Column({ type: 'decimal', precision: 5, scale: 1, nullable: true, name: 'storage_humidity_min', transformer: new DecimalTransformer() })
  storageHumidityMin?: number;

  @Column({ type: 'decimal', precision: 5, scale: 1, nullable: true, name: 'storage_humidity_max', transformer: new DecimalTransformer() })
  storageHumidityMax?: number;

  @Column({ type: 'text', nullable: true, name: 'storage_requirements' })
  storageRequirements?: string;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Column({ default: true, name: 'is_active' })
  @Index()
  isActive!: boolean;

  // Soft delete
  @Column({ default: false, name: 'is_deleted' })
  @Index()
  isDeleted!: boolean;

  @Column({ type: 'timestamptz', nullable: true, name: 'deleted_at' })
  deletedAt?: Date;

  @Column({ type: 'uuid', nullable: true, name: 'deleted_by' })
  deletedBy?: string;

  // Audit
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'uuid', nullable: true, name: 'created_by' })
  createdBy?: string;

  @Column({ type: 'uuid', nullable: true, name: 'updated_by' })
  updatedBy?: string;

  @VersionColumn()
  version!: number;

  // Business methods
  updateStockStatus(): void {
    if (this.quantity <= 0) {
      this.status = ConsumableStatus.OUT_OF_STOCK;
    } else if (this.quantity <= this.minStock) {
      this.status = ConsumableStatus.LOW_STOCK;
    } else {
      this.status = ConsumableStatus.AVAILABLE;
    }
  }

  softDelete(deletedBy?: string): void {
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.deletedBy = deletedBy;
    this.isActive = false;
  }

  /**
   * Undo a soft delete. Counterpart to `softDelete` so the
   * generic RestoreService can operate on Consumable like every
   * other restorable entity in the service. Phase 4.2.
   */
  restore(): void {
    this.isDeleted = false;
    this.deletedAt = undefined;
    this.deletedBy = undefined;
    this.isActive = true;
  }
}
