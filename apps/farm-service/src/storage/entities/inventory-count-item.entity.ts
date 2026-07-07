/**
 * Inventory Count Item Entity -- Individual line item within a count session.
 *
 * Each row represents one storage_inventory record that exists in the target
 * location at the time the count was created. The expectedQuantity is a snapshot
 * of the system balance; actualQuantity is filled in by the warehouse staff
 * during the physical count. Variance is computed as actual - expected.
 *
 * This design follows the "snapshot + delta" pattern used by SAP WM and Oracle WMS:
 * capture the system state at count creation, then record deviations.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  Index, ManyToOne, JoinColumn,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import { StorageItemType } from './storage-inventory.entity';
import { InventoryCount } from './inventory-count.entity';

@Entity('inventory_count_items')
@Index(['tenantId', 'inventoryCountId'])
export class InventoryCountItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'inventory_count_id' })
  inventoryCountId!: string;

  /**
   * Type of item being counted — mirrors the storage_inventory.itemType.
   * Stored here so the count report can be filtered by category without
   * joining back to storage_inventory (which may have changed since the count).
   */
  @Column({ type: 'varchar', length: 20, name: 'item_type' })
  itemType!: StorageItemType;

  /** Reference to the master item (feed, chemical, consumable, or healthcare product) */
  @Column({ type: 'uuid', name: 'item_id' })
  itemId!: string;

  /** Denormalized item name at count creation time for self-contained reporting */
  @Column({ type: 'varchar', length: 255, name: 'item_name' })
  itemName!: string;

  @Column({ type: 'varchar', length: 20 })
  unit!: string;

  /** Lot number from storage_inventory — enables lot-level variance analysis */
  @Column({ type: 'varchar', length: 100, nullable: true, name: 'lot_number' })
  lotNumber?: string;

  /**
   * System quantity at the moment the count was created — a frozen snapshot.
   * This value MUST NOT be updated after creation, even if inventory changes
   * between count creation and the actual physical counting.
   */
  @Column({ type: 'decimal', precision: 15, scale: 2, name: 'expected_quantity', transformer: new DecimalTransformer() })
  expectedQuantity!: number;

  /**
   * Physical quantity observed by the warehouse staff during counting.
   * Null until the item is actually counted. All items must have a non-null
   * actualQuantity before the count can transition to COMPLETED status.
   */
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true, name: 'actual_quantity', transformer: new DecimalTransformer() })
  actualQuantity?: number;

  /**
   * Computed variance: actualQuantity - expectedQuantity.
   * Positive = surplus (found more than expected), negative = shrinkage (loss).
   * Null until actualQuantity is filled in.
   */
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  variance?: number;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => InventoryCount, (ic) => ic.items)
  @JoinColumn({ name: 'inventory_count_id' })
  inventoryCount!: InventoryCount;
}
