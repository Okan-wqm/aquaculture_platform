/**
 * Invoice Entity (Read-only reference)
 *
 * This is a read-only view of the invoice table owned by billing-service.
 * Used for cross-service analytics queries in the shared database.
 * DO NOT modify - source of truth is billing-service.
 */

import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

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

  @Column({ name: 'tenant_id' })
  tenantId!: string;

  @Column({ name: 'invoice_number', unique: true })
  invoiceNumber!: string;

  @Column({ name: 'subscription_id', type: 'uuid', nullable: true })
  subscriptionId!: string | null;

  @Column({ type: 'enum', enum: InvoiceStatus, default: InvoiceStatus.DRAFT })
  status!: InvoiceStatus;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  subtotal!: number;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  total!: number;

  @Column({ name: 'amount_paid', type: 'decimal', precision: 12, scale: 2, default: 0 })
  amountPaid!: number;

  @Column({ name: 'amount_due', type: 'decimal', precision: 12, scale: 2 })
  amountDue!: number;

  @Column({ default: 'USD' })
  currency!: string;

  @Column({ name: 'issue_date', type: 'timestamptz' })
  issueDate!: Date;

  @Column({ name: 'due_date', type: 'timestamptz' })
  dueDate!: Date;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt!: Date | null;

  @Column({ name: 'period_start', type: 'date' })
  periodStart!: Date;

  @Column({ name: 'period_end', type: 'date' })
  periodEnd!: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
