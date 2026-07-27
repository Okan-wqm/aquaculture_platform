/**
 * APA-130 — analytics trend endpoints must survive real snapshot rows.
 *
 * `AnalyticsSnapshot.snapshotDate` maps a PostgreSQL `date` column. TypeORM's
 * `PostgresDriver.prepareHydratedValue` normalizes that to a 'YYYY-MM-DD'
 * STRING (`DateUtils.mixedDateToDateString`) before any transformer runs, but
 * the entity declared the property as `Date`. The compiler therefore accepted
 * `s.snapshotDate.toISOString()` and `snapshot.snapshotDate.getFullYear()`, and
 * both threw `TypeError: ... is not a function` on the first row the daily cron
 * wrote — three SUPER_ADMIN trend endpoints that pass on an empty database and
 * 500 in production.
 *
 * These tests feed the repository the DRIVER-SHAPED value (a string, exactly
 * what pg returns) rather than a Date, so they reproduce production hydration.
 * A `Date`-typed entity cannot pass them.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-130
 */
import { RedisService } from '@aquaculture/backend-common/redis';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';

import { AuditLogService } from '../../audit/audit.service';
import { AnalyticsSnapshot, TenantMetrics } from '../entities/analytics-snapshot.entity';
import { InvoiceReadOnly } from '../entities/external/invoice.entity';
import { SubscriptionReadOnly } from '../entities/external/subscription.entity';
import { TenantReadOnly } from '../entities/external/tenant.entity';
import { UserReadOnly } from '../entities/external/user.entity';
import { AnalyticsService } from '../services/analytics.service';

/**
 * Rows shaped the way the pg driver actually delivers them: `snapshotDate` is a
 * plain 'YYYY-MM-DD' string. Typed as the loose row shape on purpose — the
 * point of the test is that the SERVICE must cope with this shape.
 */
interface DriverRow {
  snapshotDate: string;
  metrics: Record<string, number>;
}

/** Captures the parameters the service hands to the query builder. */
interface QueryBuilderCapture {
  readonly params: Record<string, unknown>;
}

/** The subset of the query-builder surface `getSnapshots`/`saveSnapshot` use. */
interface StubQueryBuilder {
  where(sql: string, params?: Record<string, unknown>): StubQueryBuilder;
  andWhere(sql: string, params?: Record<string, unknown>): StubQueryBuilder;
  orderBy(sql: string, direction?: string): StubQueryBuilder;
  getMany(): Promise<readonly DriverRow[]>;
  getOne(): Promise<DriverRow | null>;
}

function buildQueryBuilder(
  rows: readonly DriverRow[],
  capture: QueryBuilderCapture,
): StubQueryBuilder {
  const record = (params?: Record<string, unknown>): StubQueryBuilder => {
    Object.assign(capture.params, params ?? {});
    return qb;
  };
  const qb: StubQueryBuilder = {
    where: (_sql, params) => record(params),
    andWhere: (_sql, params) => record(params),
    orderBy: () => qb,
    getMany: () => Promise.resolve(rows),
    getOne: () => Promise.resolve(null),
  };
  return qb;
}

