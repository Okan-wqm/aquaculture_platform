import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ObjectType, Field, ID } from '@nestjs/graphql';
import { PlanLimits, PlanPricing } from './subscription.entity';

/**
 * IP-2: Scheduled plan change — postponed subscription modifications.
 *
 * When a tenant downgrades their plan, the change is not applied immediately.
 * Instead, a ScheduledPlanChange row is created with status=PENDING. The
 * billing scheduler cron job applies it at currentPeriodEnd.
 *
 * WHY: Immediate downgrades would revoke access to features the tenant
 * has already paid for in the current billing period. Scheduling ensures
 * they get full value for their current period.
 *
 * Lifecycle: PENDING → APPLIED (by cron) or CANCELLED (by user/admin)
 */
export enum ScheduledChangeStatus {
  PENDING = 'PENDING',
  /** Saga lease state — a worker owns the operation while Stripe traffic runs. */
  PROCESSING = 'PROCESSING',
  /** Post-apply verification failed; the row awaits reconciliation. */
  RECONCILIATION_REQUIRED = 'RECONCILIATION_REQUIRED',
  APPLIED = 'APPLIED',
  CANCELLED = 'CANCELLED',
}

@ObjectType()
@Entity('scheduled_plan_changes', { schema: 'billing' })
@Index(['tenantId', 'status'])
@Index(['effectiveDate', 'status'])
export class ScheduledPlanChange {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid' })
  @Index()
  tenantId!: string;

  @Field()
  @Column({ type: 'uuid' })
  subscriptionId!: string;

  // DBR-MEDIUM-002 cure: explicit FK relation. Entity-level @ManyToOne
  // with onDelete: 'RESTRICT' mirrors the DB-level constraint installed
  // by migration 1788400000000-AddScheduledPlanChangeFks. RESTRICT is the
  // right semantics — a subscription with pending plan-change rows must
  // not be hard-deletable; soft-delete is the only allowed lifecycle.
  @ManyToOne('Subscription', { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'subscriptionId', referencedColumnName: 'id' })
  subscription?: import('./subscription.entity').Subscription;

  // ── Current plan (snapshot at scheduling time) ──────────────────────────

  @Field()
  @Column({ type: 'uuid' })
  currentPlanId!: string;

  // DBR-MEDIUM-002 cure: FK to billing.plans for the snapshot at
  // scheduling time. RESTRICT keeps audit history intact — deleting
  // a plan referenced by a scheduled change is a data-integrity
  // violation, not a routine operation.
  @ManyToOne('Plan', { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'currentPlanId', referencedColumnName: 'id' })
  currentPlan?: import('./plan.entity').Plan;

  @Field()
  @Column({ type: 'varchar', length: 50 })
  currentPlanTier!: string;

  // ── Target plan (what the tenant is changing to) ────────────────────────

  @Field()
  @Column({ type: 'uuid' })
  newPlanId!: string;

  // DBR-MEDIUM-002 cure: FK to billing.plans for the destination plan.
  // RESTRICT — the scheduled change CANNOT fire against a plan that no
  // longer exists; deletion is blocked at the DB level until the
  // scheduled change is cancelled.
  @ManyToOne('Plan', { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'newPlanId', referencedColumnName: 'id' })
  newPlan?: import('./plan.entity').Plan;

  @Field()
  @Column({ type: 'varchar', length: 50 })
  newPlanTier!: string;

  @Field()
  @Column({ type: 'varchar', length: 255 })
  newPlanName!: string;

  @Field(() => PlanLimits)
  @Column('jsonb')
  newLimits!: PlanLimits;

  @Field(() => PlanPricing)
  @Column('jsonb')
  newPricing!: PlanPricing;

  // ── Scheduling metadata ─────────────────────────────────────────────────

  @Field()
  @Column({ type: 'enum', enum: ScheduledChangeStatus, default: ScheduledChangeStatus.PENDING })
  status!: ScheduledChangeStatus;

  // ── Plan-change operation saga (SEC-MEDIUM-089, migration
  // 1802100000000): the durable journal for BOTH immediate and scheduled
  // plan changes — the pro-rata credit lives HERE, never only in a log line.
  /** Subscription version the operation expects (optimistic concurrency). */
  @Column({ type: 'int' })
  expectedSubscriptionVersion!: number;

  /** Plan name at operation creation (NOT NULL per saga migration). */
  @Column({ type: 'varchar', length: 255 })
  currentPlanName!: string;

  /** Resolved Stripe price for the target plan + cycle (null: no Stripe sync). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  targetStripePriceId!: string | null;

  /** Unbilled remainder credited for the current period (numeric 19,4). */
  @Column({ type: 'numeric', precision: 19, scale: 4, default: 0 })
  proRataCredit!: number;

  /** True when the operation raises the tier (immediate apply semantics). */
  @Column({ type: 'boolean', default: false })
  isUpgrade!: boolean;

  /** Lease start while a worker runs Stripe traffic. */
  @Column({ type: 'timestamptz', nullable: true })
  processingStartedAt!: Date | null;

  /** Lease token — the holder may retry with the row id as idempotency key. */
  @Column({ type: 'uuid', nullable: true })
  processingToken!: string | null;

  /** Delivery attempts (>= 0, CHECK-constrained). */
  @Column({ type: 'int', default: 0 })
  attemptCount!: number;

  /** Last attempt's error code, for reconciliation triage. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  lastAttemptErrorCode!: string | null;

  @Field()
  @Column({ type: 'timestamptz' })
  effectiveDate!: Date;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  reason?: string;

  @Field({ nullable: true })
  @Column({ type: 'uuid', nullable: true })
  scheduledBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  appliedAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  cancellationReason?: string;

  // ── Audit fields ────────────────────────────────────────────────────────

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
