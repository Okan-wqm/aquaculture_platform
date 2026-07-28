/**
 * APA-143 — the system_performance report must never invent metrics.
 *
 * When no system snapshots existed for the range, generatePerformanceReport
 * emitted a per-day row with hardcoded `avgResponseTime: 45`, `errorRate: 0.1`
 * and `uptime: 99.9` ("Default estimate" / "Default uptime since we don't track
 * downtime"), and proxied `shared.audit_logs` row counts as `apiCalls`. A
 * SUPER_ADMIN reading the report saw a healthy-looking system that had never
 * been measured — the RC-8 fabricated-metrics class (same class as APA-240).
 * It also coalesced a missing `uptimePercent` to 99.9 on the snapshot path.
 *
 * Absence is now structural: unmeasured is `null`, and `summary.coverage`
 * states what fraction of days were actually measured.
 *
 * APA-142 then went further for the TOTAL absence case: a range with zero
 * measured days produces no report at all, because a table of all-null rows is
 * exactly as unmeasured as no rows and would still have earned a sha256 and a
 * 7-day download link. So the fabrication guards below run over a PARTIALLY
 * measured range — the case where a constant could still creep back into the
 * gap days — and total absence is asserted as a rejection.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-143
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-142
 */
import { ReportRequest } from '../entities/analytics-snapshot.entity';
import { ReportDataSourceUnavailableException } from '../services/reports.service';

import { buildReportsHarness } from './support/reports-service-harness';

/** The retired fabrication constants — none may reappear in any output. */
const RETIRED_CONSTANTS = [45, 0.1, 99.9];

interface PerfRow {
  date: string;
  avgResponseTime: number | null;
  errorRate: number | null;
  uptime: number | null;
  apiCalls: number | null;
  activeConnections: number | null;
}

/** Every metric field a performance row must carry. */
const METRIC_FIELDS = [
  'avgResponseTime',
  'errorRate',
  'uptime',
  'apiCalls',
  'activeConnections',
] as const;

/**
 * `ReportResult.data` is `unknown` by contract, so narrow it by VERIFYING the
 * shape rather than asserting it — a cast would hide exactly the drift this
 * spec exists to catch.
 */
function isPerfRows(value: unknown): value is PerfRow[] {
  return (
    Array.isArray(value) &&
    value.every((row) => {
      if (typeof row !== 'object' || row === null) return false;
      const candidate = row as Record<string, unknown>;
      if (typeof candidate['date'] !== 'string') return false;
      return METRIC_FIELDS.every(
        (f) => candidate[f] === null || typeof candidate[f] === 'number',
      );
    })
  );
}

describe('system_performance report integrity (APA-143, APA-142)', () => {
  const range: ReportRequest = {
    type: 'system_performance',
    format: 'json',
    startDate: new Date('2026-06-01T00:00:00.000Z'),
    endDate: new Date('2026-06-03T00:00:00.000Z'),
  };

  /** One measured day inside the three-day range, so the other two are gaps —
   *  the shape in which a fabricated constant could still reappear. */
  const ONE_MEASURED_DAY = [
    {
      snapshotDate: '2026-06-01',
      metrics: {
        uptimePercent: 97.5,
        avgResponseTimeMs: 12,
        errorRate: 2,
        apiCallsToday: 7,
        activeConnections: 3,
      },
    },
  ];

  async function runReport(
    rawQueryRows: unknown,
  ): Promise<{ data: PerfRow[]; summary: Record<string, unknown>; rawQuery: jest.Mock }> {
    const { service, rawQuery } = await buildReportsHarness({ rawQueryRows });
    const result = await service.generateReport(range);

    // Verified narrowing, not assertion: if the wire shape ever drifts, this
    // fails loudly here instead of silently mistyping the assertions below.
    if (!isPerfRows(result.data)) {
      throw new Error(
        `generateReport returned a non-PerformanceReportRow[] payload: ${JSON.stringify(result.data)}`,
      );
    }
    return { data: result.data, summary: result.summary ?? {}, rawQuery };
  }

  it('leaves an unmeasured day null — never a retired constant — inside a measured range', async () => {
    const { data, summary } = await runReport(ONE_MEASURED_DAY);

    // The generator emits only the days it has snapshots for, so the gap is
    // visible as coverage rather than as invented rows. Whichever shape it
    // takes, no unmeasured metric may carry a number.
    expect(data.length).toBeGreaterThan(0);
    for (const row of data) {
      if (row.date === '2026-06-01') continue;
      expect(row.avgResponseTime).toBeNull();
      expect(row.errorRate).toBeNull();
      expect(row.uptime).toBeNull();
      expect(row.apiCalls).toBeNull();
      expect(row.activeConnections).toBeNull();
    }

    expect(summary['daysWithData']).toBe(1);
    expect(summary['avgUptime']).toBe(97.5);

    // No fabricated constant may survive anywhere in the payload.
    const numbers = JSON.stringify({ data, summary }).match(/-?\d+(\.\d+)?/g) ?? [];
    for (const retired of RETIRED_CONSTANTS) {
      expect(numbers.map(Number)).not.toContain(retired);
    }
  });

  it('produces no report at all when the whole range is unmeasured', async () => {
    // A table of all-null rows is exactly as unmeasured as no rows, and used to
    // earn a MinIO artifact, a sha256 and a 7-day link all the same (APA-142).
    const { service } = await buildReportsHarness({ rawQueryRows: [] });

    const generate = service.generateReport(range);

    await expect(generate).rejects.toBeInstanceOf(ReportDataSourceUnavailableException);
    await expect(generate).rejects.toMatchObject({
      unavailableReason: expect.stringContaining('no producer'),
    });
  });

  it('passes measured snapshot values through untouched (no 99.9 coalescing)', async () => {
    const { data, summary } = await runReport([
      {
        snapshotDate: '2026-06-01',
        metrics: { uptimePercent: 97.5, avgResponseTimeMs: 12, errorRate: 2, apiCallsToday: 7, activeConnections: 3 },
      },
      {
        snapshotDate: '2026-06-02',
        metrics: { uptimePercent: 98, avgResponseTimeMs: 14, errorRate: 1, apiCallsToday: 9, activeConnections: 5 },
      },
    ]);

    expect(data.map((r) => r.uptime)).toEqual([97.5, 98]);
    expect(summary['avgUptime']).toBe(97.75);
    expect(summary['coverage']).toBe(1);
  });

  it('never proxies audit-log row counts as API calls', async () => {
    const { rawQuery } = await runReport(ONE_MEASURED_DAY);

    const sqlSeen = rawQuery.mock.calls.map((c) => String(c[0]));
    expect(sqlSeen.some((sql) => /audit_logs/i.test(sql))).toBe(false);
  });
});
