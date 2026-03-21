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
  @Field(() => Float)
  amount!: number;

  @Field()
  reason!: string;

  @Field(() => Date)
  refundedAt!: Date;

  @Field({ nullable: true })
  refundId?: string;
}

@ObjectType()
@Entity('payments')
@Index(['tenantId', 'transactionId'], { unique: true })
@Index(['tenantId', 'status'])
@Index(['tenantId', 'paymentDate'])
@Index(['invoiceId'])
export class Payment {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ name: 'tenant_id' })
  tenantId!: string;

  @Field()
  @Column({ name: 'transaction_id' }) // Note: Unique per tenant via composite index on line 82
  transactionId!: string;

  @Field()
  @Column({ name: 'invoice_id' })
  invoiceId!: string;

  // Bi-directional relationship - using string-based lazy loading to avoid circular dependency
  // Invoice entity is loaded lazily by TypeORM at runtime
  @ManyToOne('Invoice', (invoice: any) => invoice.payments)
  @JoinColumn({ name: 'invoice_id' })
  invoice?: any;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 12, scale: 2 })
  amount!: number;

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

  @Field(() => Float, { defaultValue: 0 })
  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0, name: 'refunded_amount' })
  refundedAmount!: number;

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
}
