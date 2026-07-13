import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ObjectType, Field, HideField, ID, Int, registerEnumType, Float } from '@nestjs/graphql';
import { MoneyColumn } from '@aquaculture/backend-common/monetary';
import Decimal from 'decimal.js';

export enum PaymentStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded',
  PARTIALLY_REFUNDED = 'partially_refunded',
}

export enum PaymentMethod {
  CREDIT_CARD = 'credit_card',
  DEBIT_CARD = 'debit_card',
  BANK_TRANSFER = 'bank_transfer',
  WIRE_TRANSFER = 'wire_transfer',
  ACH = 'ach',
  SEPA = 'sepa',
  PAYPAL = 'paypal',
  CHECK = 'check',
  CASH = 'cash',
  OTHER = 'other',
}

registerEnumType(PaymentStatus, { name: 'PaymentStatus' });
registerEnumType(PaymentMethod, { name: 'PaymentMethod' });

@ObjectType()
export class PaymentMethodDetails {
  @Field({ nullable: true })
  cardBrand?: string;

  @Field({ nullable: true })
  cardLast4?: string;

  @HideField()
  cardExpMonth?: number;

  @HideField()
  cardExpYear?: number;

  @Field({ nullable: true })
  bankName?: string;

  @Field({ nullable: true })
  bankAccountLast4?: string;

  @Field({ nullable: true })
  checkNumber?: string;
}

@ObjectType()
export class RefundInfo {
  @Field(() => Float, {
    deprecationReason: 'Use amountDecimal (exact decimal string, ADR-0004).',
  })
  amount!: number;

  @Field()
  reason!: string;

  @Field(() => Date)
  refundedAt!: Date;

  @Field({ nullable: true })
  refundId?: string;
}

@ObjectType()
@Entity('payments', { schema: 'billing' })
@Index(['tenantId', 'transactionId'], { unique: true })
@Index(['tenantId', 'status'])
@Index(['tenantId', 'paymentDate'])
@Index(['invoiceId'])
export class Payment {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Field()
  @Column({ name: 'transaction_id' }) // Note: Unique per tenant via composite index on line 82
  transactionId!: string;

  @Field()
  @Column({ name: 'invoice_id' })
  invoiceId!: string;

  // DBR-MEDIUM-005 cure: explicit onDelete: 'RESTRICT' encodes the
  // business intent at the FK level — a paid invoice with linked
  // Payment rows must NOT be deletable; deletion would orphan
  // immutable financial records that downstream reconciliation
  // (tenant_cost_rollup, Stripe MeterEvent ledger) treats as
  // authoritative. Migration 1788300000000 installs the matching
  // explicit DB-level constraint.
  // Bi-directional relationship - using string-based lazy loading to avoid circular dependency
  // Invoice entity is loaded lazily by TypeORM at runtime
  @ManyToOne('Invoice', (invoice: any) => invoice.payments, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'invoice_id' })
  invoice?: any;

  @Field(() => Float, {
    deprecationReason: 'Use amountDecimal (exact decimal string, ADR-0004).',
  })
  // MoneyColumn: numeric(19,4) with lossless Decimal.js transformer.
  @MoneyColumn()
  amount!: Decimal;

  @Field()
  @Column({ default: 'USD' })
  currency!: string;

  @Field(() => PaymentStatus)
  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.PENDING })
  status!: PaymentStatus;

  @Field(() => PaymentMethod)
  @Column({ type: 'enum', enum: PaymentMethod, name: 'payment_method' })
  paymentMethod!: PaymentMethod;

  @Field(() => PaymentMethodDetails, { nullable: true })
  @Column('jsonb', { nullable: true, name: 'payment_method_details' })
  paymentMethodDetails?: PaymentMethodDetails;

  @Field(() => Date)
  @Column({ type: 'timestamptz', name: 'payment_date' })
  paymentDate!: Date;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true, name: 'processed_at' })
  processedAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true, name: 'failure_reason' })
  failureReason?: string;

  @HideField()
  @Index('IDX_payment_stripe_pi', { unique: true, where: '"stripe_payment_intent_id" IS NOT NULL' })
  @Column({ nullable: true, name: 'stripe_payment_intent_id' })
  stripePaymentIntentId?: string;

  @HideField()
  @Column({ nullable: true, name: 'stripe_charge_id' })
  stripeChargeId?: string;

  @Field(() => [RefundInfo], { nullable: true })
  @Column('jsonb', { nullable: true })
  refunds?: RefundInfo[];

  @Field(() => Float, {
    defaultValue: 0,
    deprecationReason: 'Use refundedAmountDecimal (exact decimal string, ADR-0004).',
  })
  // MoneyColumn: numeric(19,4) with lossless Decimal.js transformer.
  // refundedAmount participates in remaining balance calculation (amount - refundedAmount).
  @MoneyColumn({ default: 0, name: 'refunded_amount' })
  refundedAmount!: Decimal;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

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

  // Soft-delete: financial records must never be physically deleted.
  // Hard-delete of payment records violates financial audit trail requirements (SOX, PCI-DSS).
  // isDeleted=true logically removes the record while preserving it for reconciliation and audit.
  // BEFORE: no soft-delete — DELETE queries removed rows permanently with no recovery path.
  @Field()
  @Column({ default: false, name: 'is_deleted' })
  @Index()
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
}
