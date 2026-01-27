import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { ObjectType, Field, ID, Float, registerEnumType } from '@nestjs/graphql';
import { forwardRef } from '@nestjs/common';

/**
 * Status of a module within a subscription
 */
export enum SubscriptionModuleStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  CANCELLED = 'cancelled',
  UPGRADED = 'upgraded',
  DOWNGRADED = 'downgraded',
}

registerEnumType(SubscriptionModuleStatus, { name: 'SubscriptionModuleStatus' });

/**
 * Quantity configuration for a module
 */
@ObjectType()
export class ModuleQuantities {
  @Field(() => Number, { nullable: true })
  users?: number;

  @Field(() => Number, { nullable: true })
  farms?: number;

  @Field(() => Number, { nullable: true })
  ponds?: number;

  @Field(() => Number, { nullable: true })
  sensors?: number;

  @Field(() => Number, { nullable: true })
  devices?: number;

  @Field(() => Number, { nullable: true })
  storageGb?: number;

  @Field(() => Number, { nullable: true })
  apiCalls?: number;

  @Field(() => Number, { nullable: true })
  alerts?: number;

  @Field(() => Number, { nullable: true })
  reports?: number;

  @Field(() => Number, { nullable: true })
  integrations?: number;
}

/**
 * Individual line item for module pricing
 */
@ObjectType()
export class ModuleLineItem {
  @Field()
  metric!: string;

  @Field()
  description!: string;

  @Field(() => Float)
  quantity!: number;

  @Field(() => Float)
  unitPrice!: number;

  @Field(() => Float)
  total!: number;

  @Field(() => Float, { nullable: true })
  includedQuantity?: number;

  @Field(() => Float, { nullable: true })
  overageQuantity?: number;
}

/**
 * Subscription Module Item Entity
 *
 * Links modules to subscriptions with pricing breakdown.
 * Each tenant subscription can have multiple modules with their own
 * quantities and pricing.
 *
 * Example:
 * Subscription for Tenant X includes:
 * - IoT Sensors Module
 *   - Users: 15 ($150)
 *   - Sensors: 100 ($200)
 *   - Storage: 50GB ($5)
 *   - Subtotal: $355
 */
@ObjectType()
@Entity('subscription_module_items')
@Index(['subscriptionId'])
@Index(['moduleId'])
@Index(['status'])
@Unique(['subscriptionId', 'moduleId'])
export class SubscriptionModuleItem {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Parent subscription
   */
  @Field()
  @Column('uuid')
  subscriptionId!: string;

  @ManyToOne(
    () => require('./subscription.entity').Subscription,
    (sub: { moduleItems: unknown }) => sub.moduleItems,
    { onDelete: 'CASCADE' },
  )
  @JoinColumn({ name: 'subscription_id' })
  subscription!: import('./subscription.entity').Subscription;

  /**
   * Reference to system module
   */
  @Field()
  @Column('uuid')
  moduleId!: string;

  /**
   * Module code for convenience
   */
  @Field()
  @Column({ type: 'varchar', length: 50 })
  moduleCode!: string;

  /**
   * Module name for display
   */
  @Field()
  @Column({ type: 'varchar', length: 100 })
  moduleName!: string;

  /**
   * Configured quantities for this module
   */
  @Field(() => ModuleQuantities)
  @Column('jsonb', { default: {} })
  quantities!: ModuleQuantities;

  /**
   * Pricing breakdown by metric
   */
  @Field(() => [ModuleLineItem])
  @Column('jsonb', { default: [] })
  lineItems!: ModuleLineItem[];

  /**
   * Subtotal before discounts
   */
  @Field(() => Float)
  @Column('decimal', { precision: 12, scale: 2 })
  subtotal!: number;

  /**
   * Module-specific discount
   */
  @Field(() => Float)
  @Column('decimal', { precision: 12, scale: 2, default: 0 })
  discountAmount!: number;

  /**
   * Final total for this module
   */
  @Field(() => Float)
  @Column('decimal', { precision: 12, scale: 2 })
  total!: number;

  /**
   * Currency
   */
  @Field()
  @Column({ type: 'varchar', length: 3, default: 'USD' })
  currency!: string;

  /**
   * Current status
   */
  @Field(() => SubscriptionModuleStatus)
  @Column({
    type: 'enum',
    enum: SubscriptionModuleStatus,
    default: SubscriptionModuleStatus.ACTIVE,
  })
  status!: SubscriptionModuleStatus;

  /**
   * When this module was added to subscription
   */
  @Field(() => Date)
  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  activatedAt!: Date;

  /**
   * When this module was cancelled/removed
   */
  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  /**
   * Custom configuration for this module
   */
  @Column('jsonb', { nullable: true })
  configuration!: Record<string, unknown> | null;

  /**
   * Notes about this module assignment
   */
  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Field(() => Date)
  @CreateDateColumn()
  createdAt!: Date;

  @Field(() => Date)
  @UpdateDateColumn()
  updatedAt!: Date;

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Get quantity for a specific metric
   */
  getQuantity(metric: keyof ModuleQuantities): number {
    return this.quantities[metric] ?? 0;
  }

  /**
   * Get line item for a specific metric
   */
  getLineItem(metric: string): ModuleLineItem | undefined {
    return this.lineItems.find((li) => li.metric === metric);
  }

  /**
   * Check if module is currently active
   */
  isActive(): boolean {
    return this.status === SubscriptionModuleStatus.ACTIVE;
  }

  /**
   * Calculate total from line items
   */
  calculateTotal(): number {
    return this.lineItems.reduce((sum, li) => sum + li.total, 0);
  }
}
