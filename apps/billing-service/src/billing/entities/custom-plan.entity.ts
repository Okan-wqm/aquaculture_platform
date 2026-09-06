/**
 * A negotiated per-tenant plan (ADR-0013, BILLING-CRITICAL-002).
 *
 * `admin.custom_plans` held the whole priced selection inside ONE `jsonb`
 * column: every module's `subtotal` and every line item's `unitPrice` and
 * `total` were IEEE-754 numbers no CHECK could reach, and the plan's own
 * `monthlySubtotal` / `discountAmount` / `monthlyTotal` were `decimal(12,2)`
 * read back through a transformer that widened them to `number` before any
 * arithmetic touched them. `discountPercent` had no bound at all, so a plan
 * could be discounted 400% and quietly floor to a total of zero.
 *
 * Here the selection is rows — one per module, one per priced line — every
 * amount is `numeric(19,4)` under `CHECK (>= 0)`, `discount_percent` is
 * CHECKed into [0, 100], and the plan cannot be worth less than nothing.
 */
import { MoneyColumn } from '@aquaculture/backend-common/monetary';
import type {
  BillingCustomPlanStatus,
  BillingModuleQuantities,
  BillingPricingMetricType,
} from '@platform/event-contracts';
import { BILLING_CUSTOM_PLAN_STATUSES } from '@platform/event-contracts';
import Decimal from 'decimal.js';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { BillingCycle, PlanTier } from './subscription.entity';

/** A rate, not money — bounded to [0, 100] by a CHECK the jsonb never had. */
const PERCENT_TRANSFORMER = {
  to: (value: Decimal | null | undefined): string | null =>
    value === null || value === undefined ? null : value.toString(),
  from: (value: string | null | undefined): Decimal | null =>
    value === null || value === undefined ? null : new Decimal(value),
};

/** Counts and flags, so they stay a jsonb blob — there is no money in here. */
export type CustomPlanQuantities = Omit<BillingModuleQuantities, 'moduleId'>;

@Entity('custom_plans', { schema: 'billing' })
@Index(['tenantId'])
@Index(['status'])
@Index(['validFrom'])
export class CustomPlan {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /**
   * The catalogue plan this was derived from, if any — a `billing.plans` id.
   * It is a real foreign key again now that both tables live in `billing`;
   * as an admin column it could only be a soft reference.
   */
  @Column({ type: 'uuid', name: 'base_plan_id', nullable: true })
  basePlanId!: string | null;

  @Column({ type: 'enum', enum: PlanTier, default: PlanTier.CUSTOM })
  tier!: PlanTier;

  @Column({
    type: 'enum',
    enum: BillingCycle,
    name: 'billing_cycle',
    default: BillingCycle.MONTHLY,
  })
  billingCycle!: BillingCycle;

  @OneToMany('CustomPlanModule', 'customPlan', { cascade: false })
  modules?: CustomPlanModule[];

  @MoneyColumn({ name: 'monthly_subtotal', default: 0 })
  monthlySubtotal!: Decimal;

  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: 0,
    name: 'discount_percent',
    transformer: PERCENT_TRANSFORMER,
  })
  discountPercent!: Decimal;

  @MoneyColumn({ name: 'discount_amount', default: 0 })
  discountAmount!: Decimal;

  @Column({ type: 'varchar', length: 100, name: 'discount_reason', nullable: true })
  discountReason!: string | null;

  @MoneyColumn({ name: 'monthly_total' })
  monthlyTotal!: Decimal;

  @Column({ type: 'varchar', length: 3, default: 'USD' })
  currency!: string;

  @Column({ type: 'enum', enum: BILLING_CUSTOM_PLAN_STATUSES, default: 'draft' })
  status!: BillingCustomPlanStatus;

  @Column({ type: 'date', name: 'valid_from' })
  validFrom!: string;

  /** `null` means the plan does not expire. */
  @Column({ type: 'date', name: 'valid_to', nullable: true })
  validTo!: string | null;

  @Column({ type: 'uuid', name: 'approved_by', nullable: true })
  approvedBy!: string | null;

  @Column({ type: 'timestamptz', name: 'approved_at', nullable: true })
  approvedAt!: Date | null;

  @Column({ type: 'text', name: 'rejection_reason', nullable: true })
  rejectionReason!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  /** The subscription this plan was activated into, once it has been. */
  @Column({ type: 'uuid', name: 'subscription_id', nullable: true })
  subscriptionId!: string | null;

  /**
   * Module codes the plan selected that carried no active price sheet when it
   * was priced. An absent sheet is not an error — a core module legitimately
   * has none — but a total that silently omits a module the operator chose is,
   * so the plan records which ones contributed nothing.
   */
  @Column({ type: 'jsonb', name: 'unpriced_module_codes', default: () => "'[]'::jsonb" })
  unpricedModuleCodes!: string[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'uuid', name: 'created_by', nullable: true })
  createdBy!: string | null;

  @Column({ type: 'uuid', name: 'updated_by', nullable: true })
  updatedBy!: string | null;
}

@Entity('custom_plan_modules', { schema: 'billing' })
@Unique(['customPlanId', 'moduleId'])
@Index(['customPlanId'])
export class CustomPlanModule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'custom_plan_id' })
  customPlanId!: string;

  @ManyToOne(() => CustomPlan, (plan) => plan.modules, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'custom_plan_id' })
  customPlan?: CustomPlan;

  @Column({ type: 'uuid', name: 'module_id' })
  moduleId!: string;

  @Column({ type: 'varchar', length: 100, name: 'module_code' })
  moduleCode!: string;

  @Column({ type: 'varchar', length: 255, name: 'module_name' })
  moduleName!: string;

  /** Counts only. No CHECK a numeric column would give applies to them. */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  quantities!: CustomPlanQuantities;

  @OneToMany('CustomPlanLineItem', 'module', { cascade: false })
  lineItems?: CustomPlanLineItem[];

  @MoneyColumn({ default: 0 })
  subtotal!: Decimal;
}

@Entity('custom_plan_line_items', { schema: 'billing' })
@Index(['customPlanModuleId'])
export class CustomPlanLineItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'custom_plan_module_id' })
  customPlanModuleId!: string;

  @ManyToOne(() => CustomPlanModule, (module) => module.lineItems, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'custom_plan_module_id' })
  module?: CustomPlanModule;

  @Column({ type: 'varchar', length: 64 })
  metric!: BillingPricingMetricType;

  @Column({ type: 'varchar', length: 255, name: 'metric_label' })
  metricLabel!: string;

  @Column({ type: 'integer' })
  quantity!: number;

  @MoneyColumn({ name: 'unit_price' })
  unitPrice!: Decimal;

  @MoneyColumn()
  total!: Decimal;
}
