/**
 * APA-138 — the payments report must read the billing SSoT, never synthesise it.
 *
 * `generatePaymentsReport` invented every row: one invoice per ACTIVE tenant,
 * priced from an in-code plan table, numbered `INV-${month}-${tenantId8}`,
 * dated the 1st of the current month, and stamped
 *
 *     const status = amount === 0 ? 'paid' : 'paid';
 *
 * — a literal tautology. Both arms produce `'paid'`, so the pending and overdue
 * branches beneath it were unreachable, `totalPending`/`totalOverdue` were
 * structurally `0`, and `collectionRate` was exactly 100% whenever any active
 * tenant existed. Real unpaid invoices were invisible on the one report a
 * SUPER_ADMIN uses to find them, and the report never touched
 * `billing.invoices` at all.
 *
 * `PaymentReportRow.status` being a bare `string` is what let the tautology
 * type-check; it is now the `InvoiceStatus` enum, so a hardcoded literal is a
 * compile error.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-138
 */
import { RedisService } from '@aquaculture/backend-common/redis';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AuditLogService } from '../../audit/audit.service';
import {
  AnalyticsSnapshot,
  ReportDefinition,
  ReportExecution,
  ReportRequest,
} from '../entities/analytics-snapshot.entity';
import { InvoiceReadOnly, InvoiceStatus } from '../entities/external/invoice.entity';
import { TenantReadOnly } from '../entities/external/tenant.entity';
import { UserReadOnly } from '../entities/external/user.entity';
import { AnalyticsService } from '../services/analytics.service';
import { ReportsService } from '../services/reports.service';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
/** Deliberately has no matching tenant row — the invoice must survive anyway. */
const TENANT_ORPHAN = '33333333-3333-4333-8333-333333333333';

function invoice(partial: Partial<InvoiceReadOnly> & { invoiceNumber: string }): InvoiceReadOnly {
  const base = new InvoiceReadOnly();
  Object.assign(base, {
    id: partial.invoiceNumber,
    tenantId: TENANT_A,
    subscriptionId: null,
    status: InvoiceStatus.PAID,
    subtotal: 100,
    total: 100,
    amountPaid: 100,
    amountDue: 0,
    currency: 'USD',
    issueDate: new Date('2026-06-01T00:00:00.000Z'),
    dueDate: new Date('2026-06-15T00:00:00.000Z'),
    paidAt: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    ...partial,
  });
  return base;
}

/**
 * One paid, one overdue, one partially paid, one void — the exact spread the
 * old tautology could not represent.
 */
const INVOICES: InvoiceReadOnly[] = [
  invoice({ invoiceNumber: 'INV-1001', tenantId: TENANT_A, status: InvoiceStatus.PAID, total: 300, amountDue: 0 }),
  invoice({
    invoiceNumber: 'INV-1002',
    tenantId: TENANT_B,
    status: InvoiceStatus.OVERDUE,
    total: 500,
    amountDue: 500,
    dueDate: new Date('2026-06-10T00:00:00.000Z'),
  }),
  invoice({
    invoiceNumber: 'INV-1003',
    tenantId: TENANT_ORPHAN,
    status: InvoiceStatus.PARTIALLY_PAID,
    total: 200,
    amountPaid: 50,
    amountDue: 150,
  }),
  invoice({ invoiceNumber: 'INV-1004', tenantId: TENANT_A, status: InvoiceStatus.VOID, total: 999, amountDue: 999 }),
];

const TENANTS = [
  { id: TENANT_A, name: 'Acme Aqua' },
  { id: TENANT_B, name: 'Blue Harvest' },
];

interface PaymentRow {
  invoiceId: string;
  tenantName: string;
  amount: number;
  amountDue: number;
  currency: string;
  dueDate: string;
  status: InvoiceStatus;
  daysPastDue: number;
}

/** Verified narrowing — a cast would hide the very drift this spec catches. */
function isPaymentRows(value: unknown): value is PaymentRow[] {
  return (
    Array.isArray(value) &&
    value.every((row) => {
      if (typeof row !== 'object' || row === null) return false;
      const c = row as Record<string, unknown>;
      return (
        typeof c['invoiceId'] === 'string' &&
        typeof c['tenantName'] === 'string' &&
        typeof c['amount'] === 'number' &&
        typeof c['amountDue'] === 'number' &&
        typeof c['dueDate'] === 'string' &&
        typeof c['status'] === 'string' &&
        typeof c['daysPastDue'] === 'number'
      );
    })
  );
}

