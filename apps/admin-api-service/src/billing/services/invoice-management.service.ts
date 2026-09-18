import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

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

type DbNumeric = number | string | null | undefined;

interface CountRow {
  count: DbNumeric;
}

type InvoiceOverviewRow = Omit<InvoiceOverview, 'amount' | 'amountPaid' | 'amountDue'> & {
  amount: DbNumeric;
  amountPaid: DbNumeric;
  amountDue: DbNumeric;
};

interface InvoiceTotalsRow {
  count: DbNumeric;
  totalAmount: DbNumeric;
  totalPaid: DbNumeric;
}

interface InvoiceStatusRow {
  status: string;
  count: DbNumeric;
  amount: DbNumeric;
}

interface InvoiceCurrencyRow {
  currency: string;
  amount: DbNumeric;
}

interface InvoicePaymentTimeRow {
  avgDays: DbNumeric;
}

interface InvoiceThisMonthRow {
  paid: DbNumeric;
  pending: DbNumeric;
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

function mapInvoiceOverview(row: InvoiceOverviewRow): InvoiceOverview {
  return {
    ...row,
    amount: dbNumber(row.amount),
    amountPaid: dbNumber(row.amountPaid),
    amountDue: dbNumber(row.amountDue),
  };
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
      LEFT JOIN auth.tenants t ON t.id = i.tenant_id
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
      query += ` AND i.tenant_id = $${paramIndex}::uuid`;
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
    const countResult = await this.dataSource.query<CountRow[]>(countQuery, params);
    const total = dbNumber(countResult[0]?.count);

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

    const invoices = await this.dataSource.query<InvoiceOverviewRow[]>(query, params);

    return { invoices: invoices.map(mapInvoiceOverview), total };
  }

  /**
   * Get invoice by ID
   */
  async getInvoiceById(invoiceId: string): Promise<InvoiceOverview | null> {
    const result = await this.dataSource.query<InvoiceOverviewRow[]>(
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
      LEFT JOIN auth.tenants t ON t.id = i.tenant_id
      WHERE i.id = $1
    `,
      [invoiceId],
    );

    const invoice = result[0];
    return invoice ? mapInvoiceOverview(invoice) : null;
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
        this.dataSource.query<InvoiceTotalsRow[]>(`
          SELECT
            COUNT(*) as count,
            COALESCE(SUM(total), 0) as "totalAmount",
            COALESCE(SUM(amount_paid), 0) as "totalPaid"
          FROM billing.invoices
        `),

        // By status
        this.dataSource.query<InvoiceStatusRow[]>(`
          SELECT
            status,
            COUNT(*) as count,
            COALESCE(SUM(total), 0) as amount
          FROM billing.invoices
          GROUP BY status
        `),

        // By currency
        this.dataSource.query<InvoiceCurrencyRow[]>(`
          SELECT
            currency,
            COALESCE(SUM(total), 0) as amount
          FROM billing.invoices
          GROUP BY currency
        `),

        // Average payment time
        this.dataSource.query<InvoicePaymentTimeRow[]>(`
          SELECT
            AVG(EXTRACT(EPOCH FROM (paid_at - issue_date)) / 86400) as "avgDays"
          FROM billing.invoices
          WHERE status = 'paid' AND paid_at IS NOT NULL
        `),

        // This month stats
        this.dataSource.query<InvoiceThisMonthRow[]>(`
          SELECT
            COALESCE(SUM(CASE WHEN status = 'paid' THEN total ELSE 0 END), 0) as paid,
            COALESCE(SUM(CASE WHEN status IN ('pending', 'sent') THEN total ELSE 0 END), 0) as pending
          FROM billing.invoices
          WHERE issue_date >= DATE_TRUNC('month', CURRENT_DATE)
        `),
      ]);

    // Process total results
    const totalInvoices = dbNumber(totalResult[0]?.count);
    const totalAmount = dbNumber(totalResult[0]?.totalAmount);
    const totalPaid = dbNumber(totalResult[0]?.totalPaid);

    // Process status results
    const byStatus: Record<string, { count: number; amount: number }> = {};
    let totalPending = 0;
    let totalOverdue = 0;

    for (const row of statusResult) {
      byStatus[row.status] = {
        count: dbNumber(row.count),
        amount: dbNumber(row.amount),
      };
      if (row.status === 'pending' || row.status === 'sent') {
        totalPending += dbNumber(row.amount);
      }
      if (row.status === 'overdue') {
        totalOverdue += dbNumber(row.amount);
      }
    }

    // Process currency results
    const byCurrency: Record<string, number> = {};
    for (const row of currencyResult) {
      byCurrency[row.currency] = dbNumber(row.amount);
    }

    // Process payment time
    const avgPaymentTime = dbNumber(paymentTimeResult[0]?.avgDays);

    // Overdue rate
    const overdueCount = byStatus['overdue']?.count || 0;
    const overdueRate = totalInvoices > 0 ? (overdueCount / totalInvoices) * 100 : 0;

    // Process this month stats
    const paidThisMonth = dbNumber(thisMonthResult[0]?.paid);
    const pendingThisMonth = dbNumber(thisMonthResult[0]?.pending);

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
   * Get overdue invoices
   */
  async getOverdueInvoices(): Promise<InvoiceOverview[]> {
    const result = await this.getInvoices({ status: [InvoiceStatus.OVERDUE], limit: 100 });
    return result.invoices;
  }
}
