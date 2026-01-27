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
import { ObjectType, Field, ID, Int, registerEnumType, Float } from '@nestjs/graphql';
import { forwardRef } from '@nestjs/common';

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

  @Field({ nullable: true })
  cardExpMonth?: number;

  @Field({ nullable: true })
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
  @Column()
  @Index()
  tenantId!: string;

  @Field()
  @Column() // Note: Unique per tenant via composite index on line 82
  transactionId!: string;

  @Field()
  @Column()
  @Index()
  invoiceId!: string;

  @Field(() => require('./invoice.entity').Invoice)
  @ManyToOne(
    () => require('./invoice.entity').Invoice,
    (invoice: { payments: unknown }) => invoice.payments,
  )
  @JoinColumn({ name: 'invoiceId' })
  invoice!: import('./invoice.entity').Invoice;

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
  @Column({ type: 'enum', enum: PaymentMethod })
  paymentMethod!: PaymentMethod;

  @Field(() => PaymentMethodDetails, { nullable: true })
  @Column('jsonb', { nullable: true })
  paymentMethodDetails?: PaymentMethodDetails;

  @Field(() => Date)
  @Column({ type: 'timestamptz' })
  paymentDate!: Date;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  processedAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  failureReason?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  stripePaymentIntentId?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  stripeChargeId?: string;

  @Field(() => [RefundInfo], { nullable: true })
  @Column('jsonb', { nullable: true })
  refunds?: RefundInfo[];

  @Field(() => Float, { defaultValue: 0 })
  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
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
  @Column({ nullable: true })
  createdBy?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  updatedBy?: string;

  @Field(() => Int)
  @VersionColumn()
  version!: number;
}
