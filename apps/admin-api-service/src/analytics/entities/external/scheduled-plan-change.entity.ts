/**
 * Scheduled Plan Change (read-only reference)
 *
 * A read-only view of the plan-change ledger owned by billing-service.
 * DO NOT modify — the source of truth is billing-service.
 *
 * # Why analytics reads this table
 *
 * A plan change is the only dated record of a tenant moving between tiers.
 * `billing.subscriptions` holds the CURRENT tier and nothing else, so a report
 * that asks "how many upgrades happened in March" cannot be answered from it —
 * which is why the revenue report hardcoded `upgrades: 0` (APA-139).
 *
 * Rows with `status = 'APPLIED'` and a non-null `appliedAt` are the ones that
 * actually happened; `PENDING` rows are scheduled downgrades that have not
 * taken effect, and `CANCELLED` rows were superseded. Counting anything but
 * APPLIED would report changes that never occurred.
 */
import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/** Mirrors billing-service's `ScheduledChangeStatus`. */
export enum ScheduledChangeStatus {
  PENDING = 'PENDING',
  APPLIED = 'APPLIED',
  CANCELLED = 'CANCELLED',
}

@Entity('scheduled_plan_changes', { schema: 'billing', synchronize: false })
@Index(['tenantId'])
export class ScheduledPlanChangeReadOnly {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'uuid' })
  subscriptionId!: string;

  @Column({ type: 'varchar', length: 50 })
  currentPlanTier!: string;

  @Column({ type: 'varchar', length: 50 })
  newPlanTier!: string;

  @Column({ type: 'enum', enum: ScheduledChangeStatus })
  status!: ScheduledChangeStatus;

  @Column({ type: 'timestamptz' })
  effectiveDate!: Date;

  /** When the change actually took effect. Null while `status` is PENDING. */
  @Column({ type: 'timestamptz', nullable: true })
  appliedAt?: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
