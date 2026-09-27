import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { QueryBus } from '@platform/cqrs';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { ListOverdueHarvestPlansQuery } from '../../queries/list-overdue-harvest-plans.query';
import { ListUpcomingHarvestPlansQuery } from '../../queries/list-upcoming-harvest-plans.query';
import { HarvestAiQueryResponder } from '../harvest-ai-query.responder';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PLAN = '22222222-2222-4222-8222-222222222222';

describe('HarvestAiQueryResponder (FARM-MEDIUM-328)', () => {
  let execute: jest.Mock;
  let responder: HarvestAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    const queryBus: Pick<QueryBus, 'execute'> = { execute };
    responder = new HarvestAiQueryResponder(queryBus as QueryBus);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('routes upcoming vs overdue to the matching query and strips commercial fields', async () => {
    execute.mockResolvedValue([
      {
        id: PLAN,
        planCode: 'HP-2026-0001',
        name: 'Pen 3 grade-out',
        batchId: PLAN,
        status: 'scheduled',
        harvestType: 'partial',
        plannedDate: new Date('2026-10-05T00:00:00Z'),
        estimates: {
          estimatedQuantity: 5000,
          estimatedBiomass: 2000,
          estimatedAvgWeight: 400,
          estimatedYield: 90,
          confidenceLevel: 'high',
        },
        customerOrder: { customerName: 'Acme Fish', contractPrice: 9.5 },
        approvedBy: 'user-1',
        notes: 'private',
      },
    ]);

    const upcoming = await responder.listPlans({
      tenantId: TENANT,
      scope: 'upcoming',
      days: 45,
      limit: 10,
    });
    expect(execute).toHaveBeenLastCalledWith(expect.any(ListUpcomingHarvestPlansQuery));
    expect((execute.mock.calls[0][0] as ListUpcomingHarvestPlansQuery).days).toBe(45);
    expect(upcoming).toMatchObject({
      ok: true,
      data: {
        items: [
          {
            planCode: 'HP-2026-0001',
            plannedDate: '2026-10-05T00:00:00.000Z',
            estimatedBiomassKg: 2000,
            actualBiomassKg: null,
          },
        ],
      },
    });
    for (const secret of ['Acme Fish', '9.5', 'user-1', 'private']) {
      expect(JSON.stringify(upcoming)).not.toContain(secret);
    }

    await responder.listPlans({ tenantId: TENANT, scope: 'overdue', days: 45, limit: 10 });
    expect(execute).toHaveBeenLastCalledWith(expect.any(ListOverdueHarvestPlansQuery));
    expect((execute.mock.calls[0][0] as ListUpcomingHarvestPlansQuery).days).toBe(45);
  });

  it('rejects an unknown scope', async () => {
    const reply = await responder.listPlans({
      tenantId: TENANT,
      scope: 'all',
      days: 30,
      limit: 10,
    });
    expect(reply).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('projects plan stats with kg suffixes', async () => {
    execute.mockResolvedValue({
      total: 3,
      draft: 1,
      planned: 1,
      approved: 0,
      scheduled: 1,
      inProgress: 0,
      completed: 0,
      cancelled: 0,
      postponed: 0,
      totalEstimatedBiomass: '6000',
      totalActualBiomass: 0,
      upcomingCount: 2,
      overdueCount: 0,
    });
    const reply = await responder.getStats({ tenantId: TENANT });
    expect(reply).toMatchObject({
      ok: true,
      data: { total: 3, totalEstimatedBiomassKg: 6000, upcomingCount: 2 },
    });
  });
});
