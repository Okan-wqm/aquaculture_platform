import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
  OneToMany,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import { ObjectType, Field, ID, registerEnumType, Float, Int } from '@nestjs/graphql';
import { MoneyColumn } from '@aquaculture/backend-common/monetary';
import Decimal from 'decimal.js';
import { BillingCycle, PlanTier, PlanLimits, PlanPricing } from './subscription.entity';

// Type-only: erased at runtime, so the OneToMany relations below (declared by
// string name for the same reason) create no import cycle with the child rows.
import type { PlanAddOn as PlanAddOnRow, PlanCyclePrice as PlanCyclePriceRow } from './plan-catalog.entity';

/**
 * Whether a plan is offered, hidden, or retired from sale (ADR-0013). Moved
 * from `admin.plan_definitions` with the rest of the catalogue; a deprecated
 * plan stays resolvable because live subscriptions reference it.
 */
export enum PlanVisibility {
  PUBLIC = 'public',
  PRIVATE = 'private',
  DEPRECATED = 'deprecated',
}

registerEnumType(PlanVisibility, { name: 'PlanVisibility' });

/**
 * The named feature sets a plan advertises. Priced extras are NOT here —
 * `admin.plan_definitions.features.addOns[].price` was money nested two levels
 * inside a jsonb blob, and is now `billing.plan_add_ons` rows.
 */
@ObjectType()
export class PlanFeatures {
  @Field(() => [String])
  coreFeatures!: string[];

  @Field(() => [String])
  advancedFeatures!: string[];

  @Field(() => [String])
  premiumFeatures!: string[];
}

/**
 * Plan Entity
 *
 * Defines subscription plan templates that tenants can subscribe to.
 * Plans are versioned and auditable. Price changes on a plan do NOT
 * affect existing subscriptions — only new subscriptions use the
 * current plan pricing.
 */
@ObjectType()
@Entity('plans', { schema: 'billing' })
@Index(['tier'])
@Index(['isActive'])
@Index(['isPublic'])
@Index(['sortOrder'])
@Index(['name'], { unique: true })
export class Plan {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Field(() => PlanTier)
  @Column({ type: 'enum', enum: PlanTier })
  tier!: PlanTier;

  // ADR-0004 / PLAT-LOW-002: basePriceDecimal (Decimal scalar, exact string) is
  // the exact-precision wire representation; this Float field is retained during
  // the additive-coexistence window and removed once all readers migrate.
  @Field(() => Float, {
    deprecationReason: 'Use basePriceDecimal (exact decimal string, ADR-0004).',
  })
  @MoneyColumn({ name: 'base_price' })
  basePrice!: Decimal;

  @Field()
  @Column({ type: 'varchar', length: 3, default: 'USD' })
  currency!: string;

  @Field(() => BillingCycle)
  @Column({ type: 'enum', enum: BillingCycle, name: 'billing_cycle', default: BillingCycle.MONTHLY })
  billingCycle!: BillingCycle;

  @Field(() => PlanLimits)
  @Column('jsonb')
  limits!: PlanLimits;

  @Field(() => PlanPricing)
  @Column('jsonb')
  pricing!: PlanPricing;

  // W1.1 (ADR-016 / BILLING-CRITICAL-001): denormalized Stripe identifiers so
  // create-subscription can resolve a real Stripe price WITHOUT a cross-service
  // hot-path call to admin.plan_definitions (billing is the subscription SSoT,
  // D14). Not exposed via GraphQL — internal billing config. Nullable: plans
  // created before Stripe go-live (or non-billable plans) carry none, and the
  // money handlers fail-closed when a price is required but absent.
  @Column({ type: 'varchar', length: 255, nullable: true, name: 'stripe_product_id' })
  stripeProductId?: string | null;

  // Map of billing cycle (e.g. 'monthly'/'yearly') → Stripe price id.
  @Column({ type: 'jsonb', nullable: true, name: 'stripe_price_ids' })
  stripePriceIds?: Record<string, string> | null;

  /**
   * The named feature sets a plan advertises. ADR-0013 widened this from a
   * flat `string[]` when `admin.plan_definitions` merged in, because that
   * catalogue grouped them. Names and flags only — the priced half (add-ons)
   * became `billing.plan_add_ons` rows, so no money lives in this blob.
   */
  @Field(() => PlanFeatures)
  @Column('jsonb', {
    default: () => `'{"coreFeatures":[],"advancedFeatures":[],"premiumFeatures":[]}'::jsonb`,
  })
  features!: PlanFeatures;

