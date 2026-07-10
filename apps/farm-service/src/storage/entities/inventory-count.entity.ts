/**
 * Inventory Count Entity -- Physical stock verification session.
 *
 * Inventory counting is a regulatory requirement for BAP/ASC certified
 * aquaculture facilities. It reconciles system quantities (storage_inventory)
 * with actual physical quantities counted in the warehouse.
 *
 * Workflow: PLANNED -> IN_PROGRESS -> COMPLETED -> APPROVED
 * - PLANNED: Created, items auto-populated from storage_inventory
 * - IN_PROGRESS: Counter is actively counting items
 * - COMPLETED: All items counted, variance calculated, awaiting approval
 * - APPROVED: Manager approved, adjustments applied to storage_inventory
 *
 * SOC2 CC3.4: Approval requires a different user than the performer
 * (separation of duties for inventory adjustments).
 */
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  Index, OneToMany, VersionColumn,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import { registerEnumType } from '@nestjs/graphql';
import { InventoryCountItem } from './inventory-count-item.entity';

export enum InventoryCountStatus {
  PLANNED = 'PLANNED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  APPROVED = 'APPROVED',
}

registerEnumType(InventoryCountStatus, {
  name: 'InventoryCountStatus',
  description: 'Workflow status of an inventory count session',
});

@Entity('inventory_counts')
@Index(['tenantId', 'countNumber'], { unique: true })
@Index(['tenantId', 'status'])
@Index(['tenantId', 'storageLocationId'])
export class InventoryCount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  tenantId!: string;

  /**
   * Auto-generated count number in the format IC-YYYYMMDD-NNN.
   * Sequential per tenant per day to provide a human-readable reference
   * for warehouse staff writing on physical count sheets.
   */
  @Column({ type: 'varchar', length: 50, name: 'count_number' })
  countNumber!: string;

  /**
   * The storage location being counted. Each count session targets a single
   * location to ensure focus and accountability. Full-facility counts should
   * create one InventoryCount per location.
   */
  @Column({ type: 'uuid', name: 'storage_location_id' })
  storageLocationId!: string;

  @Column({ type: 'varchar', length: 30, default: 'PLANNED' })
  status!: InventoryCountStatus;

  /** Timestamp when counting physically began (status transitions to IN_PROGRESS) */
  @Column({ type: 'timestamptz', nullable: true, name: 'started_at' })
  startedAt?: Date;

  /** Timestamp when all items were counted (status transitions to COMPLETED) */
  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completedAt?: Date;

  /** Timestamp when a manager approved the count (status transitions to APPROVED) */
  @Column({ type: 'timestamptz', nullable: true, name: 'approved_at' })
  approvedAt?: Date;

  /**
   * UUID of the user who performed the physical count. Stored for SOC2 CC3.4
   * separation of duties enforcement: approvedBy must differ from performedBy.
   */
  @Column({ type: 'uuid', name: 'performed_by' })
  performedBy!: string;

  /** Denormalized display name of the counter (from JWT) for self-contained audit trail */
  @Column({ type: 'varchar', length: 255, nullable: true, name: 'performed_by_name' })
  performedByName?: string;

  /** UUID of the manager who approved the count. Must differ from performedBy (SOC2 CC3.4). */
  @Column({ type: 'uuid', nullable: true, name: 'approved_by' })
  approvedBy?: string;

  /** Denormalized display name of the approver (from JWT) for self-contained audit trail */
  @Column({ type: 'varchar', length: 255, nullable: true, name: 'approved_by_name' })
  approvedByName?: string;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  /**
   * Aggregate variance across all items: SUM(actualQuantity - expectedQuantity).
   * Positive = surplus (more physical stock than system), negative = shrinkage.
   * This is a denormalized field recalculated on every item update for query efficiency.
   */
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0, name: 'total_variance', transformer: new DecimalTransformer() })
  totalVariance!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @VersionColumn()
  version!: number;

  @OneToMany(() => InventoryCountItem, (item) => item.inventoryCount, { cascade: true })
  items!: InventoryCountItem[];
}
