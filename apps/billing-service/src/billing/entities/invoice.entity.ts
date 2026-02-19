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
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import { ObjectType, Field, HideField, ID, Int, registerEnumType, Float } from '@nestjs/graphql';
// forwardRef removed - not needed with string-based lazy loading

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
  @Column({ name: 'tenant_id' })
  @Index()
  tenantId!: string;

  @Field()
  @Column({ name: 'invoice_number' }) // Note: Unique per tenant via composite index on line 92
  invoiceNumber!: string;

  @Field({ nullable: true })
  @Column({ name: 'subscription_id', nullable: true })
  subscriptionId?: string;

  // Note: subscription field resolved via field resolver to avoid circular dependency
  @ManyToOne('Subscription', 'invoices')
  @JoinColumn({ name: 'subscription_id' })
  subscription?: import('./subscription.entity').Subscription;

  @Field(() => InvoiceStatus)
  @Column({ type: 'enum', enum: InvoiceStatus, default: InvoiceStatus.DRAFT })
  status!: InvoiceStatus;

  @Field(() => BillingAddress)
  @Column('jsonb', { name: 'billing_address' })
  billingAddress!: BillingAddress;

  @Field(() => [InvoiceLineItem])
  @Column('jsonb', { name: 'line_items' })
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
  @Column({ nullable: true, name: 'discount_code' })
  discountCode?: string;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 12, scale: 2 })
  total!: number;

  @Field(() => Float, { defaultValue: 0 })
  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0, name: 'amount_paid' })
  amountPaid!: number;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 12, scale: 2, name: 'amount_due' })
  amountDue!: number;

  @Field()
  @Column({ default: 'USD' })
  currency!: string;

  @Field(() => Date)
  @Column({ type: 'timestamptz', name: 'issue_date' })
  issueDate!: Date;

  @Field(() => Date)
  @Column({ type: 'timestamptz', name: 'due_date' })
  dueDate!: Date;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true, name: 'paid_at' })
  paidAt?: Date;

  @Field(() => Date)
  @Column({ type: 'date', name: 'period_start' })
  periodStart!: Date;

  @Field(() => Date)
  @Column({ type: 'date', name: 'period_end' })
  periodEnd!: Date;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  @HideField()
  @Column({ nullable: true, name: 'stripe_invoice_id' })
  stripeInvoiceId?: string;

  // MED-03: pdfUrl must point to a trusted storage origin only.
  // Validated in @BeforeInsert/@BeforeUpdate to prevent SSRF/open-redirect if the
  // value is ever set from user-influenced code paths.
  @Field({ nullable: true })
  @Column({ nullable: true, name: 'pdf_url' })
  pdfUrl?: string;

  // Note: payments field resolved via field resolver to avoid circular dependency
  @OneToMany('Payment', 'invoice')
  payments?: Array<import('./payment.entity').Payment>;

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

  /**
   * MED-03: Validate pdfUrl against a trusted URL prefix allowlist before persisting.
   * Prevents SSRF/open-redirect if this field is ever set from user-influenced input.
   */
  @BeforeInsert()
  @BeforeUpdate()
  validatePdfUrl(): void {
    if (this.pdfUrl) {
      // Allowlist: only HTTPS URLs on trusted storage origins are permitted.
      // Adjust the pattern to match your actual S3 bucket / CDN domain.
      const TRUSTED_PDF_URL_PATTERN =
        /^https:\/\/([a-z0-9.-]+\.s3\.[a-z0-9-]+\.amazonaws\.com|storage\.googleapis\.com\/[^/]+|[a-z0-9.-]+\.blob\.core\.windows\.net)\//i;
      if (!TRUSTED_PDF_URL_PATTERN.test(this.pdfUrl)) {
        throw new Error(
          `Invalid pdfUrl: must be an HTTPS URL on a trusted storage origin (got: ${this.pdfUrl})`,
        );
      }
    }
  }
}