  // ── Catalogue presentation and lifecycle (ADR-0013) ──────────────────────
  //
  // These moved off `admin.plan_definitions`, whose ids never resolved at
  // execution: every runtime path reads `billing.plans`, so the operator-facing
  // copy of a plan was authored somewhere nothing consulted.

  /** Operator-facing catalogue key, e.g. `starter_2024`. Unique when set. */
  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 100, nullable: true, unique: true })
  code?: string | null;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true, name: 'short_description' })
  shortDescription?: string | null;

  @Field(() => PlanVisibility)
  @Column({
    type: 'enum',
    enum: PlanVisibility,
    default: PlanVisibility.PUBLIC,
  })
  visibility!: PlanVisibility;

  @Field()
  @Column({ type: 'boolean', default: false, name: 'is_recommended' })
  isRecommended!: boolean;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true, name: 'trial_days' })
  trialDays?: number | null;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true, name: 'grace_period_days' })
  gracePeriodDays?: number | null;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true, name: 'upgrade_message' })
  upgradeMessage?: string | null;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true, name: 'downgrade_warning' })
  downgradeWarning?: string | null;

  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 64, nullable: true })
  icon?: string | null;

  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 32, nullable: true })
  color?: string | null;

  /** e.g. 'Best Value', 'Most Popular'. */
  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 64, nullable: true })
  badge?: string | null;

  /**
   * What the plan costs per cycle. ADR-0013: one row per cycle, in `numeric`
   * columns — the shape `admin.plan_definitions.pricing` held as jsonb where
   * no CHECK could reach a negative price or a 400% discount.
   */
  // Not a GraphQL field: the per-cycle matrix is operator-facing catalogue
  // detail served over the admin REST contract, and exposing it here would
  // need the child entity as a runtime value — the very import cycle the
  // string-named relation avoids.
  @OneToMany('PlanCyclePrice', 'plan', { cascade: ['insert'], eager: true })
  cyclePrices!: PlanCyclePriceRow[];

  /** Priced extras. Rows for the same reason: `features.addOns[].price` was money in jsonb. */
  /** Not a GraphQL field, for the same reason as `cyclePrices`. */
  @OneToMany('PlanAddOn', 'plan', { cascade: ['insert'], eager: true })
  addOns!: PlanAddOnRow[];

  @Field()
  @Column({ default: true, name: 'is_active' })
  isActive!: boolean;

  @Field()
  @Column({ default: true, name: 'is_public' })
  isPublic!: boolean;

  @Field(() => Int)
  @Column({ type: 'int', default: 0, name: 'sort_order' })
  sortOrder!: number;

  @Field()
  @CreateDateColumn()
  createdAt!: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt!: Date;

  @Field({ nullable: true })
  @Column({ nullable: true, name: 'created_by' })
  createdBy?: string;

  @Field({ nullable: true })
  @Column({ nullable: true, name: 'updated_by' })
  updatedBy?: string;

  @Field(() => Int)
  @VersionColumn()
  version!: number;

  // Soft-delete: plan templates must not be physically deleted because existing subscriptions
  // reference them. Hard-deleting a plan would orphan all active subscriptions on that plan.
  // BEFORE: no soft-delete — plan records could be permanently removed, breaking subscription references.
  //
  // IMPORTANT: Uses partial index WHERE is_deleted = false instead of a standard B-tree index.
  // For highly skewed boolean columns (99% false), a partial index is far more efficient:
  // - Smaller index size (only indexes active plans, not the entire table)
  // - Faster index scans for the common query pattern (WHERE is_deleted = false)
  // @see DB-MEDIUM-008
  @Field()
  @Column({ default: false, name: 'is_deleted' })
  @Index('idx_plan_is_deleted_partial', { where: '"is_deleted" = false' })
  isDeleted: boolean = false;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true, name: 'deleted_at' })
  deletedAt?: Date;

  @Column({ nullable: true, name: 'deleted_by' })
  deletedBy?: string;

  softDelete(deletedBy?: string): void {
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.deletedBy = deletedBy;
  }

  /**
   * Normalize plan name before save
   */
  @BeforeInsert()
  @BeforeUpdate()
  sanitize(): void {
    if (this.name) {
      this.name = this.name.trim();
    }
  }
}
