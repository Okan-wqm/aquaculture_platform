import {
  ConflictException,
  Injectable,
  Logger,
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
      // Operator-facing free-text: match the human-readable invoice NUMBER
      // (via the invoices join) as well as transaction id / notes, so typing an
      // `INV-…` value or a partial string returns rows instead of erroring.
      conditions.push(
        `(p.transaction_id ILIKE $${paramIndex} OR p.notes ILIKE $${paramIndex} OR i.invoice_number ILIKE $${paramIndex})`,
      );
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

    // The invoices join must be present on the count query too, so a
    // search that matches i.invoice_number filters the total consistently
    // with the page query below (each payment has 0-or-1 invoice, so the
    // LEFT JOIN never changes the payment row count).
    const countQuery = `SELECT COUNT(*) as count FROM billing.payments p LEFT JOIN billing.invoices i ON i.id = p.invoice_id ${whereClause}`;
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
  recordPayment(
    dto: RecordPaymentDto,
    recordedBy: string,
  ): never {
    void dto;
    void recordedBy;
    throw new ConflictException(
      'Payment recording is billing-service-owned. Use BillingAdminCommandClientService.recordPayment.',
    );
  }

  /**
   * Refund a payment (full or partial)
   */
  refundPayment(
    dto: RefundPaymentDto,
    refundedBy: string,
  ): never {
    void dto;
    void refundedBy;
    throw new ConflictException(
      'Payment refund is billing-service-owned. Use BillingAdminCommandClientService.refundPayment.',
    );
  }
}
