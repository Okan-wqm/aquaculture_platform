import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
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
      conditions.push(`p.invoice_id = $${paramIndex}`);
      params.push(filters.invoiceId);
      paramIndex++;
    }

    if (filters.tenantId) {
      conditions.push(`p.tenant_id = $${paramIndex}`);
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
    const countResult = await this.dataSource.query(countQuery, params);
    const total = parseInt(countResult[0]?.count || '0', 10);

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

    const payments = await this.dataSource.query(query, [
      ...params,
      limit,
      offset,
    ]);

    return {
      payments: payments.map((p: Record<string, unknown>) => ({
        ...p,
        amount: typeof p.amount === 'string' ? parseFloat(p.amount) : p.amount,
        refundedAmount: typeof p.refundedAmount === 'string' ? parseFloat(p.refundedAmount as string) : (p.refundedAmount || 0),
      })),
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
    const invoice = await this.dataSource.query(
      'SELECT id, tenant_id as "tenantId", status, amount_due as "amountDue", total FROM billing.invoices WHERE id = $1',
      [dto.invoiceId],
    );

    if (!invoice || invoice.length === 0) {
      throw new NotFoundException(`Invoice not found: ${dto.invoiceId}`);
    }

    const inv = invoice[0];
    const amountDue = parseFloat(inv.amountDue?.toString() || '0');

    if (dto.amount <= 0) {
      throw new BadRequestException('Payment amount must be positive');
    }

    if (dto.amount > amountDue) {
      throw new BadRequestException(`Payment amount ($${dto.amount}) exceeds amount due ($${amountDue})`);
    }

    // Generate transaction ID
    const txId = `TXN-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

    // Insert payment record
    const result = await this.dataSource.query(
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
    const newAmountPaid = parseFloat(inv.total?.toString() || '0') - amountDue + dto.amount;
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
    return {
      ...payment,
      amount: typeof payment.amount === 'string' ? parseFloat(payment.amount) : payment.amount,
      refundedAmount: typeof payment.refundedAmount === 'string' ? parseFloat(payment.refundedAmount) : (payment.refundedAmount || 0),
    };
  }

  /**
   * Refund a payment (full or partial)
   */
  async refundPayment(
    dto: RefundPaymentDto,
    refundedBy: string,
  ): Promise<PaymentOverview> {
    // Verify payment exists
    const paymentResult = await this.dataSource.query(
      `SELECT id, tenant_id as "tenantId", invoice_id as "invoiceId", amount, refunded_amount as "refundedAmount", status
       FROM billing.payments WHERE id = $1`,
      [dto.paymentId],
    );

    if (!paymentResult || paymentResult.length === 0) {
      throw new NotFoundException(`Payment not found: ${dto.paymentId}`);
    }

    const payment = paymentResult[0];
    const originalAmount = parseFloat(payment.amount?.toString() || '0');
    const alreadyRefunded = parseFloat(payment.refundedAmount?.toString() || '0');
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
    const updated = await this.dataSource.query(
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

    const p = updated[0];
    return {
      ...p,
      amount: typeof p.amount === 'string' ? parseFloat(p.amount) : p.amount,
      refundedAmount: typeof p.refundedAmount === 'string' ? parseFloat(p.refundedAmount) : (p.refundedAmount || 0),
    };
  }
}
