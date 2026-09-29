/**
 * StorageItemSitePolicy — the per-site DISTRIBUTION minimum of one stock item
 * (plan K8 tier 1, FARM-HIGH-336).
 *
 * WHY: the catalog `minStock` is tenant-wide while stock physically sits at a
 * site, so "Site A is empty while Site B is full" raised nothing. This row says
 * how much of the item a given site must hold; falling below it is a transfer
 * or a site purchase at THAT site, never a tenant purchase.
 *
 * Per-tenant table: no `schema:` — search_path routes it into `tenant_<uuid>`.
 * INVARIANT: at most one policy per (tenant, site, itemType, itemId) and
 * `minStock > 0` (a zero minimum is "no policy" and is expressed by deleting
 * the row). Both are enforced by the migration's unique index + CHECK.
 */
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';

import { StorageItemType } from './storage-inventory.entity';

@Entity('storage_item_site_policies')
@Index(['tenantId', 'siteId', 'itemType', 'itemId'], { unique: true })
@Index(['tenantId', 'itemType', 'itemId'])
export class StorageItemSitePolicy {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'site_id' })
  siteId!: string;

  @Column({ type: 'varchar', length: 20, name: 'item_type' })
  itemType!: StorageItemType;

  @Column({ type: 'uuid', name: 'item_id' })
  itemId!: string;

  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    name: 'min_stock',
    transformer: new DecimalTransformer(),
  })
  minStock!: number;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;

  @Column({ type: 'uuid', name: 'updated_by' })
  updatedBy!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @VersionColumn()
  version!: number;
}
