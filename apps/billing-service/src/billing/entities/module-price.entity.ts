/**
 * The module price sheet — billing owns what a module costs (ADR-0013,
 * BILLING-CRITICAL-002).
 *
 * `admin.module_pricing` kept `pricingMetrics` and `tierMultipliers` as two
 * `jsonb` columns of `number`s. Nothing could CHECK a negative price or a tier
 * multiplier of 40, a duplicate metric was representable, no index could reach
 * a price, and every arithmetic step went through IEEE-754. Here a sheet is a
 * row, each metric is a row and each tier multiplier is a row, so the database
 * states the constraints and `Decimal` carries the values.
 *
 * A sheet is effective-dated and versioned: `setModulePrice` closes the
 * previous window rather than editing it, so an invoice can always be read
 * back against the prices that produced it.
 */
import { MoneyColumn } from '@aquaculture/backend-common/monetary';
import type { BillingPlanTier, BillingPricingMetricType } from '@platform/event-contracts';
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

/**
 * A tier multiplier is a rate, not money: `numeric(6,4)` in (0, 10] cannot
 * hold the nonsense a `numeric(19,4)` money column would accept.
 */
const RATE_TRANSFORMER = {
  to: (value: Decimal | null | undefined): string | null =>
    value === null || value === undefined ? null : value.toString(),
  from: (value: string | null | undefined): Decimal | null =>
    value === null || value === undefined ? null : new Decimal(value),
};

@Entity('module_prices', { schema: 'billing' })
@Index(['moduleId'])
@Index(['moduleCode'])
@Index(['isActive'])
@Index(['effectiveFrom'])
@Unique(['moduleId', 'effectiveFrom'])
export class ModulePrice {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** `auth.modules.id`. billing holds no grant on that schema, so no FK. */
  @Column({ type: 'uuid', name: 'module_id' })
  moduleId!: string;

  /** Denormalised from `auth.modules.code` — the key every quote arrives with. */
  @Column({ type: 'varchar', length: 50, name: 'module_code' })
  moduleCode!: string;

  /** ISO-4217, upper-case. Denominates every metric price on this sheet. */
  @Column({ type: 'varchar', length: 3, default: 'USD' })
  currency!: string;

  @Column({ type: 'timestamptz', name: 'effective_from', default: () => 'now()' })
  effectiveFrom!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'effective_to' })
  effectiveTo!: Date | null;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive!: boolean;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'int', default: 1 })
  version!: number;

  @OneToMany(() => ModulePriceMetric, (metric) => metric.modulePrice, {
    cascade: ['insert'],
    eager: true,
  })
  metrics!: ModulePriceMetric[];

  @OneToMany(() => ModulePriceTierMultiplier, (multiplier) => multiplier.modulePrice, {
    cascade: ['insert'],
    eager: true,
  })
  tierMultipliers!: ModulePriceTierMultiplier[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ type: 'uuid', nullable: true, name: 'created_by' })
  createdBy!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'updated_by' })
  updatedBy!: string | null;
}

@Entity('module_price_metrics', { schema: 'billing' })
@Unique(['modulePriceId', 'metricType'])
export class ModulePriceMetric {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'module_price_id' })
  modulePriceId!: string;

  @ManyToOne(() => ModulePrice, (price) => price.metrics, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'module_price_id' })
  // Optional because TypeORM only populates the back-reference when the
  // relation is loaded; the arithmetic reads the sheet, never the child's
  // pointer back to it.
  modulePrice?: ModulePrice;

  @Column({ type: 'varchar', length: 32, name: 'metric_type' })
  metricType!: BillingPricingMetricType;

  @MoneyColumn()
  price!: Decimal;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'int', nullable: true, name: 'min_quantity' })
  minQuantity!: number | null;

  @Column({ type: 'int', nullable: true, name: 'max_quantity' })
  maxQuantity!: number | null;

  /** Quantity granted before the metric starts charging. */
  @Column({ type: 'int', nullable: true, name: 'included_quantity' })
  includedQuantity!: number | null;
}

@Entity('module_price_tier_multipliers', { schema: 'billing' })
@Unique(['modulePriceId', 'tier'])
export class ModulePriceTierMultiplier {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'module_price_id' })
  modulePriceId!: string;

  @ManyToOne(() => ModulePrice, (price) => price.tierMultipliers, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'module_price_id' })
  // Optional because TypeORM only populates the back-reference when the
  // relation is loaded; the arithmetic reads the sheet, never the child's
  // pointer back to it.
  modulePrice?: ModulePrice;

  @Column({ type: 'varchar', length: 32 })
  tier!: BillingPlanTier;

  /** 1 is full price, 0.9 a 10% tier discount. Bounded by a CHECK, not by hope. */
  @Column({
    type: 'numeric',
    precision: 6,
    scale: 4,
    transformer: RATE_TRANSFORMER,
  })
  multiplier!: Decimal;
}
