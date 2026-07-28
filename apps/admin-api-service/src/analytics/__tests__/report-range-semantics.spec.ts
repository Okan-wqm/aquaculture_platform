/**
 * APA-140 — a report must honour the window it accepts, or not accept one.
 *
 * The Generate modal collected a start and end date for every report type, the
 * DTO validated them, the execution row persisted them and the cache key
 * included them — and then five of the seven generators took `_request` and
 * never read the window. A user asking for "tenant overview, last week"
 * received all-time data labelled with their chosen range. The `_request`
 * underscore idiom satisfies `no-unused-vars`, so ignoring the range was
 * lint-clean and therefore invisible, and the range-bearing cache key masked it
 * further by serving separately-cached IDENTICAL data per window.
 *
 * This spec is the detection gate the class never had. It parameterises over
 * `REPORT_TYPES` — the runtime SSoT — so a NEW report type enrols in it
 * automatically; there is no allowlist to add yourself to and no per-type spec
 * to forget. Each type must satisfy exactly one of:
 *
 *   * it rejects as `ReportDataSourceUnavailableException` — no data source, so
 *     no window applies; or
 *   * it is declared `'ranged'` and its output genuinely VARIES across two
 *     different windows; or
 *   * it is declared `'point_in_time'` and its output is IDENTICAL across them.
 *
 * The last arm is what keeps `'point_in_time'` from becoming a rubber stamp for
 * the original defect: declaring it for a report whose rows do move fails just
 * as loudly as ignoring a range you accepted.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-140
 */
import { Test, TestingModule } from '@nestjs/testing';

import { ReportsController } from '../controllers/reports.controller';
import {
  REPORT_RANGE_SEMANTICS,
  REPORT_TYPES,
  ReportRequest,
  ReportType,
} from '../entities/analytics-snapshot.entity';
import { InvoiceReadOnly, InvoiceStatus } from '../entities/external/invoice.entity';
import { ReportDataSourceUnavailableException, ReportsService } from '../services/reports.service';

import {
  NOTHING_MEASURED,
  buildReportsHarness,
  tenantFixture,
} from './support/reports-service-harness';

/** Two windows a month apart, so a range-honouring report cannot coincide. */
interface Window {
  readonly startDate: Date;
  readonly endDate: Date;
}

const EARLY: Window = {
  startDate: new Date('2026-01-01T00:00:00.000Z'),
  endDate: new Date('2026-01-31T00:00:00.000Z'),
};
const LATE: Window = {
  startDate: new Date('2026-06-01T00:00:00.000Z'),
  endDate: new Date('2026-06-30T00:00:00.000Z'),
};

/** One invoice due inside each window, so a report that applies its `dueDate`
 *  filter returns a different row per window. */
function invoiceFixture(id: string, dueDate: Date): InvoiceReadOnly {
  const invoice = new InvoiceReadOnly();
  invoice.id = id;
  invoice.tenantId = '00000000-0000-4000-8000-000000000001';
  invoice.invoiceNumber = `INV-${id}`;
  invoice.subscriptionId = null;
  invoice.status = InvoiceStatus.PENDING;
  invoice.subtotal = 100;
  invoice.total = 100;
  invoice.amountPaid = 0;
  invoice.amountDue = 100;
  invoice.currency = 'USD';
  invoice.issueDate = dueDate;
  invoice.dueDate = dueDate;
  return invoice;
}

const INVOICES = [
  invoiceFixture('inv-early', new Date('2026-01-15T00:00:00.000Z')),
  invoiceFixture('inv-late', new Date('2026-06-15T00:00:00.000Z')),
];

/**
 * A raw-query result that carries one snapshot row inside EACH window, so a
 * range-honouring generator returns a different day per window while a
 * range-ignoring one returns the same rows twice.
 */
function snapshotsFor(window: Window): unknown {
  const day = window.startDate.toISOString().substring(0, 10);
  return [
    {
      snapshotDate: day,
      metrics: {
        uptimePercent: 97.5,
        avgResponseTimeMs: 12,
        errorRate: 2,
        apiCallsToday: 7,
        activeConnections: 3,
      },
    },
  ];
}

/**
 * Runs one report over one window, or reports that it has no data source.
 *
 * `null` means "unavailable", which is a legitimate outcome for a type with no
 * producer and short-circuits the variance question.
 */
async function runOver(type: ReportType, window: Window): Promise<string | null> {
  const { service } = await buildReportsHarness({
    // The platform's REAL usage state: no producer is wired, so both usage
    // reports short-circuit as unavailable and the window is moot for them.
    // The day a telemetry producer lands they become producible, this gate
    // starts asserting their variance, and it turns red unless the window is
    // plumbed in with the producer — which is exactly when it must be.
    usage: NOTHING_MEASURED,
    tenants: [tenantFixture(1), tenantFixture(2)],
    invoices: INVOICES,
    rawQueryRows: snapshotsFor(window),
  });

  try {
    const request: ReportRequest = { type, format: 'json', ...window };
    const result = await service.generateReport(request);
    return JSON.stringify({ data: result.data, summary: result.summary });
  } catch (error) {
    if (error instanceof ReportDataSourceUnavailableException) {
      return null;
    }
    throw error;
  }
}

