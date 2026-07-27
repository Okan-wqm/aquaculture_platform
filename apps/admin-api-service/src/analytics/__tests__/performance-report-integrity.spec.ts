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
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-143
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
import { TenantReadOnly } from '../entities/external/tenant.entity';
import { UserReadOnly } from '../entities/external/user.entity';
import { AnalyticsService } from '../services/analytics.service';
import { ReportsService } from '../services/reports.service';

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

describe('system_performance report integrity (APA-143)', () => {
  let query: jest.Mock;

  async function buildService(): Promise<ReportsService> {
    const repo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      save: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: getRepositoryToken(AnalyticsSnapshot), useValue: repo },
        { provide: getRepositoryToken(TenantReadOnly), useValue: repo },
        { provide: getRepositoryToken(UserReadOnly), useValue: repo },
        { provide: getRepositoryToken(ReportDefinition), useValue: repo },
        { provide: getRepositoryToken(ReportExecution), useValue: repo },
        { provide: AnalyticsService, useValue: {} },
        { provide: AuditLogService, useValue: { log: jest.fn() } },
        { provide: DataSource, useValue: { query, createQueryRunner: jest.fn() } },
        {
          provide: RedisService,
          useValue: {
            getJson: jest.fn().mockResolvedValue(null),
            setJson: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();
    return module.get(ReportsService);
  }

  const range: ReportRequest = {
    type: 'system_performance',
    format: 'json',
    startDate: new Date('2026-06-01T00:00:00.000Z'),
    endDate: new Date('2026-06-03T00:00:00.000Z'),
  };

  async function runReport(): Promise<{ data: PerfRow[]; summary: Record<string, unknown> }> {
    const service = await buildService();
    const result = await service.generateReport(range);

    // Verified narrowing, not assertion: if the wire shape ever drifts, this
    // fails loudly here instead of silently mistyping the assertions below.
    if (!isPerfRows(result.data)) {
      throw new Error(
        `generateReport returned a non-PerformanceReportRow[] payload: ${JSON.stringify(result.data)}`,
      );
    }
    return { data: result.data, summary: result.summary ?? {} };
  }

  beforeEach(() => {
    query = jest.fn().mockResolvedValue([]);
  });

  it('emits null metrics — never the retired constants — when nothing was measured', async () => {
    const { data, summary } = await runReport();

    expect(data.length).toBeGreaterThan(0);
    for (const row of data) {
      expect(row.avgResponseTime).toBeNull();
      expect(row.errorRate).toBeNull();
      expect(row.uptime).toBeNull();
      expect(row.apiCalls).toBeNull();
      expect(row.activeConnections).toBeNull();
    }

    expect(summary['daysWithData']).toBe(0);
    expect(summary['coverage']).toBe(0);
    expect(summary['avgUptime']).toBeNull();
    expect(summary['avgResponseTime']).toBeNull();

    // No fabricated constant may survive anywhere in the payload.
    const numbers = JSON.stringify({ data, summary }).match(/-?\d+(\.\d+)?/g) ?? [];
    for (const retired of RETIRED_CONSTANTS) {
      expect(numbers.map(Number)).not.toContain(retired);
    }
  });

  it('passes measured snapshot values through untouched (no 99.9 coalescing)', async () => {
    query = jest.fn().mockResolvedValue([
      {
        snapshotDate: '2026-06-01',
        metrics: { uptimePercent: 97.5, avgResponseTimeMs: 12, errorRate: 2, apiCallsToday: 7, activeConnections: 3 },
      },
      {
        snapshotDate: '2026-06-02',
        metrics: { uptimePercent: 98, avgResponseTimeMs: 14, errorRate: 1, apiCallsToday: 9, activeConnections: 5 },
      },
    ]);

    const { data, summary } = await runReport();

    expect(data.map((r) => r.uptime)).toEqual([97.5, 98]);
    expect(summary['avgUptime']).toBe(97.75);
    expect(summary['coverage']).toBe(1);
  });

  it('never proxies audit-log row counts as API calls', async () => {
    await runReport();

    const sqlSeen = query.mock.calls.map((c) => String(c[0]));
    expect(sqlSeen.some((sql) => /audit_logs/i.test(sql))).toBe(false);
  });
});
