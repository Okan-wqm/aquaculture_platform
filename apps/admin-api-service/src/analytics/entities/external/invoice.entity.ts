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

// Read from public schema (shared database) - read-only reference
@Entity('invoices', { schema: 'public', synchronize: false })
export class InvoiceReadOnly {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  tenantId!: string;

  @Column({ unique: true })
  invoiceNumber!: string;

  @Column({ type: 'uuid', nullable: true })
  subscriptionId!: string | null;

  @Column({ type: 'enum', enum: InvoiceStatus, default: InvoiceStatus.DRAFT })
  status!: InvoiceStatus;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  subtotal!: number;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  total!: number;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  amountPaid!: number;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  amountDue!: number;

  @Column({ default: 'USD' })
  currency!: string;

  @Column({ type: 'timestamptz' })
  issueDate!: Date;

  @Column({ type: 'timestamptz' })
  dueDate!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  paidAt!: Date | null;

  @Column({ type: 'date' })
  periodStart!: Date;

  @Column({ type: 'date' })
  periodEnd!: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
