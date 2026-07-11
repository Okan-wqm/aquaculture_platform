/**
 * StorageLotMix Entity
 *
 * Records the event where two or more physical lots of the same item
 * end up in the same storage location. The FEFO pick algorithm in
 * RecordStockMovementHandler orders lots by expiry, but once the
 * lots share a silo / bin / tank, the physical contents are
 * inseparable. Consumer recalls that require lot-level
 * traceability (the Mattilsynet + EU food-safety regime demands a
 * 2-hour traceback on feed + medication incidents) need to know
 * which other lots may have co-contaminated.
 *
 * The row captures:
 *   - `contributingLots` — every lot that met in this location,
 *     with `quantityKg` and a derived `contributionPct`.
 *   - `effectiveLotNumber` — composite identifier emitted for any
 *     downstream outbound movement from the mixed location.
 *   - `mixedAt` — when the second lot crossed into the location.
 *
 * Phase 2.4 of the "Farm modülü kalan kör noktalar" plan. Closes
 * Girdi 15-B16.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { Field, Float, ID, ObjectType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';

import { StorageItemType } from './storage-inventory.entity';

export interface LotContribution {
  lotNumber: string;
  quantityKg: number;
  contributionPct: number;
  manufacturer?: string;
  expiryDate?: string;
}

@ObjectType()
@Entity('storage_lot_mixes')
@Index(['tenantId', 'storageLocationId'])
@Index(['tenantId', 'itemId'])
@Index(['tenantId', 'effectiveLotNumber'])
export class StorageLotMix {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId!: string;

  @Field()
  @Column('uuid')
  storageLocationId!: string;

  @Field(() => StorageItemType)
  @Column({ type: 'enum', enum: StorageItemType })
  itemType!: StorageItemType;

  @Field()
  @Column('uuid')
  itemId!: string;

  /**
   * Composite identifier of the form
   *   `MIX-<first-lot>+<second-lot>+...`
   * used on every outbound movement that empties mass from the mixed
   * location. Readable by operators in paper trace lookups.
   */
  @Field()
  @Column({ length: 255 })
  effectiveLotNumber!: string;

  @Field(() => GraphQLJSON)
  @Column('jsonb')
  contributingLots!: LotContribution[];

  @Field(() => Float)
  @Column('decimal', { precision: 14, scale: 2 })
  totalQuantityKg!: string;

  @Field()
  @Column('timestamptz')
  mixedAt!: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  createdBy?: string;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
