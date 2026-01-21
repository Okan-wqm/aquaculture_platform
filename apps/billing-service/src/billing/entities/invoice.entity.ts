import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { ObjectType, Field, ID, Int, registerEnumType, Float } from '@nestjs/graphql';
import { Subscription } from './subscription.entity';
import { Payment } from './payment.entity';

export enum InvoiceStatus {
  DRAFT = 'draft',
  PENDING = 'pending',
  SENT = 'sent',
  PAID = 'paid',
  PARTIALLY_PAID = 'partially_paid',
  OVERDUE = 'overdue',
  VOID = 'void',
  REFUNDED = 'refunded',
}

registerEnumType(InvoiceStatus, { name: 'InvoiceStatus' });

@ObjectType()
export class InvoiceLineItem {
  @Field()
  description!: string;

  @Field(() => Float)
  quantity!: number;

  @Field(() => Float)
  unitPrice!: number;

  @Field(() => Float)
  amount!: number;

  @Field({ nullable: true })
  productCode?: string;
}

@ObjectType()
export class TaxInfo {
  @Field(() => Float)
  taxRate!: number;

  @Field(() => Float)
  taxAmount!: number;

  @Field({ nullable: true })
  taxId?: string;

  @Field({ nullable: true })
  taxName?: string;
}

@ObjectType()
export class BillingAddress {
  @Field()
  companyName!: string;

  @Field({ nullable: true })
  attention?: string;

  @Field()
  street!: string;

  @Field()
  city!: string;

  @Field()
  state!: string;

  @Field()
  postalCode!: string;

  @Field()
  country!: string;

  @Field({ nullable: true })
  taxId?: string;
}

@ObjectType()
@Entity('invoices')
@Index(['tenantId', 'invoiceNumber'], { unique: true })
@Index(['tenantId', 'status'])
@Index(['tenantId', 'dueDate'])
@Index(['subscriptionId'])
export class Invoice {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column()
  @Index()
  tenantId!: string;

  @Field()
  @Column() // Note: Unique per tenant via composite index on line 92
  invoiceNumber!: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  subscriptionId?: string;

  @Field(() => Subscription, { nullable: true })
  @ManyToOne(() => Subscription, (subscription) => subscription.invoices)
  @JoinColumn({ name: 'subscriptionId' })
  subscription?: Subscription;

  @Field(() => InvoiceStatus)
  @Column({ type: 'enum', enum: InvoiceStatus, default: InvoiceStatus.DRAFT })
  status!: InvoiceStatus;

  @Field(() => BillingAddress)
  @Column('jsonb')
  billingAddress!: BillingAddress;

  @Field(() => [InvoiceLineItem])
  @Column('jsonb')
  lineItems!: InvoiceLineItem[];

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 12, scale: 2 })
  subtotal!: number;

  @Field(() => TaxInfo, { nullable: true })
  @Column('jsonb', { nullable: true })
  tax?: TaxInfo;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  discount?: number;

  @Field({ nullable: true })
  @Column({ nullable: true })
  discountCode?: string;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 12, scale: 2 })
  total!: number;

  @Field(() => Float, { defaultValue: 0 })
  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  amountPaid!: number;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 12, scale: 2 })
  amountDue!: number;

  @Field()
  @Column({ default: 'USD' })
  currency!: string;

  @Field(() => Date)
  @Column({ type: 'timestamptz' })
  issueDate!: Date;

  @Field(() => Date)
  @Column({ type: 'timestamptz' })
  dueDate!: Date;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  paidAt?: Date;

  @Field(() => Date)
  @Column({ type: 'date' })
  periodStart!: Date;

  @Field(() => Date)
  @Column({ type: 'date' })
  periodEnd!: Date;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  stripeInvoiceId?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  pdfUrl?: string;

  @Field(() => [Payment], { nullable: true })
  @OneToMany(() => Payment, (payment) => payment.invoice)
  payments?: Payment[];

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