describe('report range semantics (APA-140)', () => {
  it('declares range semantics for every report type', () => {
    // Exhaustive by construction — `Record<ReportType, …>` makes a missing
    // entry a compile error. Asserted at runtime too so the SSoT array and the
    // map cannot drift if either is ever widened dynamically.
    expect(Object.keys(REPORT_RANGE_SEMANTICS).sort()).toEqual([...REPORT_TYPES].sort());
  });

  it.each([...REPORT_TYPES])('%s honours its declared range semantics', async (type) => {
    const early = await runOver(type, EARLY);
    const late = await runOver(type, LATE);

    if (early === null || late === null) {
      // No data source: the window is moot, and both windows must agree that
      // it is moot rather than one of them quietly producing something.
      expect(early).toBeNull();
      expect(late).toBeNull();
      return;
    }

    if (REPORT_RANGE_SEMANTICS[type] === 'ranged') {
      // The defect in one assertion: a generator that accepts a window and
      // never reads it returns byte-identical output for two different months.
      expect(early).not.toEqual(late);
    } else {
      // And its mirror: declaring 'point_in_time' for something that does move
      // is the same lie told the other way round.
      expect(early).toEqual(late);
    }
  });

  describe('the API boundary', () => {
    // A stub service: these cases are about what the controller REFUSES to
    // pass on, so the service must never be reached for a rejected request.
    // Resolved through Nest rather than constructed with a cast — the DI
    // container is what supplies the collaborator in production too.
    const generateReport = jest.fn();
    const executeReport = jest.fn();
    let controller: ReportsController;

    beforeEach(async () => {
      generateReport.mockReset();
      executeReport.mockReset();

      const module: TestingModule = await Test.createTestingModule({
        controllers: [ReportsController],
        providers: [{ provide: ReportsService, useValue: { generateReport, executeReport } }],
      }).compile();

      controller = module.get(ReportsController);
    });

    it('rejects a window supplied for a report that describes current state', async () => {
      // Silently discarding it is the defect itself: the caller believes it
      // scoped the report and the answer says otherwise. 400 moves the
      // disagreement to where the caller can see it.
      await expect(
        controller.generateReport({
          type: 'tenant_overview',
          format: 'json',
          startDate: '2026-01-01',
          endDate: '2026-01-31',
        }),
      ).rejects.toThrow(/covers no date range/i);

      expect(generateReport).not.toHaveBeenCalled();
    });

    it('rejects a missing window for a report the window selects', async () => {
      // The mirror: defaulting silently to "the last 30 days" is the same
      // class of unstated scope.
      await expect(
        controller.generateReport({ type: 'system_performance', format: 'json' }),
      ).rejects.toThrow(/startDate and endDate are required/i);

      expect(generateReport).not.toHaveBeenCalled();
    });

    it('accepts a point-in-time report with no window', async () => {
      await controller.generateReport({ type: 'tenant_overview', format: 'json' });

      expect(generateReport).toHaveBeenCalledWith(
        expect.objectContaining({ startDate: undefined, endDate: undefined }),
      );
    });

    it('applies the same rule to an ad-hoc execution', async () => {
      await expect(
        controller.createExecution(
          {
            reportType: 'tenant_overview',
            format: 'json',
            startDate: '2026-01-01',
            endDate: '2026-01-31',
          },
          {},
        ),
      ).rejects.toThrow(/covers no date range/i);

      expect(executeReport).not.toHaveBeenCalled();
    });
  });

  it('keys the cache by the window only for reports the window selects', async () => {
    // A point-in-time report keyed by the range fragmented the cache into
    // per-window entries holding identical data, which is what hid the ignored
    // range from anyone comparing two runs.
    const { service, redis } = await buildReportsHarness({
      tenants: [tenantFixture(1)],
    });

    await service.generateReport({ type: 'tenant_overview', format: 'json', ...EARLY });
    await service.generateReport({ type: 'tenant_overview', format: 'json', ...LATE });

    const keys: string[] = redis.getJson.mock.calls.map((call) => String(call[0]));
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toContain('point-in-time');
  });

  it('records no window on an execution whose report ignores one', async () => {
    // Persisting the range would repeat in the history list the same claim the
    // modal used to make in the form.
    const { service } = await buildReportsHarness({ tenants: [tenantFixture(1)] });

    const execution = await service.executeReport({
      reportType: 'tenant_overview',
      format: 'json',
      startDate: EARLY.startDate,
      endDate: EARLY.endDate,
    });

    expect(execution.startDate).toBeUndefined();
    expect(execution.endDate).toBeUndefined();
  });

  it('records the window on an execution whose report selects by it', async () => {
    const { service } = await buildReportsHarness({
      rawQueryRows: snapshotsFor(EARLY),
    });

    const execution = await service.executeReport({
      reportType: 'system_performance',
      format: 'json',
      startDate: EARLY.startDate,
      endDate: EARLY.endDate,
    });

    expect(execution.startDate).toEqual(EARLY.startDate);
    expect(execution.endDate).toEqual(EARLY.endDate);
  });
});
