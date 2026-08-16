/**
 * Stock Movement Entity - Audit trail of stock changes
 */
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import { registerEnumType } from '@nestjs/graphql';
import { Check, Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

export enum StockMutationOperationType {
  PURCHASE_ORDER_RECEIPT = 'purchase_order_receipt',
}

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
@Index(
  'uq_stock_movements_operation_item_v1',
  ['tenantId', 'operationType', 'operationId', 'operationItemId'],
  {
    unique: true,
    where: '"operation_id" IS NOT NULL',
  },
)
@Index('idx_stock_movements_operation_v1', ['tenantId', 'operationType', 'operationId'], {
  where: '"operation_id" IS NOT NULL',
})
@Check(
  'ck_stock_movements_operation_coordinates_v1',
  `(
    "operation_type" IS NULL
    AND "operation_id" IS NULL
    AND "operation_payload_hash" IS NULL
    AND "operation_item_id" IS NULL
  ) OR (
    "operation_type" IS NOT NULL
    AND "operation_id" IS NOT NULL
    AND "operation_payload_hash" IS NOT NULL
    AND "operation_item_id" IS NOT NULL
  )`,
)
@Check(
  'ck_stock_movements_operation_payload_hash_v1',
  '"operation_payload_hash" IS NULL OR "operation_payload_hash" ~ \'^[0-9a-f]{64}$\'',
)
export class StockMovement {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  tenantId!: string;

  @Column({ type: 'varchar', length: 20, name: 'movement_type' })
  movementType!: MovementType;

  @Column({ type: 'varchar', length: 20, name: 'item_type' })
  itemType!: string; // feed/chemical/consumable

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

  /** Original arrival instant of the physical lot represented by this fact. */
  @Column({ type: 'timestamptz', nullable: true, name: 'received_date' })
  receivedDate?: Date;

  /** Stable identity shared by every FEFO slice of one logical allocation. */
  @Column({ type: 'varchar', length: 64, nullable: true, name: 'allocation_family_key' })
  @Index()
  allocationFamilyKey?: string;

  /** Stable root joining the original allocation and every later correction. */
  @Column({ type: 'varchar', length: 64, nullable: true, name: 'allocation_root_key' })
  @Index()
  allocationRootKey?: string;

  /** Deterministic order within an allocation/correction operation. */
  @Column({ type: 'int', nullable: true, name: 'allocation_slice_index' })
  allocationSliceIndex?: number;

  /** Exact OUT movement restored by a RETURN correction. */
  @Column({ type: 'uuid', nullable: true, name: 'source_movement_id' })
  @Index()
  sourceMovementId?: string;

  /** Typed logical operation that caused this immutable movement fact. */
  @Column({ type: 'varchar', length: 40, nullable: true, name: 'operation_type' })
  operationType?: StockMutationOperationType;

  /** Caller-stable operation identity shared by all facts in one atomic mutation. */
  @Column({ type: 'uuid', nullable: true, name: 'operation_id' })
  operationId?: string;

  /** SHA-256 of the canonical, actor-bound operation payload. */
  @Column({ type: 'char', length: 64, nullable: true, name: 'operation_payload_hash' })
  operationPayloadHash?: string;

  /** Stable line identity within the logical operation (PO item for receipts). */
  @Column({ type: 'uuid', nullable: true, name: 'operation_item_id' })
  operationItemId?: string;

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
