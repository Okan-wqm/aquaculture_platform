/**
 * The rest of the plan catalogue — per-cycle prices and add-ons (ADR-0013,
 * BILLING-CRITICAL-002).
 *
 * `admin.plan_definitions` held both inside `jsonb`: `pricing` was an object
 * of four per-cycle sub-objects and `features.addOns` an array of priced
 * items. Nothing could CHECK a negative price or a `discountPercent` of 400,
 * a cycle could be priced twice, and every value was an IEEE-754 double
 * because a jsonb number is one.
 *
 * `Plan` itself keeps its `limits` and `features` blobs: those are counts,
 * flags and names, and no CHECK a numeric column would give applies to them.
 * Only the money moved out.
 */
import { MoneyColumn, DecimalValueTransformer } from '@aquaculture/backend-common/monetary';
import Decimal from 'decimal.js';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { Plan } from './plan.entity';
import { BillingCycle } from './subscription.entity';

/**
 * A rate, not money — but the DEFAULT rule is the same one money columns need.
 *
 * The local copy these entities carried collapsed `undefined` into `null`, so a
 * rate the caller did not name was written as an explicit NULL instead of being
 * left out of the INSERT for its `DEFAULT 0` to apply. `DecimalValueTransformer`
 * is the platform's one implementation of that rule and passes `undefined`
 * through, which is what makes `default: 0` mean anything.
 */
const RATE_TRANSFORMER = new DecimalValueTransformer();

@Entity('plan_cycle_prices', { schema: 'billing' })
@Unique(['planId', 'billingCycle'])
@Index(['planId'])
export class PlanCyclePrice {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'plan_id' })
  planId!: string;

  @ManyToOne(() => Plan, (plan) => plan.cyclePrices, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'plan_id' })
  // Optional because TypeORM only populates the back-reference when the
  // relation is loaded; nothing here reads the child's pointer to its parent.
  plan?: Plan;

  @Column({ type: 'enum', enum: BillingCycle, name: 'billing_cycle' })
  billingCycle!: BillingCycle;

  @MoneyColumn({ name: 'base_price' })
  basePrice!: Decimal;

  @MoneyColumn({ name: 'per_user_price' })
  perUserPrice!: Decimal;

  @MoneyColumn({ name: 'per_farm_price' })
  perFarmPrice!: Decimal;

  @MoneyColumn({ name: 'per_module_price' })
  perModulePrice!: Decimal;

  /** The commitment discount for this cycle, in [0, 100]. */
  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: 0,
    name: 'discount_percent',
    transformer: RATE_TRANSFORMER,
  })
  discountPercent!: Decimal;
}

@Entity('plan_add_ons', { schema: 'billing' })
@Unique(['planId', 'code'])
@Index(['planId'])
export class PlanAddOn {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'plan_id' })
  planId!: string;

  @ManyToOne(() => Plan, (plan) => plan.addOns, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'plan_id' })
  plan?: Plan;

  @Column({ type: 'varchar', length: 100 })
  code!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @MoneyColumn()
  price!: Decimal;

  @Column({ type: 'enum', enum: BillingCycle, name: 'billing_cycle' })
  billingCycle!: BillingCycle;
}
