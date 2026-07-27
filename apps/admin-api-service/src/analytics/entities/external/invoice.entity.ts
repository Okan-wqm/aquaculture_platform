/**
 * Invoice Entity (Read-only reference)
 *
 * This is a read-only view of the invoice table owned by billing-service.
 * Used for cross-service analytics queries in the shared database.
 * DO NOT modify - source of truth is billing-service.
 */

import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import {
  DateOnlyColumn,
  DecimalTransformer,
  type IsoDateString,
} from '@aquaculture/backend-common/database';

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

// C-6 fix: billing-service stores invoices in the 'billing' schema, not 'public'
// Column names explicitly mapped to snake_case as defined by billing-service schema
@Entity('invoices', { schema: 'billing', synchronize: false })
export class InvoiceReadOnly {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ name: 'invoice_number', unique: true })
  invoiceNumber!: string;

  @Column({ name: 'subscription_id', type: 'uuid', nullable: true })
  subscriptionId!: string | null;

  @Column({ type: 'enum', enum: InvoiceStatus, default: InvoiceStatus.DRAFT })
  status!: InvoiceStatus;

  // DecimalTransformer: read-only cross-service view of billing-service invoices.
  // Even though this entity is never written via this service, TypeORM still returns
  // decimal columns as strings on read. Analytics aggregation (SUM, AVG) done in
  // application code must operate on numbers, not strings.
  @Column({ type: 'decimal', precision: 12, scale: 2, transformer: new DecimalTransformer() })
  subtotal!: number;

  @Column({ type: 'decimal', precision: 12, scale: 2, transformer: new DecimalTransformer() })
  total!: number;

  @Column({ name: 'amount_paid', type: 'decimal', precision: 12, scale: 2, default: 0, transformer: new DecimalTransformer() })
  amountPaid!: number;

  @Column({ name: 'amount_due', type: 'decimal', precision: 12, scale: 2, transformer: new DecimalTransformer() })
  amountDue!: number;

  @Column({ default: 'USD' })
  currency!: string;

  @Column({ name: 'issue_date', type: 'timestamptz' })
  issueDate!: Date;

  @Column({ name: 'due_date', type: 'timestamptz' })
  dueDate!: Date;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt!: Date | null;

  @DateOnlyColumn({ name: 'period_start' })
  periodStart!: IsoDateString;

  @DateOnlyColumn({ name: 'period_end' })
  periodEnd!: IsoDateString;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
