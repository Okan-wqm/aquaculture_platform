import 'reflect-metadata';

import { QueryBus } from '@platform/cqrs';

import { FeedingAiQueryResponder } from '../feeding-ai-query.responder';
import { GetDailyFeedingPlanQuery } from '../../queries/get-daily-feeding-plan.query';
import { GetFeedingSummaryQuery } from '../../queries/get-feeding-summary.query';
import { GetSiteFeedConsumptionQuery } from '../../queries/get-site-feed-consumption.query';
import { ListFeedingProtocolsQuery } from '../../../feed/queries/list-feeding-protocols.query';
import { FeedingProtocol } from '../../../feed/entities/feeding-protocol.entity';

const TENANT = '33333333-3333-4333-8333-333333333333';
const SITE = '22222222-2222-4222-8222-222222222222';
const BATCH = '11111111-1111-4111-8111-111111111111';
const DEPARTMENT = '44444444-4444-4444-8444-444444444444';

const DAILY_PLAN = {
  date: new Date('2026-09-18T00:00:00.000Z'),
  siteId: SITE,
  plannedFeedings: [
    {
      batchId: '',
      batchCode: '',
      tankId: 't1',
      tankCode: 'TNK-001',
      feedId: 'f1',
      feedName: 'Grower 3mm',
      plannedAmountKg: 12.5,
      actualAmountKg: 11.8,
      mealsPlanned: 4,
      mealsCompleted: 4,
      isComplete: true,
    },
  ],
  totalPlannedKg: 12.5,
  totalActualKg: 11.8,
  completionPercent: 94,
};

const SUMMARY = {
  entityId: BATCH,
  entityType: 'batch' as const,
  entityName: 'B-2026-001',
  startDate: new Date('2026-08-01T00:00:00.000Z'),
  endDate: new Date('2026-09-01T00:00:00.000Z'),
  totalFeedingsCount: 120,
  totalPlannedKg: 1000,
  totalActualKg: 950,
  totalVarianceKg: -50,
  totalWasteKg: 12,
  totalFeedCost: 3800,
  avgDailyFeedingKg: 30.6,
  avgVariancePercent: -5,
  avgFeedingDuration: 22,
  appetiteDistribution: { excellent: 80, good: 30, moderate: 8, poor: 2, none: 0 },
  feedTypeDistribution: [
    { feedId: 'f1', feedName: 'Grower 3mm', totalKg: 800, percentage: 84, cost: 3200 },
  ],
  dailyTrend: [{ date: '2026-08-01', plannedKg: 32, actualKg: 30, variancePercent: -6 }],
};

const SITE_CONSUMPTION = {
  totalKg: 4200,
  byFeedType: [
    { feedName: 'Grower 3mm', brandName: 'Skretting', quantityKg: 4200 },
  ],
  recordCount: 900,
};

function protocol(overrides: Partial<FeedingProtocol> = {}): FeedingProtocol {
  return {
    id: 'fp1',
    tenantId: TENANT,
    name: 'Seabass grow-out',
    description: 'standard protocol',
    feedId: 'f1',
    species: 'Seabass',
    stage: 'grower' as FeedingProtocol['stage'],
    temperatureRanges: [],
    growthStageProtocols: [],
    defaultSchedule: {} as FeedingProtocol['defaultSchedule'],
    targetFcr: 1.2,
    minDissolvedOxygen: 6,
    optimalTemperature: { min: 20, max: 26 },
    specialConditions: {},
    isActive: true,
    isDefault: true,
    notes: 'operator note',
    ...overrides,
  } as FeedingProtocol;
}

const PROTOCOL_PAGE = (rows: FeedingProtocol[], total: number) => ({
  data: rows,
  pagination: { page: 1, limit: 20, total, totalPages: 1, hasNextPage: false, hasPreviousPage: false },
});

