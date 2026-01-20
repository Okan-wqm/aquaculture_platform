import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from 'typeorm';
import { PricingMetricType } from './pricing-metric.enum';
import { PlanTier } from './plan-definition.entity';

/**
 * Individual pricing metric configuration
 */
export interface PricingMetric {
  type: PricingMetricType;
  price: number;
  currency: string;
  description?: string;
  minQuantity?: number;    // Minimum quantity (e.g., at least 1 user)
  maxQuantity?: number;    // Maximum quantity (for tier limits)
  includedQuantity?: number; // Free included amount
}

/**
 * Tier-based price multipliers
 * Allows discounts for higher tiers
 */
export interface TierMultipliers {
  [PlanTier.FREE]?: number;
  [PlanTier.STARTER]?: number;
  [PlanTier.PROFESSIONAL]?: number;
  [PlanTier.ENTERPRISE]?: number;
  [PlanTier.CUSTOM]?: number;
}

/**
 * Module Pricing Entity
 *
 * Defines pricing configuration for each system module.
 * Supports multiple pricing metrics per module and tier-based discounts.
 *
 * Example:
 * {
 *   moduleId: "uuid-for-iot-sensors",
 *   pricingMetrics: [
 *     { type: "base_price", price: 75, currency: "USD" },
 *     { type: "per_user", price: 10, currency: "USD" },
 *     { type: "per_sensor", price: 2, currency: "USD", includedQuantity: 5 }
 *   ],
 *   tierMultipliers: { starter: 1.0, professional: 0.9, enterprise: 0.7 }
 * }
 */
@Entity('module_pricing', { schema: 'public', synchronize: false })
@Index(['moduleId'])
@Index(['isActive'])
@Index(['effectiveFrom'])
@Unique(['moduleId', 'effectiveFrom'])
export class ModulePricing {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Reference to system module (system_modules.id)
   */
  @Column('uuid')
  moduleId!: string;

  /**
   * Module code for convenience (denormalized)
   */
  @Column({ type: 'varchar', length: 50 })
  moduleCode!: string;

  /**
   * Array of pricing metrics for this module
   */
  @Column('jsonb', { default: [] })
  pricingMetrics!: PricingMetric[];

  /**
   * Tier-based price multipliers
   * 1.0 = full price, 0.9 = 10% discount, etc.
   */
  @Column('jsonb', { default: {} })
  tierMultipliers!: TierMultipliers;

  /**
   * Default currency for this module's pricing
   */
  @Column({ type: 'varchar', length: 3, default: 'USD' })
  currency!: string;

  /**
   * When this pricing becomes effective
   */
  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  effectiveFrom!: Date;

  /**
   * When this pricing expires (null = no expiration)
   */
  @Column({ type: 'timestamptz', nullable: true })
  effectiveTo!: Date | null;

  /**
   * Whether this pricing is currently active
   */
  @Column({ default: true })
  isActive!: boolean;

  /**
   * Internal notes about this pricing
   */
  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  /**
   * Version number for tracking changes
   */
  @Column({ type: 'int', default: 1 })
  version!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ type: 'uuid', nullable: true })
  createdBy!: string | null;

  @Column({ type: 'uuid', nullable: true })
  updatedBy!: string | null;

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Get price for a specific metric
   */
  getMetricPrice(metricType: PricingMetricType): number {
    const metric = this.pricingMetrics.find((m) => m.type === metricType);
    return metric?.price ?? 0;
  }

  /**
   * Get tier multiplier (defaults to 1.0 if not set)
   */
  getTierMultiplier(tier: PlanTier): number {
    return this.tierMultipliers[tier] ?? 1.0;
  }

  /**
   * Calculate price for a metric with quantity and tier
   */
  calculateMetricCost(
    metricType: PricingMetricType,
    quantity: number,
    tier: PlanTier = PlanTier.STARTER,
  ): number {
    const metric = this.pricingMetrics.find((m) => m.type === metricType);
    if (!metric) return 0;

    // Subtract included quantity
    const billableQuantity = Math.max(
      0,
      quantity - (metric.includedQuantity ?? 0),
    );

    // Apply tier multiplier
    const multiplier = this.getTierMultiplier(tier);

    return billableQuantity * metric.price * multiplier;
  }

  /**
   * Check if pricing is currently valid
   */
  isCurrentlyValid(): boolean {
    const now = new Date();
    const isAfterStart = now >= this.effectiveFrom;
    const isBeforeEnd = !this.effectiveTo || now <= this.effectiveTo;
    return this.isActive && isAfterStart && isBeforeEnd;
  }
}
