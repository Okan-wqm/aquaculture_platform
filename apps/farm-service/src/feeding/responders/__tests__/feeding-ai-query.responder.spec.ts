import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { QueryBus } from '@platform/cqrs';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { ListFeedingProtocolsQuery } from '../../../feed/queries/list-feeding-protocols.query';
import { GetDailyFeedingPlanQuery } from '../../queries/get-daily-feeding-plan.query';
import { GetFeedingSummaryQuery } from '../../queries/get-feeding-summary.query';
import { FeedingAiQueryResponder } from '../feeding-ai-query.responder';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';

describe('FeedingAiQueryResponder (FARM-MEDIUM-328)', () => {
  let execute: jest.Mock;
  let responder: FeedingAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    const queryBus: Pick<QueryBus, 'execute'> = { execute };
    responder = new FeedingAiQueryResponder(queryBus as QueryBus);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('daily plan: dispatches with a Date and bounds the planned feedings', async () => {
    execute.mockResolvedValue({
      date: new Date('2026-09-18T00:00:00Z'),
      siteId: SITE,
      plannedFeedings: Array.from({ length: 60 }, (_, i) => ({
        batchId: SITE,
        batchCode: `B-${i}`,
        feedId: SITE,
        feedName: 'Pellet 4mm',
        plannedAmountKg: 10,
        actualAmountKg: 9,
        mealsPlanned: 3,
        mealsCompleted: 2,
        isComplete: false,
      })),
      totalPlannedKg: 600,
      totalActualKg: 540,
      completionPercent: 90,
    });

    const reply = await responder.getDailyPlan({
      tenantId: TENANT,
      siteId: SITE,
      date: '2026-09-18',
    });

    expect(execute).toHaveBeenCalledWith(expect.any(GetDailyFeedingPlanQuery));
    const query = execute.mock.calls[0][0] as GetDailyFeedingPlanQuery;
    expect(query.date).toEqual(new Date('2026-09-18'));
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.data.plannedFeedings).toHaveLength(50);
    expect(reply.data.truncated).toBe(true);
    expect(reply.data.plannedFeedings[0]).toMatchObject({
      tankId: null,
      tankCode: null,
      plannedAmountKg: 10,
    });
    expect(reply.data.completionPct).toBe(90);
  });

  it('summary: rejects a reversed window and caps the daily trend at 31 points', async () => {
    const reversed = await responder.getSummary({
      tenantId: TENANT,
      entityType: 'batch',
      entityId: SITE,
      fromDate: '2026-09-18',
      toDate: '2026-09-01',
    });
    expect(reversed).toEqual({ ok: false, error: 'INVALID_REQUEST' });

    execute.mockResolvedValue({
      entityId: SITE,
      entityType: 'batch',
      entityName: 'B-1',
      startDate: new Date('2026-07-01T00:00:00Z'),
      endDate: new Date('2026-09-18T00:00:00Z'),
      totalFeedingsCount: 200,
      totalPlannedKg: 1000,
      totalActualKg: 950,
      totalVarianceKg: -50,
      totalWasteKg: 5,
      totalFeedCost: 1900,
      avgDailyFeedingKg: 12,
      avgVariancePercent: -5,
      avgFeedingDuration: 20,
      appetiteDistribution: { excellent: 10, good: 50, moderate: 30, poor: 8, none: 2 },
      feedTypeDistribution: [
        { feedId: SITE, feedName: 'Pellet', totalKg: 950, percentage: 100, cost: 1900 },
      ],
      dailyTrend: Array.from({ length: 80 }, (_, i) => ({
        date: `d${i}`,
        plannedKg: 12,
        actualKg: 11,
        variancePercent: -8,
      })),
    });

    const reply = await responder.getSummary({
      tenantId: TENANT,
      entityType: 'batch',
      entityId: SITE,
    });

    expect(execute).toHaveBeenCalledWith(expect.any(GetFeedingSummaryQuery));
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.data.dailyTrend).toHaveLength(31);
    expect(reply.data.dailyTrend[0]?.date).toBe('d49');
    expect(reply.data.dailyTrendTruncated).toBe(true);
    expect(reply.data.feedTypeDistribution[0]).toMatchObject({ pct: 100 });
  });

  it('protocols: filters active + species and pages by the requested limit', async () => {
    execute.mockResolvedValue({
      data: [
        {
          id: SITE,
          name: 'Grower',
          species: 'SEABASS',
          stage: 'grower',
          feedId: undefined,
          targetFcr: 1.1,
          minDissolvedOxygen: 5,
          isActive: true,
          isDefault: true,
          notes: 'secret',
        },
      ],
      pagination: {
        page: 1,
        limit: 5,
        total: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });

    const reply = await responder.listProtocols({ tenantId: TENANT, species: 'SEABASS', limit: 5 });

    expect(execute).toHaveBeenCalledWith(expect.any(ListFeedingProtocolsQuery));
    const query = execute.mock.calls[0][0] as ListFeedingProtocolsQuery;
    expect(query.filter).toEqual({ isActive: true, species: 'SEABASS' });
    expect(query.pagination).toEqual({ page: 1, limit: 5 });
    expect(reply).toMatchObject({
      ok: true,
      data: {
        total: 1,
        items: [{ name: 'Grower', feedId: null, targetFcr: 1.1, minDissolvedOxygenMgL: 5 }],
      },
    });
    expect(JSON.stringify(reply)).not.toContain('secret');
  });
});
