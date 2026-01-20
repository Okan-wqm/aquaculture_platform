import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, Between, LessThanOrEqual, MoreThanOrEqual, In } from 'typeorm';
import { InvoiceReadOnly, InvoiceStatus } from '../../analytics/entities/external/invoice.entity';

/**
 * Invoice overview for admin panel
 */
export interface InvoiceOverview {
  id: string;
  invoiceNumber: string;
  tenantId: string;
  tenantName: string;
  tenantEmail?: string;
  amount: number;
  amountPaid: number;
  amountDue: number;
  status: InvoiceStatus;
  currency: string;
  dueDate: Date;
  paidAt?: Date | null;
  issueDate: Date;
  periodStart: Date;
  periodEnd: Date;
  createdAt: Date;
}

/**
 * Invoice statistics
 */
export interface InvoiceStats {
  totalInvoices: number;
  totalAmount: number;
  totalPaid: number;
  totalPending: number;
  totalOverdue: number;
  byStatus: Record<string, { count: number; amount: number }>;
  byCurrency: Record<string, number>;
  avgPaymentTime: number; // days
  overdueRate: number; // percentage
  paidThisMonth: number;
  pendingThisMonth: number;
}

/**
 * Invoice filters
 */
export interface InvoiceFilters {
  status?: InvoiceStatus[];
  tenantId?: string;
  search?: string;
  dateFrom?: Date;
  dateTo?: Date;
  minAmount?: number;
  maxAmount?: number;
  overdueOnly?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Invoice Management Service
 * Handles invoice queries for admin panel
 */
@Injectable()
export class InvoiceManagementService {
  private readonly logger = new Logger(InvoiceManagementService.name);