describe('FeedingAiQueryResponder (PR-4 farm-AI read surface)', () => {
  let execute: jest.Mock;
  let responder: FeedingAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    responder = new FeedingAiQueryResponder({ execute } as unknown as QueryBus);
  });

  // -------------------------------------------------------- FEEDING_DAILY_PLAN
  it('FEEDING_DAILY_PLAN: invalid payload → INVALID_REQUEST, no query executed', async () => {
    for (const bad of [
      { tenantId: TENANT, siteId: SITE },
      { tenantId: TENANT, siteId: SITE, date: 'tomorrow' },
      { tenantId: TENANT, siteId: 'site-1', date: '2026-09-18' },
      { tenantId: TENANT, siteId: SITE, date: '2026-09-18', departmentId: 'dept' },
    ]) {
      expect(await responder.dailyPlan(bad)).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('FEEDING_DAILY_PLAN: happy path executes the query with Date + department', async () => {
    execute.mockResolvedValue(DAILY_PLAN);

    const reply = await responder.dailyPlan({
      tenantId: TENANT,
      siteId: SITE,
      date: '2026-09-18',
      departmentId: DEPARTMENT,
    });

    expect(execute).toHaveBeenCalledWith(expect.any(GetDailyFeedingPlanQuery));
    const query = execute.mock.calls[0][0] as GetDailyFeedingPlanQuery;
    expect(query.tenantId).toBe(TENANT);
    expect(query.siteId).toBe(SITE);
    expect(query.date).toEqual(new Date('2026-09-18'));
    expect(query.departmentId).toBe(DEPARTMENT);

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.date).toBe('2026-09-18T00:00:00.000Z');
      expect(reply.data.completionPercent).toBe(94);
      expect(reply.data.plannedFeedings[0]?.tankCode).toBe('TNK-001');
    }
  });

  it('FEEDING_DAILY_PLAN: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(
      await responder.dailyPlan({ tenantId: TENANT, siteId: SITE, date: '2026-09-18' }),
    ).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
  });

  // ---------------------------------------------------------- FEEDING_SUMMARY
  it('FEEDING_SUMMARY: invalid payload → INVALID_REQUEST, no query executed', async () => {
    for (const bad of [
      { tenantId: TENANT, entityType: 'pond', entityId: BATCH },
      { tenantId: TENANT, entityType: 'batch' },
      { tenantId: TENANT, entityType: 'batch', entityId: BATCH, fromDate: '2026-01-01' },
      { tenantId: TENANT, entityType: 'tank', entityId: BATCH, fromDate: '01-01-2026', toDate: '2026-03-01' },
    ]) {
      expect(await responder.summary(bad)).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('FEEDING_SUMMARY: happy path executes the tenant-scoped query', async () => {
    execute.mockResolvedValue(SUMMARY);

    const reply = await responder.summary({
      tenantId: TENANT,
      entityType: 'batch',
      entityId: BATCH,
      fromDate: '2026-08-01',
      toDate: '2026-09-01',
    });

    expect(execute).toHaveBeenCalledWith(expect.any(GetFeedingSummaryQuery));
    const query = execute.mock.calls[0][0] as GetFeedingSummaryQuery;
    expect(query.tenantId).toBe(TENANT);
    expect(query.entityType).toBe('batch');
    expect(query.entityId).toBe(BATCH);
    expect(query.fromDate).toEqual(new Date('2026-08-01'));

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.startDate).toBe('2026-08-01T00:00:00.000Z');
      expect(reply.data.totalActualKg).toBe(950);
      expect(reply.data.appetiteDistribution.good).toBe(30);
    }
  });

  it('FEEDING_SUMMARY: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(
      await responder.summary({ tenantId: TENANT, entityType: 'tank', entityId: BATCH }),
    ).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
  });

  // ---------------------------------------------------- FEEDING_SITE_CONSUMPTION
  it('FEEDING_SITE_CONSUMPTION: invalid payload → INVALID_REQUEST, no query executed', async () => {
    expect(
      await responder.siteConsumption({ tenantId: TENANT, siteId: SITE, fromDate: '2026-01-01' }),
    ).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('FEEDING_SITE_CONSUMPTION: happy path executes the query and projects rows', async () => {
    execute.mockResolvedValue(SITE_CONSUMPTION);

    const reply = await responder.siteConsumption({
      tenantId: TENANT,
      siteId: SITE,
      fromDate: '2026-01-01',
      toDate: '2026-06-30',
    });

    expect(execute).toHaveBeenCalledWith(expect.any(GetSiteFeedConsumptionQuery));
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.totalKg).toBe(4200);
      expect(reply.data.byFeedType[0]?.brandName).toBe('Skretting');
      expect(reply.data.byFeedTypeTruncated).toBe(false);
    }
  });

  it('FEEDING_SITE_CONSUMPTION: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(
      await responder.siteConsumption({
        tenantId: TENANT,
        siteId: SITE,
        fromDate: '2026-01-01',
        toDate: '2026-06-30',
      }),
    ).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
  });

  // ------------------------------------------------------------- FEED_PROTOCOLS
  it('FEED_PROTOCOLS: invalid payload → INVALID_REQUEST, no query executed', async () => {
    for (const bad of [{ tenantId: 'bad' }, { tenantId: TENANT, limit: 0 }, [TENANT]]) {
      expect(await responder.protocols(bad)).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('FEED_PROTOCOLS: happy path bounds the catalogue and strips PII', async () => {
    execute.mockResolvedValue(PROTOCOL_PAGE(Array.from({ length: 60 }, (_, i) => protocol({ id: `fp${i}` })), 120));

    const reply = await responder.protocols({ tenantId: TENANT, limit: 50 });

    expect(execute).toHaveBeenCalledWith(expect.any(ListFeedingProtocolsQuery));
    const query = execute.mock.calls[0][0] as ListFeedingProtocolsQuery;
    expect(query.tenantId).toBe(TENANT);

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.items).toHaveLength(50);
      expect(reply.data.truncated).toBe(true);
      expect(reply.data.total).toBe(120);
      expect(reply.data.items[0]?.targetFcr).toBe(1.2);
      expect(JSON.stringify(reply.data)).not.toContain('operator note');
    }
  });

  it('FEED_PROTOCOLS: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.protocols({ tenantId: TENANT })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });
});
