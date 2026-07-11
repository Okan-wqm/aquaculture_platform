import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  Index, ManyToOne, JoinColumn,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import { PurchaseOrder } from './purchase-order.entity';

@Entity('purchase_order_items')
@Index(['tenantId', 'purchaseOrderId'])
export class PurchaseOrderItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'purchase_order_id' })
  purchaseOrderId!: string;

  @Column({ type: 'uuid', name: 'item_id' })
  itemId!: string;

  @Column({ type: 'varchar', length: 255, name: 'item_name' })
  itemName!: string;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'item_code' })
  itemCode?: string;

  @Column({ type: 'decimal', precision: 15, scale: 2, transformer: new DecimalTransformer() })
  quantity!: number;

  @Column({ type: 'varchar', length: 20 })
  unit!: string;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true, name: 'unit_price', transformer: new DecimalTransformer() })
  unitPrice?: number;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true, name: 'total_price', transformer: new DecimalTransformer() })
  totalPrice?: number;

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0, name: 'quantity_received', transformer: new DecimalTransformer() })
  quantityReceived!: number;

  @Column({ type: 'boolean', default: false, name: 'is_fully_received' })
  isFullyReceived!: boolean;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => PurchaseOrder, (po) => po.items)
  @JoinColumn({ name: 'purchase_order_id' })
  purchaseOrder!: PurchaseOrder;
}
