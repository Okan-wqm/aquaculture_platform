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
  AfterLoad,
} from 'typeorm';
import { ObjectType, Field, HideField, ID, Int, registerEnumType, Float } from '@nestjs/graphql';
import { MoneyColumn } from '@aquaculture/backend-common/monetary';
import Decimal from 'decimal.js';
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

  // TODO: Migrate monetary GraphQL fields from Float to a custom Decimal scalar.
  // IEEE 754 double-precision (GraphQL Float) causes rounding errors on monetary values.
  // Current Float usage works for typical aquaculture billing amounts but should be
  // replaced before high-volume invoicing. Tracked as PLAT-LOW-001.
  @Field(() => Float)
  quantity!: number;

  @Field(() => Float, {
    deprecationReason: 'Use unitPriceDecimal (exact decimal string, ADR-0004).',
  })
  unitPrice!: number;

  @Field(() => Float, {
    deprecationReason: 'Use amountDecimal (exact decimal string, ADR-0004).',
  })
  amount!: number;

  @Field({ nullable: true })
  productCode?: string;
}

@ObjectType()
export class TaxInfo {
  @Field(() => Float)
  taxRate!: number;

  @Field(() => Float, {
    deprecationReason: 'Use taxAmountDecimal (exact decimal string, ADR-0004).',
  })
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
@Entity('invoices', { schema: 'billing' })
@Index(['tenantId', 'invoiceNumber'], { unique: true })
@Index(['tenantId', 'status'])
@Index(['tenantId', 'dueDate'])
@Index(['subscriptionId'])
export class Invoice {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Field()
  @Column({ name: 'invoice_number' }) // Note: Unique per tenant via composite index on line 92
  invoiceNumber!: string;

  @Field({ nullable: true })
  @Column({ name: 'subscription_id', nullable: true })
  subscriptionId?: string;

  // DBR-MEDIUM-005 cure: explicit onDelete: 'RESTRICT' encodes the
  // business intent at the FK level — a subscription with invoice
  // history must NOT be deletable; soft-delete via deleted_at is the
  // only allowed lifecycle. Migration 1788300000000 installs the
  // matching explicit DB-level constraint.
  // Note: subscription field resolved via field resolver to avoid circular dependency
  @ManyToOne('Subscription', 'invoices', { onDelete: 'RESTRICT' })
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

  // ADR-0004 / PLAT-LOW-001: subtotalDecimal (Decimal scalar) is the exact wire
  // form; this Float is retained during additive coexistence, removed once all
  // readers migrate. DB layer is already numeric(19,4) via MoneyColumn.
  @Field(() => Float, {
    deprecationReason: 'Use subtotalDecimal (exact decimal string, ADR-0004).',
  })
  @MoneyColumn()
  subtotal!: Decimal;

  @Field(() => TaxInfo, { nullable: true })
  @Column('jsonb', { nullable: true })
  tax?: TaxInfo;

  @Field(() => Float, {
    nullable: true,
    deprecationReason: 'Use discountDecimal (exact decimal string, ADR-0004).',
  })
  @MoneyColumn({ nullable: true })
  discount?: Decimal;

  @Field({ nullable: true })
  @Column({ nullable: true, name: 'discount_code' })
  discountCode?: string;

  @Field(() => Float, {
    deprecationReason: 'Use totalDecimal (exact decimal string, ADR-0004).',
  })
  @MoneyColumn()
  total!: Decimal;

  @Field(() => Float, {
    defaultValue: 0,
    deprecationReason: 'Use amountPaidDecimal (exact decimal string, ADR-0004).',
  })
  @MoneyColumn({ default: 0, name: 'amount_paid' })
  amountPaid!: Decimal;

  @Field(() => Float, {
    deprecationReason: 'Use amountDueDecimal (exact decimal string, ADR-0004).',
  })
  @MoneyColumn({ name: 'amount_due' })
  amountDue!: Decimal;

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

  // Soft-delete: invoices are legal financial documents and must never be physically deleted.
  // Voiding an invoice sets status=VOID; soft-delete marks it logically removed for cleanup
  // while preserving the record for eDiscovery and tax audit purposes.
  // BEFORE: no soft-delete — DELETE queries removed invoices permanently.
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

  // ── PLAT-HIGH-006: Immutability guard for finalized invoices ─────────
  // SECURITY: Once an invoice transitions to SENT or beyond (PAID, OVERDUE, etc.),
  // financial fields (amount, lineItems, subtotal, total) MUST NOT be modified.
  // This is enforced at the entity level so NO code path can bypass it.

  /** Status values that indicate the invoice has been finalized and sent to the customer */
  private static readonly IMMUTABLE_STATUSES: Set<InvoiceStatus> = new Set([
    InvoiceStatus.SENT,
    InvoiceStatus.PAID,
    InvoiceStatus.PARTIALLY_PAID,
    InvoiceStatus.OVERDUE,
    InvoiceStatus.REFUNDED,
  ]);

  /**
   * Snapshot of financial fields at the time of last DB load.
   * Used by @BeforeUpdate to detect unauthorized mutations.
   * TypeORM @AfterLoad populates this from the DB state.
   */
  private _financialSnapshot?: {
    subtotal: string;
    total: string;
    lineItems: string;
    currency: string;
  };

  /**
   * Capture financial field snapshot after loading from DB.
   * This runs every time TypeORM hydrates the entity from a query.
   */
  @AfterLoad()
  captureFinancialSnapshot(): void {
    if (Invoice.IMMUTABLE_STATUSES.has(this.status)) {
      this._financialSnapshot = {
        subtotal: this.subtotal?.toString() ?? '',
        total: this.total?.toString() ?? '',
        lineItems: JSON.stringify(this.lineItems ?? []),
        currency: this.currency ?? '',
      };
    }
  }

  /**
   * PLAT-HIGH-006: Guard immutable financial fields on sent/finalized invoices.
   * Throws if subtotal, total, lineItems, or currency are modified after finalization.
   * Status transitions (e.g., SENT -> PAID) and payment tracking fields (amountPaid,
   * amountDue, paidAt) are explicitly ALLOWED to change.
   */
  @BeforeUpdate()
  guardImmutableAfterSent(): void {
    if (!this._financialSnapshot) {
      return; // Not a finalized invoice or freshly created
    }

    const current = {
      subtotal: this.subtotal?.toString() ?? '',
      total: this.total?.toString() ?? '',
      lineItems: JSON.stringify(this.lineItems ?? []),
      currency: this.currency ?? '',
    };

    const violations: string[] = [];
    if (current.subtotal !== this._financialSnapshot.subtotal) {
      violations.push('subtotal');
    }
    if (current.total !== this._financialSnapshot.total) {
      violations.push('total');
    }
    if (current.lineItems !== this._financialSnapshot.lineItems) {
      violations.push('lineItems');
    }
    if (current.currency !== this._financialSnapshot.currency) {
      violations.push('currency');
    }

    if (violations.length > 0) {
      throw new Error(
        `INVOICE_IMMUTABILITY_VIOLATION: Cannot modify ${violations.join(', ')} ` +
        `on invoice ${this.id} with status "${this.status}". ` +
        `Invoices are immutable after being sent to the customer.`,
      );
    }
  }

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
