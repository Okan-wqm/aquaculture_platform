import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  Index, OneToMany, VersionColumn,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import { registerEnumType } from '@nestjs/graphql';
import { PurchaseOrderItem } from './purchase-order-item.entity';

export enum PurchaseOrderCategory {
  FEED = 'FEED',
  CHEMICAL = 'CHEMICAL',
  CONSUMABLE = 'CONSUMABLE',
  HEALTHCARE = 'HEALTHCARE',
}

registerEnumType(PurchaseOrderCategory, {
  name: 'PurchaseOrderCategory',
  description: 'Category of purchase order',
});

export enum PurchaseOrderStatus {
  DRAFT = 'DRAFT',
  ORDERED = 'ORDERED',
  PARTIALLY_RECEIVED = 'PARTIALLY_RECEIVED',
  RECEIVED = 'RECEIVED',
  CANCELLED = 'CANCELLED',
}

registerEnumType(PurchaseOrderStatus, {
  name: 'PurchaseOrderStatus',
  description: 'Status of purchase order',
});

@Entity('purchase_orders', { schema: 'farm' })
@Index(['tenantId', 'orderNumber'], { unique: true })
@Index(['tenantId', 'status'])
@Index(['tenantId', 'category'])
export class PurchaseOrder {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  tenantId: string;

  @Column({ type: 'varchar', length: 20, name: 'order_number' })
  orderNumber: string;

  @Column({ type: 'varchar', length: 20 })
  category: PurchaseOrderCategory;

  @Column({ type: 'varchar', length: 255, name: 'supplier_name' })
  supplierName: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'supplier_contact' })
  supplierContact?: string;

  @Column({ type: 'varchar', length: 30, default: 'DRAFT' })
  status: PurchaseOrderStatus;

  @Column({ type: 'date', nullable: true, name: 'expected_delivery_date' })
  expectedDeliveryDate?: Date;

  @Column({ type: 'date', nullable: true, name: 'actual_delivery_date' })
  actualDeliveryDate?: Date;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true, name: 'total_amount', transformer: new DecimalTransformer() })
  totalAmount?: number;

  @Column({ type: 'varchar', length: 3, default: 'NOK' })
  currency: string;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy: string;

  @Column({ type: 'uuid', nullable: true, name: 'approved_by' })
  approvedBy?: string;

  @Column({ type: 'boolean', default: false, name: 'is_deleted' })
  isDeleted: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  @VersionColumn()
  version: number;

  @OneToMany(() => PurchaseOrderItem, (item) => item.purchaseOrder, { cascade: true })
  items: PurchaseOrderItem[];
}
