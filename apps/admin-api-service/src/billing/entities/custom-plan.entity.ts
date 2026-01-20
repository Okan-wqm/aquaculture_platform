import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { PlanDefinition, PlanTier, BillingCycle } from './plan-definition.entity';

/**
 * Custom plan status
 */
export enum CustomPlanStatus {
  DRAFT = 'draft',           // Being configured
  PENDING_APPROVAL = 'pending_approval', // Awaiting admin approval
  APPROVED = 'approved',     // Ready to activate
  ACTIVE = 'active',         // Currently in use
  EXPIRED = 'expired',       // Past validity date
  REJECTED = 'rejected',     // Admin rejected
}

/**
 * Module selection with quantities
 */
export interface CustomPlanModule {
  moduleId: string;
  moduleCode: string;
  moduleName: string;
  quantities: {
    users?: number;
    farms?: number;
    ponds?: number;
    sensors?: number;
    devices?: number;
    storageGb?: number;
    apiCalls?: number;
    alerts?: number;
    reports?: number;
    integrations?: number;
  };
  lineItems: CustomPlanLineItem[];
  subtotal: number;
}

/**
 * Individual line item for pricing
 */
export interface CustomPlanLineItem {
  metric: string;
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

/**
 * Custom Plan Entity
 *
 * Allows creating tenant-specific plans with custom module combinations.
 * Can be based on an existing plan or built from scratch.
 *
 * Flow:
 * 1. Admin creates custom plan for tenant (status: draft)
 * 2. Configure modules and quantities
 * 3. System calculates pricing
 * 4. Admin approves (status: approved)
 * 5. Plan is activated with subscription (status: active)
 */
@Entity('custom_plans')
@Index(['tenantId'])
@Index(['status'])
@Index(['validFrom'])
export class CustomPlan {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Target tenant for this custom plan
   */
  @Column('uuid')
  tenantId!: string;

  /**
   * Custom plan name
   */
  @Column({ type: 'varchar', length: 100 })
  name!: string;

  /**
   * Description of this custom plan
   */
  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /**
   * Base plan this was derived from (if any)
   */
  @Column('uuid', { nullable: true })
  basePlanId!: string | null;

  @ManyToOne(() => PlanDefinition, { nullable: true })
  @JoinColumn({ name: 'base_plan_id' })
  basePlan!: PlanDefinition | null;

  /**
   * Effective tier for limits/features
   */
  @Column({ type: 'enum', enum: PlanTier, default: PlanTier.CUSTOM })
  tier!: PlanTier;

  /**
   * Billing cycle
   */
  @Column({ type: 'enum', enum: BillingCycle, default: BillingCycle.MONTHLY })
  billingCycle!: BillingCycle;

  /**
   * Selected modules with configurations
   */
  @Column('jsonb', { default: [] })
  modules!: CustomPlanModule[];

  /**
   * Calculated monthly subtotal (before discounts)
   */
  @Column('decimal', { precision: 12, scale: 2, default: 0 })
  monthlySubtotal!: number;

  /**
   * Discount percentage (0-100)
   */
  @Column('decimal', { precision: 5, scale: 2, default: 0 })
  discountPercent!: number;

  /**
   * Fixed discount amount
   */
  @Column('decimal', { precision: 12, scale: 2, default: 0 })
  discountAmount!: number;

  /**
   * Discount reason/code
   */
  @Column({ type: 'varchar', length: 100, nullable: true })
  discountReason!: string | null;

  /**
   * Final monthly total after discounts
   */
  @Column('decimal', { precision: 12, scale: 2 })
  monthlyTotal!: number;

  /**
   * Currency
   */
  @Column({ type: 'varchar', length: 3, default: 'USD' })
  currency!: string;

  /**
   * Plan status
   */
  @Column({ type: 'enum', enum: CustomPlanStatus, default: CustomPlanStatus.DRAFT })
  status!: CustomPlanStatus;

  /**
   * When this plan becomes valid
   */
  @Column({ type: 'date' })
  validFrom!: Date;

  /**
   * When this plan expires (null = no expiration)
   */
  @Column({ type: 'date', nullable: true })
  validTo!: Date | null;

  /**
   * Admin who approved this plan
   */
  @Column('uuid', { nullable: true })
  approvedBy!: string | null;

  /**
   * When it was approved
   */
  @Column({ type: 'timestamptz', nullable: true })
  approvedAt!: Date | null;

  /**
   * Rejection reason (if rejected)
   */
  @Column({ type: 'text', nullable: true })
  rejectionReason!: string | null;

  /**
   * Internal notes
   */
  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  /**
   * Reference to created subscription (after activation)
   */
  @Column('uuid', { nullable: true })
  subscriptionId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column('uuid', { nullable: true })
  createdBy!: string | null;

  @Column('uuid', { nullable: true })
  updatedBy!: string | null;

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Check if plan can be modified
   */
  canModify(): boolean {
    return [CustomPlanStatus.DRAFT, CustomPlanStatus.PENDING_APPROVAL].includes(
      this.status,
    );
  }

  /**
   * Check if plan can be approved
   */
  canApprove(): boolean {
    return this.status === CustomPlanStatus.PENDING_APPROVAL;
  }

  /**
   * Check if plan can be activated
   */
  canActivate(): boolean {
    return this.status === CustomPlanStatus.APPROVED;
  }

  /**
   * Check if plan is currently valid
   */
  isValid(): boolean {
    const now = new Date();
    const isAfterStart = now >= this.validFrom;
    const isBeforeEnd = !this.validTo || now <= this.validTo;
    return (
      this.status === CustomPlanStatus.ACTIVE && isAfterStart && isBeforeEnd
    );
  }

  /**
   * Get total included users across all modules
   */
  getTotalUsers(): number {
    return this.modules.reduce(
      (sum, m) => sum + (m.quantities.users ?? 0),
      0,
    );
  }

  /**
   * Get module by ID
   */
  getModule(moduleId: string): CustomPlanModule | undefined {
    return this.modules.find((m) => m.moduleId === moduleId);
  }

  /**
   * Calculate discount
   */
  calculateDiscount(): number {
    let discount = this.discountAmount;
    if (this.discountPercent > 0) {
      discount += (this.monthlySubtotal * this.discountPercent) / 100;
    }
    return Math.min(discount, this.monthlySubtotal); // Can't exceed subtotal
  }
}
