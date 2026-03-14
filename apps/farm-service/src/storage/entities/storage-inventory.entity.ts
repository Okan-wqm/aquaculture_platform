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
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common';
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
  id: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  tenantId: string;

  @Column({ type: 'uuid', name: 'storage_location_id' })
  @Index()
  storageLocationId: string;

  @Column({ type: 'varchar', length: 20, name: 'item_type' })
  itemType: StorageItemType;

  @Column({ type: 'uuid', name: 'item_id' })
  itemId: string;

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0, transformer: new DecimalTransformer() })
  quantity: number;

  @Column({ length: 20 })
  unit: string;

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'lot_number' })
  lotNumber?: string;

  @Column({ type: 'date', nullable: true, name: 'expiry_date' })
  expiryDate?: Date;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  @Column({ type: 'uuid', nullable: true, name: 'created_by' })
  createdBy?: string;

  @Column({ type: 'uuid', nullable: true, name: 'updated_by' })
  updatedBy?: string;
}
