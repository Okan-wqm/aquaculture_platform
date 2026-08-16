import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
// Tenant Notes Entity
@Entity('tenant_notes', { schema: 'admin' })
@Index(['tenantId', 'createdAt'])
export class TenantNote {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'text' })
  content!: string;

  @Column({ type: 'varchar', length: 50, default: 'general' })
  category!: string; // general, support, billing, technical

  @Column({ type: 'boolean', default: false })
  isPinned!: boolean;

  @Column({ type: 'varchar', length: 100 })
  createdBy!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  createdByEmail?: string;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt!: Date;

  // BUG-011 fix: track when a note was last edited so edit history is visible
  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt!: Date;
}

// Tenant Billing Info (simplified - full billing would be in billing-service)
@Entity('tenant_billing_info', { schema: 'admin' })
@Index(['tenantId'])
export class TenantBillingInfo {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', unique: true })
  tenantId!: string;

  @Column({ type: 'varchar', length: 50 })
  billingCycle!: string; // monthly, yearly

  // DecimalTransformer: monthlyAmount tracks billed amount per billing cycle.
  // Used in revenue dashboards; string accumulation corrupts totals.
  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 0,
    transformer: new DecimalTransformer(),
  })
  monthlyAmount!: number;

  @Column({ type: 'varchar', length: 3, default: 'USD' })
  currency!: string;

  @Column({ type: 'varchar', length: 50, default: 'pending' })
  paymentStatus!: string; // active, pending, overdue, cancelled

  @Column({ type: 'timestamp with time zone', nullable: true })
  nextBillingDate?: Date;

  @Column({ type: 'timestamp with time zone', nullable: true })
  lastPaymentDate?: Date;

  // DecimalTransformer: lastPaymentAmount is displayed in admin dashboard and compared
  // against outstanding balance. Nullable; transformer returns null for null values safely.
  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: new DecimalTransformer(),
  })
  lastPaymentAmount?: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  stripeCustomerId?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  stripeSubscriptionId?: string;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt!: Date;
}
