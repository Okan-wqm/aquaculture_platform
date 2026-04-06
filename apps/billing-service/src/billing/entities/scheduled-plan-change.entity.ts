import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID } from '@nestjs/graphql';
import { PlanLimits, PlanPricing } from './subscription.entity';

/**
 * IP-2: Scheduled plan change — deferred subscription modifications.
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
  APPLIED = 'APPLIED',
  CANCELLED = 'CANCELLED',
}

@ObjectType()
@Entity('scheduled_plan_changes')
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

  // ── Current plan (snapshot at scheduling time) ──────────────────────────

  @Field()
  @Column()
  currentPlanId!: string;

  @Field()
  @Column()
  currentPlanTier!: string;

  // ── Target plan (what the tenant is changing to) ────────────────────────

  @Field()
  @Column()
  newPlanId!: string;

  @Field()
  @Column()
  newPlanTier!: string;

  @Field()
  @Column()
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
