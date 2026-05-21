import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Payment overview for admin panel
 */
export interface PaymentOverview {
  id: string;
  tenantId: string;
  transactionId: string;
  invoiceId: string;
  invoiceNumber?: string;
  tenantName?: string;
  amount: number;
  currency: string;
  status: string;
  paymentMethod: string;
  paymentDate: string;
  processedAt?: string;
  failureReason?: string;
  refundedAmount: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface PaymentFilters {
  status?: string[];
  invoiceId?: string;
  tenantId?: string;
  search?: string;
  dateFrom?: Date;
  dateTo?: Date;
  limit?: number;
  offset?: number;
}

export interface RecordPaymentDto {
  invoiceId: string;
  amount: number;
  paymentMethod: string;
  paymentDate?: string;
  currency?: string;
  notes?: string;
}

export interface RefundPaymentDto {
  paymentId: string;
  amount: number;
  reason: string;
}

type DbNumeric = number | string | null | undefined;

interface CountRow {
  count: DbNumeric;
}

type PaymentOverviewRow = Omit<PaymentOverview, 'amount' | 'refundedAmount'> & {
  amount: DbNumeric;
  refundedAmount: DbNumeric;
};

interface InvoicePaymentSourceRow {
  id: string;
  tenantId: string;
  status: string;
  amountDue: DbNumeric;
  total: DbNumeric;
}

interface PaymentRefundSourceRow {
  id: string;
  tenantId: string;
  invoiceId: string;
  amount: DbNumeric;
  refundedAmount: DbNumeric;
  status: string;
}

function dbNumber(value: DbNumeric): number {
  if (value === null || value === undefined || value === '') {
    return 0;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapPaymentOverview(row: PaymentOverviewRow): PaymentOverview {
  return {
    ...row,
    amount: dbNumber(row.amount),
    refundedAmount: dbNumber(row.refundedAmount),
  };
}

@Injectable()
export class PaymentManagementService {
  private readonly logger = new Logger(PaymentManagementService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Get all payments with filters
   */
  async getPayments(filters: PaymentFilters = {}): Promise<{
    payments: PaymentOverview[];
    total: number;
  }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filters.status && filters.status.length > 0) {
      conditions.push(`p.status = ANY($${paramIndex})`);
      params.push(filters.status);
      paramIndex++;
    }

    if (filters.invoiceId) {
      conditions.push(`p.invoice_id = $${paramIndex}::uuid`);
      params.push(filters.invoiceId);
      paramIndex++;
    }

    if (filters.tenantId) {
      conditions.push(`p.tenant_id = $${paramIndex}::uuid`);
      params.push(filters.tenantId);
      paramIndex++;
    }

    if (filters.search) {
      conditions.push(`(p.transaction_id ILIKE $${paramIndex} OR p.notes ILIKE $${paramIndex})`);
      params.push(`%${filters.search}%`);
      paramIndex++;
    }

    if (filters.dateFrom) {
      conditions.push(`p.payment_date >= $${paramIndex}`);
      params.push(filters.dateFrom);
      paramIndex++;
    }

    if (filters.dateTo) {
      conditions.push(`p.payment_date <= $${paramIndex}`);
      params.push(filters.dateTo);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;

    const countQuery = `SELECT COUNT(*) as count FROM billing.payments p ${whereClause}`;
    const countResult = await this.dataSource.query<CountRow[]>(countQuery, params);
    const total = dbNumber(countResult[0]?.count);

    const query = `
      SELECT
        p.id,
        p.tenant_id as "tenantId",
        p.transaction_id as "transactionId",
        p.invoice_id as "invoiceId",
        i.invoice_number as "invoiceNumber",
        p.amount,
        p.currency,
        p.status,
        p.payment_method as "paymentMethod",
        p.payment_date as "paymentDate",
        p.processed_at as "processedAt",
        p.failure_reason as "failureReason",
        p.refunded_amount as "refundedAmount",
        p.notes,
        p."createdAt",
        p."updatedAt",
        p.created_by as "createdBy"
      FROM billing.payments p
      LEFT JOIN billing.invoices i ON i.id = p.invoice_id
      ${whereClause}
      ORDER BY p.payment_date DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const payments = await this.dataSource.query<PaymentOverviewRow[]>(query, [
      ...params,
      limit,
      offset,
    ]);

    return {
      payments: payments.map(mapPaymentOverview),
      total,
    };
  }

  /**
   * Record a payment for an invoice
   */
  async recordPayment(
    dto: RecordPaymentDto,
    recordedBy: string,
  ): Promise<PaymentOverview> {
    // Verify invoice exists
    const invoice = await this.dataSource.query<InvoicePaymentSourceRow[]>(
      'SELECT id, tenant_id as "tenantId", status, amount_due as "amountDue", total FROM billing.invoices WHERE id = $1',
      [dto.invoiceId],
    );

    const inv = invoice[0];
    if (!inv) {
      throw new NotFoundException(`Invoice not found: ${dto.invoiceId}`);
    }

    const amountDue = dbNumber(inv.amountDue);

    if (dto.amount <= 0) {
      throw new BadRequestException('Payment amount must be positive');
    }

    if (dto.amount > amountDue) {
      throw new BadRequestException(`Payment amount ($${dto.amount}) exceeds amount due ($${amountDue})`);
    }

    /**
     * SECURITY (H-16): Transaction IDs use cryptographic randomness via crypto.randomUUID().
     * Math.random() output is predictable after observing a few values, enabling
     * transaction ID forgery or enumeration attacks on financial records.
     */
    const txId = `TXN-${Date.now()}-${randomUUID().replace(/-/g, '').substring(0, 8).toUpperCase()}`;

    // Insert payment record
    const result = await this.dataSource.query<PaymentOverviewRow[]>(
      `
      INSERT INTO billing.payments (
        id, tenant_id, transaction_id, invoice_id, amount, currency,
        status, payment_method, payment_date, processed_at,
        notes, created_by, "createdAt", "updatedAt", version
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5,
        'succeeded', $6, $7, NOW(),
        $8, $9, NOW(), NOW(), 1
      )
      RETURNING
        id,
        tenant_id as "tenantId",
        transaction_id as "transactionId",
        invoice_id as "invoiceId",
        amount,
        currency,
        status,
        payment_method as "paymentMethod",
        payment_date as "paymentDate",
        processed_at as "processedAt",
        refunded_amount as "refundedAmount",
        notes,
        "createdAt",
        "updatedAt",
        created_by as "createdBy"
      `,
      [
        inv.tenantId,
        txId,
        dto.invoiceId,
        dto.amount,
        dto.currency || 'USD',
        dto.paymentMethod,
        dto.paymentDate || new Date().toISOString(),
        dto.notes || null,
        recordedBy,
      ],
    );

    // Update invoice paid amount
    const newAmountPaid = dbNumber(inv.total) - amountDue + dto.amount;
    const newAmountDue = amountDue - dto.amount;
    const isPaidInFull = newAmountDue <= 0.01;

    await this.dataSource.query(
      `
      UPDATE billing.invoices SET
        amount_paid = $1,
        amount_due = $2,
        status = $3,
        paid_at = $4,
        "updatedAt" = NOW()
      WHERE id = $5
      `,
      [
        newAmountPaid,
        Math.max(0, newAmountDue),
        isPaidInFull ? 'paid' : 'partially_paid',
        isPaidInFull ? new Date() : null,
        dto.invoiceId,
      ],
    );

    this.logger.log(`Payment ${txId} recorded for invoice ${dto.invoiceId} by ${recordedBy}: $${dto.amount}`);

    const payment = result[0];
    if (!payment) {
      throw new InternalServerErrorException(`Payment insert did not return a row for invoice ${dto.invoiceId}`);
    }

    return mapPaymentOverview(payment);
  }

  /**
   * Refund a payment (full or partial)
   */
  async refundPayment(
    dto: RefundPaymentDto,
    refundedBy: string,
  ): Promise<PaymentOverview> {
    // Verify payment exists
    const paymentResult = await this.dataSource.query<PaymentRefundSourceRow[]>(
      `SELECT id, tenant_id as "tenantId", invoice_id as "invoiceId", amount, refunded_amount as "refundedAmount", status
       FROM billing.payments WHERE id = $1`,
      [dto.paymentId],
    );

    const payment = paymentResult[0];
    if (!payment) {
      throw new NotFoundException(`Payment not found: ${dto.paymentId}`);
    }

    const originalAmount = dbNumber(payment.amount);
    const alreadyRefunded = dbNumber(payment.refundedAmount);
    const maxRefundable = originalAmount - alreadyRefunded;

    if (dto.amount <= 0) {
      throw new BadRequestException('Refund amount must be positive');
    }

    if (dto.amount > maxRefundable) {
      throw new BadRequestException(
        `Refund amount ($${dto.amount}) exceeds refundable amount ($${maxRefundable})`,
      );
    }

    const newRefundedAmount = alreadyRefunded + dto.amount;
    const isFullyRefunded = Math.abs(newRefundedAmount - originalAmount) < 0.01;

    // Update payment with refund
    const refundInfo = {
      amount: dto.amount,
      reason: dto.reason,
      refundedAt: new Date().toISOString(),
    };

    await this.dataSource.query(
      `
      UPDATE billing.payments SET
        refunded_amount = $1,
        status = $2,
        refunds = COALESCE(refunds, '[]'::jsonb) || $3::jsonb,
        "updatedAt" = NOW()
      WHERE id = $4
      `,
      [
        newRefundedAmount,
        isFullyRefunded ? 'refunded' : 'partially_refunded',
        JSON.stringify(refundInfo),
        dto.paymentId,
      ],
    );

    // Update invoice to reflect refund
    await this.dataSource.query(
      `
      UPDATE billing.invoices SET
        amount_paid = GREATEST(0, amount_paid - $1),
        amount_due = LEAST(total, amount_due + $1),
        status = CASE
          WHEN amount_paid - $1 <= 0 THEN 'refunded'
          ELSE 'partially_paid'
        END,
        "updatedAt" = NOW()
      WHERE id = $2
      `,
      [dto.amount, payment.invoiceId],
    );

    this.logger.log(
      `Refund of $${dto.amount} processed for payment ${dto.paymentId} by ${refundedBy}: ${dto.reason}`,
    );

    // Return updated payment
    const updated = await this.dataSource.query<PaymentOverviewRow[]>(
      `SELECT
        id, tenant_id as "tenantId", transaction_id as "transactionId",
        invoice_id as "invoiceId", amount, currency, status,
        payment_method as "paymentMethod", payment_date as "paymentDate",
        processed_at as "processedAt", failure_reason as "failureReason",
        refunded_amount as "refundedAmount", notes,
        "createdAt", "updatedAt", created_by as "createdBy"
      FROM billing.payments WHERE id = $1`,
      [dto.paymentId],
    );

    const updatedPayment = updated[0];
    if (!updatedPayment) {
      throw new InternalServerErrorException(`Refund update did not return payment ${dto.paymentId}`);
    }

    return mapPaymentOverview(updatedPayment);
  }
}
