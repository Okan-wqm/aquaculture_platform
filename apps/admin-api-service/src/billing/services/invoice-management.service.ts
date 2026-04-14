import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, Between, LessThanOrEqual, MoreThanOrEqual, In } from 'typeorm';

import { InvoiceReadOnly, InvoiceStatus } from '../../analytics/entities/external/invoice.entity';

/**
 * SECURITY: Sanitize search string for LIKE queries
 * Escapes SQL wildcards to prevent pattern injection attacks
 */
function sanitizeSearchString(search: string, maxLength = 100): string {
  if (!search) return '';

  // Truncate to max length
  let sanitized = search.slice(0, maxLength);

  // Escape SQL LIKE special characters: %, _, and \
  sanitized = sanitized.replace(/[%_\\]/g, (char) => `\\${char}`);

  // Remove null bytes (potential injection vector)
  sanitized = sanitized.replace(/\0/g, '');

  // Trim whitespace
  return sanitized.trim();
}

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
    // billing.invoices uses snake_case column names (owned by billing-service)
    let query = `
      SELECT
        i.id,
        i.invoice_number as "invoiceNumber",
        i.tenant_id as "tenantId",
        t.name as "tenantName",
        t."contactEmail" as "tenantEmail",
        i.total as amount,
        i.amount_paid as "amountPaid",
        i.amount_due as "amountDue",
        i.status,
        i.currency,
        i.due_date as "dueDate",
        i.paid_at as "paidAt",
        i.issue_date as "issueDate",
        i.period_start as "periodStart",
        i.period_end as "periodEnd",
        i."createdAt" as "createdAt"
      FROM billing.invoices i
      LEFT JOIN auth.tenants t ON t.id::text = i.tenant_id
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
      query += ` AND i.tenant_id = $${paramIndex}`;
      params.push(filters.tenantId);
      paramIndex++;
    }

    if (filters.search) {
      // SECURITY: Sanitize search string to escape SQL wildcards (%, _, \)
      // This prevents pattern injection attacks where user input could
      // manipulate the LIKE clause behavior
      const sanitizedSearch = sanitizeSearchString(filters.search);
      if (sanitizedSearch) {
        query += ` AND (i.invoice_number ILIKE $${paramIndex} OR t.name ILIKE $${paramIndex}) ESCAPE '\\'`;
        params.push(`%${sanitizedSearch}%`);
        paramIndex++;
      }
    }

    if (filters.dateFrom) {
      query += ` AND i.issue_date >= $${paramIndex}`;
      params.push(filters.dateFrom);
      paramIndex++;
    }

    if (filters.dateTo) {
      query += ` AND i.issue_date <= $${paramIndex}`;
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
        i.invoice_number as "invoiceNumber",
        i.tenant_id as "tenantId",
        t.name as "tenantName",
        t."contactEmail" as "tenantEmail",
        i.total as amount,
        i.amount_paid as "amountPaid",
        i.amount_due as "amountDue",
        i.status,
        i.currency,
        i.due_date as "dueDate",
        i.paid_at as "paidAt",
        i.issue_date as "issueDate",
        i.period_start as "periodStart",
        i.period_end as "periodEnd",
        i."createdAt" as "createdAt"
      FROM billing.invoices i
      LEFT JOIN auth.tenants t ON t.id::text = i.tenant_id
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
    // Execute all 5 independent queries in parallel
    // billing.invoices uses snake_case column names (owned by billing-service)
    const [totalResult, statusResult, currencyResult, paymentTimeResult, thisMonthResult] =
      await Promise.all([
        // Total invoices and amounts
        this.dataSource.query(`
          SELECT
            COUNT(*) as count,
            COALESCE(SUM(total), 0) as "totalAmount",
            COALESCE(SUM(amount_paid), 0) as "totalPaid"
          FROM billing.invoices
        `),

        // By status
        this.dataSource.query(`
          SELECT
            status,
            COUNT(*) as count,
            COALESCE(SUM(total), 0) as amount
          FROM billing.invoices
          GROUP BY status
        `),

        // By currency
        this.dataSource.query(`
          SELECT
            currency,
            COALESCE(SUM(total), 0) as amount
          FROM billing.invoices
          GROUP BY currency
        `),

        // Average payment time
        this.dataSource.query(`
          SELECT
            AVG(EXTRACT(EPOCH FROM (paid_at - issue_date)) / 86400) as "avgDays"
          FROM billing.invoices
          WHERE status = 'paid' AND paid_at IS NOT NULL
        `),

        // This month stats
        this.dataSource.query(`
          SELECT
            COALESCE(SUM(CASE WHEN status = 'paid' THEN total ELSE 0 END), 0) as paid,
            COALESCE(SUM(CASE WHEN status IN ('pending', 'sent') THEN total ELSE 0 END), 0) as pending
          FROM billing.invoices
          WHERE issue_date >= DATE_TRUNC('month', CURRENT_DATE)
        `),
      ]);

    // Process total results
    const totalInvoices = parseInt(totalResult[0]?.count || '0', 10);
    const totalAmount = parseFloat(totalResult[0]?.totalAmount || '0');
    const totalPaid = parseFloat(totalResult[0]?.totalPaid || '0');

    // Process status results
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

    // Process currency results
    const byCurrency: Record<string, number> = {};
    for (const row of currencyResult) {
      byCurrency[row.currency] = parseFloat(row.amount);
    }

    // Process payment time
    const avgPaymentTime = parseFloat(paymentTimeResult[0]?.avgDays || '0');

    // Overdue rate
    const overdueCount = byStatus['overdue']?.count || 0;
    const overdueRate = totalInvoices > 0 ? (overdueCount / totalInvoices) * 100 : 0;

    // Process this month stats
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
      UPDATE billing.invoices SET
        status = $1,
        "updatedAt" = NOW()
      WHERE id = $2
    `,
      [InvoiceStatus.VOID, invoiceId],
    );

    // Log the void action
    await this.dataSource.query(
      `
      INSERT INTO admin.audit_logs (
        id, action, "entityType", "entityId", "tenantId",
        "performedBy", details, "createdAt"
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
      UPDATE billing.invoices SET
        status = 'overdue',
        "updatedAt" = NOW()
      WHERE status IN ('pending', 'sent')
        AND due_date < NOW()
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
