/**
 * Storage Inventory Entity - Items stored in a location
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  VersionColumn,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import { registerEnumType } from '@nestjs/graphql';

export enum StorageItemType {
  FEED = 'feed',
  CHEMICAL = 'chemical',
  CONSUMABLE = 'consumable',
  HEALTHCARE = 'healthcare',
}

registerEnumType(StorageItemType, {
  name: 'StorageItemType',
  description: 'Type of item in storage',
});

@Entity('storage_inventory')
@Index(['tenantId', 'storageLocationId', 'itemType', 'itemId', 'lotNumber'], { unique: true })
@Index(['itemType', 'itemId'])
export class StorageInventory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  tenantId!: string;

  @Column({ type: 'uuid', name: 'storage_location_id' })
  @Index()
  storageLocationId!: string;

  @Column({ type: 'varchar', length: 20, name: 'item_type' })
  itemType!: StorageItemType;

  @Column({ type: 'uuid', name: 'item_id' })
  itemId!: string;

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0, transformer: new DecimalTransformer() })
  quantity!: number;

  @Column({ length: 20 })
  unit!: string;

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'lot_number' })
  lotNumber?: string;

  @Column({ type: 'date', nullable: true, name: 'expiry_date' })
  expiryDate?: Date;

  /**
   * Wall-clock moment this specific lot landed in this location.
   * Phase 1.3 FEFO hardening ordered picks by
   *   (expiryDate ASC, receivedDate ASC, lotNumber ASC)
   * to produce a deterministic pick even when two lots share an
   * expiry date. The handler and event-bus FEFO path both reference
   * this column, so an unset value would break the order-by even if
   * it parsed. Defaults to NOW() at the database level so rows that
   * predate this migration still sort stably (older rows → older
   * timestamps = preferred first, matching FEFO's intent).
   */
  @Column({ type: 'timestamptz', nullable: true, name: 'received_date' })
  receivedDate?: Date;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  /**
   * Optimistic lock version counter. TypeORM auto-increments this on every UPDATE.
   * Concurrent modifications (e.g., two warehouse workers updating the same inventory
   * row simultaneously) will throw OptimisticLockVersionMismatchError on the second
   * write, preventing silent data loss. The application layer should catch this error
   * and prompt the user to retry with fresh data.
   *
   * Enterprise pattern: SAP uses "change document number" for the same purpose.
   * This column is essential because inventory is the highest-contention entity
   * in any WMS system — feeding schedules, manual adjustments, PO receipts, and
   * waste write-offs can all target the same row within seconds.
   */
  @VersionColumn()
  version!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'uuid', nullable: true, name: 'created_by' })
  createdBy?: string;

  @Column({ type: 'uuid', nullable: true, name: 'updated_by' })
  updatedBy?: string;
}
