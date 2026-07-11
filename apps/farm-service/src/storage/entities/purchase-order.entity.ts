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
  // SUBMITTED is the maker-checker hand-off state: the creator (maker) submits
  // a DRAFT for review; only a checker (TENANT_ADMIN) can move SUBMITTED -> APPROVED
  // via the dedicated approve command. SOC2 CC3.4 separation of duties.
  SUBMITTED = 'SUBMITTED',
  // APPROVED is reachable ONLY through approvePurchaseOrder (checker gate). ORDERED
  // (the spend-commit state) is reachable ONLY from APPROVED, so a purchase order
  // can never be ordered without passing the approval gate.
  APPROVED = 'APPROVED',
  ORDERED = 'ORDERED',
  PARTIALLY_RECEIVED = 'PARTIALLY_RECEIVED',
  RECEIVED = 'RECEIVED',
  CANCELLED = 'CANCELLED',
}

registerEnumType(PurchaseOrderStatus, {
  name: 'PurchaseOrderStatus',
  description: 'Status of purchase order',
});

@Entity('purchase_orders')
@Index(['tenantId', 'orderNumber'], { unique: true })
@Index(['tenantId', 'status'])
@Index(['tenantId', 'category'])
export class PurchaseOrder {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  tenantId!: string;

  @Column({ type: 'varchar', length: 20, name: 'order_number' })
  orderNumber!: string;

  @Column({ type: 'varchar', length: 20 })
  category!: PurchaseOrderCategory;

  @Column({ type: 'varchar', length: 255, name: 'supplier_name' })
  supplierName!: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'supplier_contact' })
  supplierContact?: string;

  @Column({ type: 'varchar', length: 30, default: 'DRAFT' })
  status!: PurchaseOrderStatus;

  @Column({ type: 'date', nullable: true, name: 'expected_delivery_date' })
  expectedDeliveryDate?: Date;

  @Column({ type: 'date', nullable: true, name: 'actual_delivery_date' })
  actualDeliveryDate?: Date;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true, name: 'total_amount', transformer: new DecimalTransformer() })
  totalAmount?: number;

  @Column({ type: 'varchar', length: 3, default: 'NOK' })
  currency!: string;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;

  @Column({ type: 'uuid', nullable: true, name: 'approved_by' })
  approvedBy?: string;

  // Denormalized approver display name captured at approval time so the audit
  // trail survives even if the user record is later renamed or deleted (SOC2 CC3.4).
  @Column({ type: 'varchar', length: 255, nullable: true, name: 'approved_by_name' })
  approvedByName?: string;

  // Timestamp the checker approved the order — the immutable point-in-time the
  // spend was authorized. Nullable until the PO reaches APPROVED.
  @Column({ type: 'timestamptz', nullable: true, name: 'approved_at' })
  approvedAt?: Date;

  @Column({ type: 'boolean', default: false, name: 'is_deleted' })
  isDeleted!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @VersionColumn()
  version!: number;

  @OneToMany(() => PurchaseOrderItem, (item) => item.purchaseOrder, { cascade: true })
  items!: PurchaseOrderItem[];
}