  constructor(
    @InjectRepository(InvoiceReadOnly)
    private readonly invoiceRepo: Repository<InvoiceReadOnly>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Get all invoices with filters
   */
  async getInvoices(filters: InvoiceFilters = {}): Promise<{
    invoices: InvoiceOverview[];
    total: number;
  }> {
    let query = `
      SELECT
        i.id,
        i."invoiceNumber" as "invoiceNumber",
        i."tenantId" as "tenantId",
        t.name as "tenantName",
        t."contactEmail" as "tenantEmail",
        i.total as amount,
        i."amountPaid" as "amountPaid",
        i."amountDue" as "amountDue",
        i.status,
        i.currency,
        i."dueDate" as "dueDate",
        i."paidAt" as "paidAt",
        i."issueDate" as "issueDate",
        i."periodStart" as "periodStart",
        i."periodEnd" as "periodEnd",
        i."createdAt" as "createdAt"
      FROM public.invoices i
      LEFT JOIN public.tenants t ON t.id::text = i."tenantId"
      WHERE 1=1
    `;

    const params: unknown[] = [];
    let paramIndex = 1;

    if (filters.status && filters.status.length > 0) {
      query += ` AND i.status = ANY($${paramIndex})`;
      params.push(filters.status);
      paramIndex++;
    }

    if (filters.tenantId) {
      query += ` AND i."tenantId" = $${paramIndex}`;
      params.push(filters.tenantId);
      paramIndex++;
    }

    if (filters.search) {
      query += ` AND (i."invoiceNumber" ILIKE $${paramIndex} OR t.name ILIKE $${paramIndex})`;
      params.push(`%${filters.search}%`);
      paramIndex++;
    }

    if (filters.dateFrom) {
      query += ` AND i."issueDate" >= $${paramIndex}`;
      params.push(filters.dateFrom);
      paramIndex++;
    }

    if (filters.dateTo) {
      query += ` AND i."issueDate" <= $${paramIndex}`;
      params.push(filters.dateTo);
      paramIndex++;
    }

    if (filters.minAmount !== undefined) {
      query += ` AND i.total >= $${paramIndex}`;
      params.push(filters.minAmount);
      paramIndex++;
    }

    if (filters.maxAmount !== undefined) {
      query += ` AND i.total <= $${paramIndex}`;
      params.push(filters.maxAmount);
      paramIndex++;
    }

    if (filters.overdueOnly) {
      query += ` AND i.status = 'overdue'`;
    }

    // Get total count
    const countQuery = `SELECT COUNT(*) as count FROM (${query}) as subq`;
    const countResult = await this.dataSource.query(countQuery, params);
    const total = parseInt(countResult[0]?.count || '0', 10);

    // Add pagination
    query += ` ORDER BY i."createdAt" DESC`;
    if (filters.limit) {
      query += ` LIMIT $${paramIndex}`;
      params.push(filters.limit);
      paramIndex++;
    }
    if (filters.offset) {
      query += ` OFFSET $${paramIndex}`;
      params.push(filters.offset);
    }

    const invoices = await this.dataSource.query(query, params);

    return { invoices, total };
  }

  /**
   * Get invoice by ID
   */
  async getInvoiceById(invoiceId: string): Promise<InvoiceOverview | null> {
    const result = await this.dataSource.query(
      `
      SELECT
        i.id,
        i."invoiceNumber" as "invoiceNumber",
        i."tenantId" as "tenantId",
        t.name as "tenantName",
        t."contactEmail" as "tenantEmail",
        i.total as amount,
        i."amountPaid" as "amountPaid",
        i."amountDue" as "amountDue",
        i.status,
        i.currency,
        i."dueDate" as "dueDate",
        i."paidAt" as "paidAt",
        i."issueDate" as "issueDate",
        i."periodStart" as "periodStart",
        i."periodEnd" as "periodEnd",
        i."createdAt" as "createdAt"
      FROM public.invoices i
      LEFT JOIN public.tenants t ON t.id::text = i."tenantId"
      WHERE i.id = $1
    `,
      [invoiceId],
    );

    return result[0] || null;
  }

  /**
   * Get invoice statistics
   */
  async getStats(): Promise<InvoiceStats> {
    // Total invoices and amounts
    const totalResult = await this.dataSource.query(`
      SELECT
        COUNT(*) as count,
        COALESCE(SUM(total), 0) as "totalAmount",
        COALESCE(SUM("amountPaid"), 0) as "totalPaid"
      FROM public.invoices
    `);

    const totalInvoices = parseInt(totalResult[0]?.count || '0', 10);
    const totalAmount = parseFloat(totalResult[0]?.totalAmount || '0');
    const totalPaid = parseFloat(totalResult[0]?.totalPaid || '0');

    // By status
    const statusResult = await this.dataSource.query(`
      SELECT
        status,
        COUNT(*) as count,
        COALESCE(SUM(total), 0) as amount
      FROM public.invoices
      GROUP BY status
    `);

    const byStatus: Record<string, { count: number; amount: number }> = {};
    let totalPending = 0;
    let totalOverdue = 0;

    for (const row of statusResult) {
      byStatus[row.status] = {
        count: parseInt(row.count, 10),
        amount: parseFloat(row.amount),
      };
      if (row.status === 'pending' || row.status === 'sent') {
        totalPending += parseFloat(row.amount);
      }
      if (row.status === 'overdue') {
        totalOverdue += parseFloat(row.amount);
      }
    }

    // By currency
    const currencyResult = await this.dataSource.query(`
      SELECT
        currency,
        COALESCE(SUM(total), 0) as amount
      FROM public.invoices
      GROUP BY currency
    `);

    const byCurrency: Record<string, number> = {};
    for (const row of currencyResult) {
      byCurrency[row.currency] = parseFloat(row.amount);
    }

    // Average payment time
    const paymentTimeResult = await this.dataSource.query(`
      SELECT
        AVG(EXTRACT(EPOCH FROM ("paidAt" - "issueDate")) / 86400) as "avgDays"
      FROM public.invoices
      WHERE status = 'paid' AND "paidAt" IS NOT NULL
    `);
    const avgPaymentTime = parseFloat(paymentTimeResult[0]?.avgDays || '0');

    // Overdue rate
    const overdueCount = byStatus['overdue']?.count || 0;
    const overdueRate = totalInvoices > 0 ? (overdueCount / totalInvoices) * 100 : 0;

    // This month stats
    const thisMonthResult = await this.dataSource.query(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'paid' THEN total ELSE 0 END), 0) as paid,
        COALESCE(SUM(CASE WHEN status IN ('pending', 'sent') THEN total ELSE 0 END), 0) as pending
      FROM public.invoices
      WHERE "issueDate" >= DATE_TRUNC('month', CURRENT_DATE)
    `);

    const paidThisMonth = parseFloat(thisMonthResult[0]?.paid || '0');
    const pendingThisMonth = parseFloat(thisMonthResult[0]?.pending || '0');

    return {
      totalInvoices,
      totalAmount,
      totalPaid,
      totalPending,
      totalOverdue,
      byStatus,
      byCurrency,
      avgPaymentTime,
      overdueRate,
      paidThisMonth,
      pendingThisMonth,
    };
  }

  /**
   * Get tenant invoices
   */
  async getTenantInvoices(tenantId: string): Promise<InvoiceOverview[]> {
    const result = await this.getInvoices({ tenantId, limit: 100 });
    return result.invoices;
  }

  /**
   * Mark invoice as paid (admin action)
   */
  async markAsPaid(
    invoiceId: string,
    paidAmount: number,
    markedBy: string,
  ): Promise<{ success: boolean; invoice: InvoiceOverview }> {
    const invoice = await this.invoiceRepo.findOne({ where: { id: invoiceId } });
    if (!invoice) {
      throw new NotFoundException(`Invoice not found: ${invoiceId}`);
    }

    const newAmountPaid = parseFloat(invoice.amountPaid.toString()) + paidAmount;
    const newAmountDue = parseFloat(invoice.total.toString()) - newAmountPaid;
    const isPaidInFull = newAmountDue <= 0;

    await this.dataSource.query(
      `
      UPDATE public.invoices SET
        "amountPaid" = $1,
        "amountDue" = $2,
        status = $3,
        "paidAt" = $4,
        "updatedAt" = NOW()
      WHERE id = $5
    `,
      [
        newAmountPaid,
        Math.max(0, newAmountDue),
        isPaidInFull ? InvoiceStatus.PAID : InvoiceStatus.PARTIALLY_PAID,
        isPaidInFull ? new Date() : null,
        invoiceId,
      ],
    );

    this.logger.log(`Invoice ${invoice.invoiceNumber} marked as ${isPaidInFull ? 'paid' : 'partially paid'} by ${markedBy}`);

    const updatedInvoice = await this.getInvoiceById(invoiceId);
    return { success: true, invoice: updatedInvoice! };
  }

  /**
   * Void invoice (admin action)
   */
  async voidInvoice(
    invoiceId: string,
    reason: string,
    voidedBy: string,
  ): Promise<{ success: boolean }> {
    const invoice = await this.invoiceRepo.findOne({ where: { id: invoiceId } });
    if (!invoice) {
      throw new NotFoundException(`Invoice not found: ${invoiceId}`);
    }

    await this.dataSource.query(
      `
      UPDATE public.invoices SET
        status = $1,
        "updatedAt" = NOW()
      WHERE id = $2
    `,
      [InvoiceStatus.VOID, invoiceId],
    );

    // Log the void action
    await this.dataSource.query(
      `
      INSERT INTO public.audit_logs (
        id, action, "entityType", "entityId", "tenantId",
        "userId", changes, "createdAt"
      ) VALUES (
        gen_random_uuid(), 'INVOICE_VOIDED', 'invoice', $1, $2,
        $3, $4, NOW()
      )
    `,
      [
        invoiceId,
        invoice.tenantId,
        voidedBy,
        JSON.stringify({ reason, previousStatus: invoice.status }),
      ],
    );

    this.logger.log(`Invoice ${invoice.invoiceNumber} voided by ${voidedBy}: ${reason}`);

    return { success: true };
  }

  /**
   * Get overdue invoices
   */
  async getOverdueInvoices(): Promise<InvoiceOverview[]> {
    const result = await this.getInvoices({ status: [InvoiceStatus.OVERDUE], limit: 100 });
    return result.invoices;
  }

  /**
   * Update overdue status for invoices past due date
   */
  async updateOverdueStatus(): Promise<{ updated: number }> {
    const result = await this.dataSource.query(
      `
      UPDATE public.invoices SET
        status = 'overdue',
        "updatedAt" = NOW()
      WHERE status IN ('pending', 'sent')
        AND "dueDate" < NOW()
      RETURNING id
    `,
    );

    const updated = result.length;
    if (updated > 0) {
      this.logger.log(`Updated ${updated} invoices to overdue status`);
    }

    return { updated };
  }
}
