/**
 * Read-only mapping of the module price sheet billing owns (ADR-0013,
 * BILLING-CRITICAL-002).
 *
 * admin-api renders the ModulePricing page from these rows and authors them
 * through `request.billing.admin.setModulePrice`; it never writes them.
 * `synchronize: false` keeps admin's schema synchroniser out of a table it
 * does not own — the contract `apps/admin-api-service/CLAUDE.md` states and
 * `admin-api-schema-boundaries.spec.ts` enforces.
 */
import { MoneyColumn } from '@aquaculture/backend-common/monetary';
import type { BillingPlanTier, BillingPricingMetricType } from '@platform/event-contracts';
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
} from 'typeorm';

const RATE_TRANSFORMER = {
  to: (value: Decimal | null | undefined): string | null =>
    value === null || value === undefined ? null : value.toString(),
  from: (value: string | null | undefined): Decimal | null =>
    value === null || value === undefined ? null : new Decimal(value),
};

@Entity('module_prices', { schema: 'billing', synchronize: false })
export class ModulePriceReadOnly {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'module_id' })
  moduleId!: string;

  @Column({ type: 'varchar', length: 50, name: 'module_code' })
  moduleCode!: string;

  @Column({ type: 'varchar', length: 3 })
  currency!: string;

  @Column({ type: 'timestamptz', name: 'effective_from' })
  effectiveFrom!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'effective_to' })
  effectiveTo!: Date | null;

  @Column({ type: 'boolean', name: 'is_active' })
  isActive!: boolean;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'int' })
  version!: number;

  @OneToMany(() => ModulePriceMetricReadOnly, (metric) => metric.modulePrice, { eager: true })
  metrics!: ModulePriceMetricReadOnly[];

  @OneToMany(() => ModulePriceTierMultiplierReadOnly, (entry) => entry.modulePrice, {
    eager: true,
  })
  tierMultipliers!: ModulePriceTierMultiplierReadOnly[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ type: 'uuid', nullable: true, name: 'created_by' })
  createdBy!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'updated_by' })
  updatedBy!: string | null;
}

@Entity('module_price_metrics', { schema: 'billing', synchronize: false })
export class ModulePriceMetricReadOnly {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'module_price_id' })
  modulePriceId!: string;

  @ManyToOne(() => ModulePriceReadOnly, (price) => price.metrics)
  @JoinColumn({ name: 'module_price_id' })
  // Optional because TypeORM only populates the back-reference when the
  // relation is loaded; the arithmetic reads the sheet, never the child's
  // pointer back to it.
  modulePrice?: ModulePriceReadOnly;

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

  @Column({ type: 'int', nullable: true, name: 'included_quantity' })
  includedQuantity!: number | null;
}

@Entity('module_price_tier_multipliers', { schema: 'billing', synchronize: false })
export class ModulePriceTierMultiplierReadOnly {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'module_price_id' })
  modulePriceId!: string;

  @ManyToOne(() => ModulePriceReadOnly, (price) => price.tierMultipliers)
  @JoinColumn({ name: 'module_price_id' })
  // Optional because TypeORM only populates the back-reference when the
  // relation is loaded; the arithmetic reads the sheet, never the child's
  // pointer back to it.
  modulePrice?: ModulePriceReadOnly;

  @Column({ type: 'varchar', length: 32 })
  tier!: BillingPlanTier;

  @Column({ type: 'numeric', precision: 6, scale: 4, transformer: RATE_TRANSFORMER })
  multiplier!: Decimal;
}