async function buildService(
  rows: readonly DriverRow[],
): Promise<{ service: AnalyticsService; capture: QueryBuilderCapture; saved: unknown[] }> {
  const capture: QueryBuilderCapture = { params: {} };
  const saved: unknown[] = [];
  const snapshotRepo = {
    createQueryBuilder: jest.fn(() => buildQueryBuilder(rows, capture)),
    findOne: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn((e: unknown) => e),
    save: jest.fn((e: unknown) => {
      saved.push(e);
      return Promise.resolve(e);
    }),
  };
  const plainRepo = { count: jest.fn().mockResolvedValue(0), find: jest.fn().mockResolvedValue([]) };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AnalyticsService,
      { provide: getRepositoryToken(AnalyticsSnapshot), useValue: snapshotRepo },
      { provide: getRepositoryToken(TenantReadOnly), useValue: plainRepo },
      { provide: getRepositoryToken(UserReadOnly), useValue: plainRepo },
      { provide: getRepositoryToken(SubscriptionReadOnly), useValue: plainRepo },
      { provide: getRepositoryToken(InvoiceReadOnly), useValue: plainRepo },
      { provide: AuditLogService, useValue: { log: jest.fn() } },
      { provide: getDataSourceToken(), useValue: { query: jest.fn().mockResolvedValue([{}]) } },
      { provide: RedisService, useValue: { getJson: jest.fn(), setJson: jest.fn() } },
    ],
  }).compile();

  return { service: module.get(AnalyticsService), capture, saved };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const TENANT_METRICS: TenantMetrics = {
  total: 1,
  active: 1,
  inactive: 0,
  trial: 0,
  suspended: 0,
  newThisMonth: 0,
  churnedThisMonth: 0,
  churnRate: 0,
  growthRate: 0,
  byPlan: {},
};

describe('AnalyticsService date-column hydration (APA-130)', () => {
  it('getTenantGrowthTrend survives driver-shaped rows and echoes the calendar date verbatim', async () => {
    const { service } = await buildService([
      { snapshotDate: '2026-07-01', metrics: { total: 10 } },
      { snapshotDate: '2026-07-02', metrics: { total: 12 } },
    ]);

    // Pre-fix this threw `TypeError: s.snapshotDate.toISOString is not a function`.
    const trend = await service.getTenantGrowthTrend({ period: 'day', dataPoints: 30 });

    expect(trend.data).toEqual([
      { date: '2026-07-01', value: 10 },
      { date: '2026-07-02', value: 12 },
    ]);
  });

  it('getUserActivityTrend survives driver-shaped rows', async () => {
    const { service } = await buildService([
      { snapshotDate: '2026-07-03', metrics: { activeLastDay: 42 } },
    ]);

    const trend = await service.getUserActivityTrend({ period: 'day', dataPoints: 7 });

    expect(trend.data).toEqual([{ date: '2026-07-03', value: 42 }]);
  });

  it('getRevenueTrendAnalytics groups by month without parsing the date', async () => {
    const { service } = await buildService([
      { snapshotDate: '2026-06-15', metrics: { mrr: 100 } },
      { snapshotDate: '2026-06-28', metrics: { mrr: 300 } },
      { snapshotDate: '2026-07-04', metrics: { mrr: 500 } },
    ]);

    // Pre-fix this threw on `snapshot.snapshotDate.getFullYear()`.
    const result = await service.getRevenueTrendAnalytics('3m');

    expect(result.data.map((d) => d.date)).toEqual(['2026-06', '2026-07']);
    // June averages its two snapshots; July has one. A Date round-trip would
    // also have risked bucketing 2026-06-28 into July in a UTC+ timezone.
    expect(result.data.map((d) => d.revenue)).toEqual([200, 500]);
  });

  it('range predicates reach the query builder as calendar dates, never Date objects', async () => {
    const { service, capture } = await buildService([]);

    await service.getTenantGrowthTrend({ period: 'month', dataPoints: 6 });

    // A raw query-builder parameter bypasses the column transformer: a `Date`
    // would arrive as a full timestamp and be re-truncated in the SERVER's
    // timezone — a different calendar day near midnight.
    expect(capture.params.startDate).toEqual(expect.stringMatching(ISO_DATE));
    expect(capture.params.endDate).toEqual(expect.stringMatching(ISO_DATE));
    expect(capture.params.startDate).not.toBeInstanceOf(Date);
    expect(capture.params.endDate).not.toBeInstanceOf(Date);
  });

  it('saveSnapshot persists snapshotDate as a calendar date', async () => {
    const { service, saved } = await buildService([]);

    await service.saveSnapshot(
      'daily',
      'tenant',
      TENANT_METRICS,
      new Date('2026-07-09T21:30:00.000Z'),
    );

    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual(expect.objectContaining({ snapshotDate: '2026-07-09' }));
  });
});
