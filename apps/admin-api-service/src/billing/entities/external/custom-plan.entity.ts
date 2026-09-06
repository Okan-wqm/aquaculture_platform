/**
 * Read-only mapping of the custom plans billing owns (ADR-0013,
 * BILLING-CRITICAL-002).
 *
 * `admin.custom_plans` priced a negotiated plan in admin, in floats, and kept
 * every per-module and per-line amount inside one `jsonb` column. billing owns
 * the price sheet and the arithmetic, so it owns the plan: admin-api renders
 * and authors through `request.billing.admin.*CustomPlan` and reads the rows
 * back here. `synchronize: false` keeps admin's schema synchroniser out of a
 * table it does not own.
 */
import { MoneyColumn } from '@aquaculture/backend-common/monetary';
import type {
  BillingCustomPlanStatus,
  BillingCycle,
  BillingModuleQuantities,
  BillingPlanTier,
  BillingPricingMetricType,
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
} from 'typeorm';

const PERCENT_TRANSFORMER = {
  to: (value: Decimal | null | undefined): string | null =>
    value === null || value === undefined ? null : value.toString(),
  from: (value: string | null | undefined): Decimal | null =>
    value === null || value === undefined ? null : new Decimal(value),
};

@Entity('custom_plans', { schema: 'billing', synchronize: false })
export class CustomPlanReadOnly {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'uuid', name: 'base_plan_id', nullable: true })
  basePlanId!: string | null;

  @Column({ type: 'varchar' })
  tier!: BillingPlanTier;

  @Column({ type: 'varchar', name: 'billing_cycle' })
  billingCycle!: BillingCycle;

  @OneToMany(() => CustomPlanModuleReadOnly, (module) => module.customPlan)
  modules?: CustomPlanModuleReadOnly[];

  @MoneyColumn({ name: 'monthly_subtotal' })
  monthlySubtotal!: Decimal;

  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    name: 'discount_percent',
    transformer: PERCENT_TRANSFORMER,
  })
  discountPercent!: Decimal;

  @MoneyColumn({ name: 'discount_amount' })
  discountAmount!: Decimal;

  @Column({ type: 'varchar', length: 100, name: 'discount_reason', nullable: true })
  discountReason!: string | null;

  @MoneyColumn({ name: 'monthly_total' })
  monthlyTotal!: Decimal;

  @Column({ type: 'varchar', length: 3 })
  currency!: string;

  @Column({ type: 'varchar' })
  status!: BillingCustomPlanStatus;

  @Column({ type: 'date', name: 'valid_from' })
  validFrom!: string;

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

  @Column({ type: 'uuid', name: 'subscription_id', nullable: true })
  subscriptionId!: string | null;

  @Column({ type: 'jsonb', name: 'unpriced_module_codes' })
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

@Entity('custom_plan_modules', { schema: 'billing', synchronize: false })
export class CustomPlanModuleReadOnly {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'custom_plan_id' })
  customPlanId!: string;

  @ManyToOne(() => CustomPlanReadOnly, (plan) => plan.modules)
  @JoinColumn({ name: 'custom_plan_id' })
  customPlan?: CustomPlanReadOnly;

  @Column({ type: 'uuid', name: 'module_id' })
  moduleId!: string;

  @Column({ type: 'varchar', length: 100, name: 'module_code' })
  moduleCode!: string;

  @Column({ type: 'varchar', length: 255, name: 'module_name' })
  moduleName!: string;

  @Column({ type: 'jsonb' })
  quantities!: Omit<BillingModuleQuantities, 'moduleId'>;

  @OneToMany(() => CustomPlanLineItemReadOnly, (line) => line.module)
  lineItems?: CustomPlanLineItemReadOnly[];

  @MoneyColumn()
  subtotal!: Decimal;
}

@Entity('custom_plan_line_items', { schema: 'billing', synchronize: false })
export class CustomPlanLineItemReadOnly {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'custom_plan_module_id' })
  customPlanModuleId!: string;

  @ManyToOne(() => CustomPlanModuleReadOnly, (module) => module.lineItems)
  @JoinColumn({ name: 'custom_plan_module_id' })
  module?: CustomPlanModuleReadOnly;

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
