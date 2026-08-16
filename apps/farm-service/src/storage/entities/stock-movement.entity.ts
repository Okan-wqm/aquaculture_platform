/**
 * Stock Movement Entity - Audit trail of stock changes
 */
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import { registerEnumType } from '@nestjs/graphql';
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

import { StorageItemType } from './storage-inventory.entity';

export enum MovementType {
  IN = 'in',
  OUT = 'out',
  TRANSFER = 'transfer',
  WASTE = 'waste',
  ADJUSTMENT = 'adjustment',
  RETURN = 'return',
}

registerEnumType(MovementType, {
  name: 'MovementType',
  description: 'Type of stock movement',
});

@Entity('stock_movements')
@Index(['tenantId', 'movementType'])
@Index(['itemType', 'itemId'])
@Index(['performedAt'])
// Composite index for TraceLot queries: enables efficient lot traceability
// without full table scan, required by EU 178/2002 Article 18 audits.
@Index(['tenantId', 'lotNumber'])
@Index('idx_stock_movements_tenant_idempotency', ['tenantId', 'idempotencyKey'], {
  unique: true,
  where: '"idempotency_key" IS NOT NULL',
})
@Index('uq_stock_movement_tenant_identity', ['tenantId', 'id'], { unique: true })
@Index('idx_stock_movement_allocation_family', ['tenantId', 'itemId', 'allocationFamilyKey'], {
  where: '"allocation_family_key" IS NOT NULL',
})
@Index('idx_stock_movement_source_movement', ['tenantId', 'sourceMovementId'], {
  where: '"source_movement_id" IS NOT NULL',
})
export class StockMovement {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  tenantId!: string;

  @Column({ type: 'varchar', length: 20, name: 'movement_type' })
  movementType!: MovementType;

  @Column({ type: 'varchar', length: 20, name: 'item_type' })
  itemType!: StorageItemType;

  @Column({ type: 'uuid', name: 'item_id' })
  itemId!: string;

  @Column({ type: 'varchar', length: 255, name: 'item_name' })
  itemName!: string;

  @Column({ type: 'decimal', precision: 15, scale: 2, transformer: new DecimalTransformer() })
  quantity!: number;

  @Column({ length: 20 })
  unit!: string;

  @Column({ type: 'uuid', nullable: true, name: 'from_location_id' })
  @Index()
  fromLocationId?: string;

  @Column({ type: 'uuid', nullable: true, name: 'to_location_id' })
  @Index()
  toLocationId?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reference?: string;

  @Column({ type: 'text', nullable: true })
  reason?: string;

  /**
   * Lot number associated with this movement. Captures which specific production
   * batch was affected, enabling full lot traceability as required by:
   * - EU Regulation 178/2002 Article 18 (food traceability)
   * - BAP (Best Aquaculture Practices) certification
   * - HACCP (Hazard Analysis Critical Control Points)
   *
   * For OUT movements, this identifies which lot was consumed (FEFO picking).
   * For IN movements, this records the lot received from the supplier.
   * For TRANSFER movements, this tracks lot movement between locations.
   */
  @Column({ type: 'varchar', length: 100, nullable: true, name: 'lot_number' })
  lotNumber?: string;

  /**
   * Expiry date of the lot involved in this movement. Stored on the movement
   * record (not just on inventory) so that the audit trail preserves the expiry
   * information even after the inventory row is depleted and removed.
   *
   * Critical for FEFO compliance verification: auditors can query movements
   * to confirm that earlier-expiring lots were consumed before later ones.
   */
  @Column({ type: 'date', nullable: true, name: 'expiry_date' })
  expiryDate?: Date;

  /**
   * Arrival instant of the exact inventory lot touched by this movement.
   *
   * A feeding deduction can drain and delete the projection row. A later
   * correction must therefore rebuild the row from immutable movement facts,
   * not from the correction clock. `expiryDate` alone is insufficient because
   * FEFO's canonical tie-break is `(expiryDate, receivedDate, lotNumber)`.
   * NULL is a truthful unknown for movements written before this authority.
   */
  @Column({ type: 'timestamptz', nullable: true, name: 'received_date' })
  receivedDate?: Date;

  /**
   * Stable feeding subject whose immutable OUT/RETURN slices form one
   * allocation ledger. Unlike the per-attempt idempotency key, this identity
   * survives repeated upward/downward corrections.
   */
  @Column({ type: 'varchar', length: 64, nullable: true, name: 'allocation_family_key' })
  allocationFamilyKey?: string;

  /** Exact OUT slice restored by this RETURN movement. */
  @Column({ type: 'uuid', nullable: true, name: 'source_movement_id' })
  sourceMovementId?: string;

  /**
   * Client-generated idempotency key to prevent duplicate movements from
   * network retries or double-click submissions. The unique index on this
   * column causes the database to reject duplicates at the constraint level.
   *
   * Enterprise pattern: Stripe, AWS, and SAP all use idempotency keys on
   * financial/inventory mutations. The key should be a UUID generated by the
   * client before the first submission attempt, and reused on retries.
   *
   * When a duplicate key is detected, the handler should return the existing
   * movement record instead of creating a new one.
   */
  @Column({ type: 'varchar', length: 64, nullable: true, name: 'idempotency_key' })
  idempotencyKey?: string;

  @Column({ type: 'uuid', name: 'performed_by' })
  performedBy!: string;

  /**
   * Denormalized display name of the user who performed this movement.
   * Stored at write time from the JWT payload (firstName + lastName) so that
   * the audit trail is self-contained — no cross-service query needed at read time.
   */
  @Column({ type: 'varchar', length: 255, nullable: true, name: 'performed_by_name' })
  performedByName?: string;

  @Column({ type: 'timestamptz', default: () => 'NOW()', name: 'performed_at' })
  performedAt!: Date;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
