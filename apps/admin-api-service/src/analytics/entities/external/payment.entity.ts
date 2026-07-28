/**
 * Payment (read-only reference)
 *
 * A read-only view of the payment table owned by billing-service.
 * DO NOT modify — the source of truth is billing-service.
 *
 * # Why analytics reads this table rather than the invoice
 *
 * A refund is a DATED fact that does not belong to the day the invoice was
 * paid: an invoice paid in March and refunded in May must reduce May's net
 * revenue, not March's. `billing.invoices` carries only the current status, so
 * a refund read from there would silently re-date itself onto the original
 * payment day. Each `refunds[]` entry carries its own `refundedAt`, which is
 * what makes the revenue report's per-day netting honest (APA-139).
 */
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/** Mirrors billing-service's `PaymentStatus`. */
export enum PaymentStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  REFUNDED = 'refunded',
  PARTIALLY_REFUNDED = 'partially_refunded',
  CANCELLED = 'cancelled',
}

/** One refund against a payment, with the date it was issued. */
export interface RefundEntry {
  amount: number;
  reason: string;
  refundedAt: string | Date;
  refundId?: string;
}

@Entity('payments', { schema: 'billing', synchronize: false })
@Index(['tenantId'])
export class PaymentReadOnly {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ name: 'invoice_id' })
  invoiceId!: string;

  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: new DecimalTransformer(),
  })
  amount!: number;

  @Column({ default: 'USD' })
  currency!: string;

  @Column({ type: 'enum', enum: PaymentStatus })
  status!: PaymentStatus;

  @Column({ type: 'timestamptz', name: 'payment_date' })
  paymentDate!: Date;

  /** Each entry carries its own `refundedAt`; a refund is dated by when it was
   *  issued, not by when the payment it reverses was taken. */
  @Column('jsonb', { nullable: true })
  refunds?: RefundEntry[] | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
