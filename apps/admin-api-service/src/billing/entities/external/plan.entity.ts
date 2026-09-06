/**
 * Read-only mapping of the plan catalogue billing owns (ADR-0013,
 * BILLING-CRITICAL-002).
 *
 * `admin.plan_definitions` was a second catalogue with its own ids, its own
 * Stripe identifiers and a per-cycle price matrix in `jsonb`; nothing at
 * runtime ever resolved it. admin-api renders and authors `billing.plans`
 * now — authoring through `request.billing.admin.*Plan`, reading through this
 * mapping. `synchronize: false` keeps admin's schema synchroniser out of a
 * table it does not own.
 */
import { MoneyColumn } from '@aquaculture/backend-common/monetary';
import type {
  BillingCycle,
  BillingPlanFeaturesInput,
  BillingPlanLimitsInput,
  BillingPlanTier,
  BillingPlanVisibility,
} from '@platform/event-contracts';
import Decimal from 'decimal.js';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

const PERCENT_TRANSFORMER = {
  to: (value: Decimal | null | undefined): string | null =>
    value === null || value === undefined ? null : value.toString(),
  from: (value: string | null | undefined): Decimal | null =>
    value === null || value === undefined ? null : new Decimal(value),
};

@Entity('plans', { schema: 'billing', synchronize: false })
export class PlanReadOnly {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  code!: string | null;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'text', nullable: true, name: 'short_description' })
  shortDescription!: string | null;

  @Column({ type: 'varchar' })
  tier!: BillingPlanTier;

  @Column({ type: 'varchar', length: 3 })
  currency!: string;

  /** The cycle a subscription defaults to when none is stated. */
  @Column({ type: 'varchar', name: 'billing_cycle' })
  billingCycle!: BillingCycle;

  @Column({ type: 'varchar' })
  visibility!: BillingPlanVisibility;

  @Column({ type: 'boolean', name: 'is_active' })
  isActive!: boolean;

  @Column({ type: 'boolean', name: 'is_public' })
  isPublic!: boolean;

  @Column({ type: 'boolean', name: 'is_recommended' })
  isRecommended!: boolean;

  @Column({ type: 'int', name: 'sort_order' })
  sortOrder!: number;

  @Column({ type: 'jsonb' })
  limits!: BillingPlanLimitsInput;

  @Column({ type: 'jsonb' })
  features!: BillingPlanFeaturesInput;

  @Column({ type: 'int', nullable: true, name: 'trial_days' })
  trialDays!: number | null;

  @Column({ type: 'int', nullable: true, name: 'grace_period_days' })
  gracePeriodDays!: number | null;

  @Column({ type: 'text', nullable: true, name: 'upgrade_message' })
  upgradeMessage!: string | null;

  @Column({ type: 'text', nullable: true, name: 'downgrade_warning' })
  downgradeWarning!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  icon!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  color!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  badge!: string | null;

  /** The ONE writable home for these; admin only reads them (ADR-0013). */
  @Column({ type: 'varchar', length: 255, nullable: true, name: 'stripe_product_id' })
  stripeProductId!: string | null;

  @Column({ type: 'jsonb', nullable: true, name: 'stripe_price_ids' })
  stripePriceIds!: Record<string, string> | null;

  @OneToMany(() => PlanCyclePriceReadOnly, (price) => price.plan, { eager: true })
  cyclePrices!: PlanCyclePriceReadOnly[];

  @OneToMany(() => PlanAddOnReadOnly, (addOn) => addOn.plan, { eager: true })
  addOns!: PlanAddOnReadOnly[];

  @Column({ type: 'boolean', name: 'is_deleted' })
  isDeleted!: boolean;

  @VersionColumn()
  version!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ type: 'varchar', nullable: true, name: 'created_by' })
  createdBy!: string | null;

  @Column({ type: 'varchar', nullable: true, name: 'updated_by' })
  updatedBy!: string | null;
}

@Entity('plan_cycle_prices', { schema: 'billing', synchronize: false })
export class PlanCyclePriceReadOnly {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'plan_id' })
  planId!: string;

  @ManyToOne(() => PlanReadOnly, (plan) => plan.cyclePrices)
  @JoinColumn({ name: 'plan_id' })
  plan?: PlanReadOnly;

  @Column({ type: 'varchar', name: 'billing_cycle' })
  billingCycle!: BillingCycle;

  @MoneyColumn({ name: 'base_price' })
  basePrice!: Decimal;

  @MoneyColumn({ name: 'per_user_price' })
  perUserPrice!: Decimal;

  @MoneyColumn({ name: 'per_farm_price' })
  perFarmPrice!: Decimal;

  @MoneyColumn({ name: 'per_module_price' })
  perModulePrice!: Decimal;

  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    name: 'discount_percent',
    transformer: PERCENT_TRANSFORMER,
  })
  discountPercent!: Decimal;
}

@Entity('plan_add_ons', { schema: 'billing', synchronize: false })
export class PlanAddOnReadOnly {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'plan_id' })
  planId!: string;

  @ManyToOne(() => PlanReadOnly, (plan) => plan.addOns)
  @JoinColumn({ name: 'plan_id' })
  plan?: PlanReadOnly;

  @Column({ type: 'varchar', length: 100 })
  code!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @MoneyColumn()
  price!: Decimal;

  @Column({ type: 'varchar', name: 'billing_cycle' })
  billingCycle!: BillingCycle;
}