async function buildService(invoices: InvoiceReadOnly[]): Promise<{
  service: ReportsService;
  invoiceFind: jest.Mock;
}> {
  const repo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const invoiceFind = jest.fn().mockResolvedValue(invoices);
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ReportsService,
      { provide: getRepositoryToken(AnalyticsSnapshot), useValue: repo },
      { provide: getRepositoryToken(TenantReadOnly), useValue: { ...repo, find: jest.fn().mockResolvedValue(TENANTS) } },
      { provide: getRepositoryToken(UserReadOnly), useValue: repo },
      { provide: getRepositoryToken(InvoiceReadOnly), useValue: { ...repo, find: invoiceFind } },
      { provide: getRepositoryToken(ReportDefinition), useValue: repo },
      { provide: getRepositoryToken(ReportExecution), useValue: repo },
      { provide: AnalyticsService, useValue: {} },
      { provide: AuditLogService, useValue: { log: jest.fn() } },
      {
        provide: DataSource,
        useValue: { query: jest.fn().mockResolvedValue([]), createQueryRunner: jest.fn() },
      },
      {
        provide: RedisService,
        useValue: {
          getJson: jest.fn().mockResolvedValue(null),
          setJson: jest.fn().mockResolvedValue(undefined),
        },
      },
    ],
  }).compile();
  return { service: module.get(ReportsService), invoiceFind };
}

const REQUEST: ReportRequest = {
  type: 'financial_payments',
  format: 'json',
  startDate: new Date('2026-06-01T00:00:00.000Z'),
  endDate: new Date('2026-06-30T23:59:59.999Z'),
};

async function run(invoices: InvoiceReadOnly[]): Promise<{
  rows: PaymentRow[];
  summary: Record<string, unknown>;
  invoiceFind: jest.Mock;
}> {
  const { service, invoiceFind } = await buildService(invoices);
  const result = await service.generateReport(REQUEST);
  if (!isPaymentRows(result.data)) {
    throw new Error(`payments report returned a non-PaymentReportRow[] payload: ${JSON.stringify(result.data)}`);
  }
  return { rows: result.data, summary: result.summary ?? {}, invoiceFind };
}

describe('payments report integrity (APA-138)', () => {
  it('reads real invoices from billing, with their real statuses', async () => {
    const { rows, invoiceFind } = await run(INVOICES);

    expect(invoiceFind).toHaveBeenCalledTimes(1);
    expect(rows.map((r) => r.invoiceId)).toEqual(['INV-1001', 'INV-1002', 'INV-1003', 'INV-1004']);

    // Not every row is 'paid' — the tautology could produce nothing else.
    expect(new Set(rows.map((r) => r.status))).toEqual(
      new Set([InvoiceStatus.PAID, InvoiceStatus.OVERDUE, InvoiceStatus.PARTIALLY_PAID, InvoiceStatus.VOID]),
    );

    // Invoice numbers come from billing, not from `INV-${month}-${tenantId8}`.
    for (const row of rows) {
      expect(row.invoiceId).not.toMatch(/^INV-\d{4}-\d{2}-/);
    }
  });

  it('surfaces outstanding and overdue money instead of a structural zero', async () => {
    const { summary } = await run(INVOICES);

    // Collected = paid portion of every invoice: 300 + 0 + 50 + 0.
    expect(summary['totalCollected']).toBe(350);
    // Outstanding excludes PAID and VOID: 500 (overdue) + 150 (partial).
    expect(summary['totalOutstanding']).toBe(650);
    // Overdue is its own bucket, and is no longer unreachable.
    expect(summary['totalOverdue']).toBe(500);
    expect(summary['overdueCount']).toBe(1);
    expect(summary['outstandingCount']).toBe(2);
    expect(summary['paidCount']).toBe(1);
  });

  it('reports a collection rate below 100% when money is outstanding', async () => {
    const { summary } = await run(INVOICES);

    // Billed excludes VOID: 300 + 500 + 200 = 1000; collected 350 -> 35%.
    expect(summary['collectionRate']).toBe(35);
    expect(summary['collectionRate']).not.toBe(100);
  });

  it('reports an undefined collection rate — not 0% — when nothing was billed', async () => {
    const { rows, summary } = await run([]);

    expect(rows).toEqual([]);
    expect(summary['totalInvoices']).toBe(0);
    // 0 would read as "we collected nothing"; there was nothing to collect.
    expect(summary['collectionRate']).toBeNull();
  });

  it('ages each open invoice from its own due date and never ages a settled one', async () => {
    const { rows } = await run(INVOICES);
    const byId = new Map(rows.map((r) => [r.invoiceId, r]));

    expect(byId.get('INV-1001')?.daysPastDue).toBe(0); // PAID
    expect(byId.get('INV-1004')?.daysPastDue).toBe(0); // VOID
    // Open invoices with different due dates must not share one age.
    const overdue = byId.get('INV-1002')?.daysPastDue ?? 0;
    const partial = byId.get('INV-1003')?.daysPastDue ?? 0;
    expect(overdue).toBeGreaterThan(0);
    expect(partial).toBeGreaterThan(0);
    expect(overdue).not.toBe(partial);
  });

  it('keeps an invoice whose tenant name cannot be resolved', async () => {
    const { rows } = await run(INVOICES);
    const byId = new Map(rows.map((r) => [r.invoiceId, r]));

    expect(byId.get('INV-1001')?.tenantName).toBe('Acme Aqua');
    // An unnamed invoice is still money owed — degrade to the id, never drop.
    expect(byId.get('INV-1003')?.tenantName).toBe(TENANT_ORPHAN);
  });
});
