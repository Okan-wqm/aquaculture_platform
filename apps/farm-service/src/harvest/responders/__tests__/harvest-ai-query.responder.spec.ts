import 'reflect-metadata';

import { QueryBus } from '@platform/cqrs';

import { HarvestAiQueryResponder } from '../harvest-ai-query.responder';
import { ListUpcomingHarvestPlansQuery } from '../../queries/list-upcoming-harvest-plans.query';
import { ListOverdueHarvestPlansQuery } from '../../queries/list-overdue-harvest-plans.query';
import { GetHarvestPlanStatsQuery } from '../../queries/get-harvest-plan-stats.query';
import { HarvestPlan } from '../../entities/harvest-plan.entity';
import { HarvestPlanStats } from '../../services/harvest-plan.service';

const TENANT = '33333333-3333-4333-8333-333333333333';
const BATCH = '11111111-1111-4111-8111-111111111111';

function plan(id: string): HarvestPlan {
  return {
    id,
    tenantId: TENANT,
    planCode: 'HP-2026-00001',
    name: 'Autumn harvest',
    description: 'plan description',
    batchId: BATCH,
    status: 'approved' as HarvestPlan['status'],
    harvestType: 'partial' as HarvestPlan['harvestType'],
    plannedDate: new Date('2026-10-01T00:00:00.000Z'),
    confirmedDate: null,
    windowStartDate: null,
    windowEndDate: null,
    criteria: {
      targetWeight: { min: 380, max: 460, target: 420 },
      targetQuantity: { value: 5000, unit: 'pieces' },
      qualityGrade: 'A',
    } as HarvestPlan['criteria'],
    harvestMethod: 'seine' as HarvestPlan['harvestMethod'],
    productForm: 'fresh' as HarvestPlan['productForm'],
    estimates: {
      estimatedQuantity: 5000,
      estimatedBiomass: 2100,
      estimatedAvgWeight: 420,
      estimatedYield: 86,
      confidenceLevel: 'high',
    } as HarvestPlan['estimates'],
    financialProjection: {
      estimatedRevenue: 100000,
      estimatedPrice: 45,
      priceUnit: 'per_kg',
      estimatedCost: 60000,
      estimatedProfit: 40000,
      margin: 40,
      currency: 'NOK',
    } as HarvestPlan['financialProjection'],
    logistics: {
      destinationAddress: 'Harbor 4',
      requiredPersonnel: 6,
    } as HarvestPlan['logistics'],
    customerOrder: {
      customerName: 'BigFish AS',
      orderQuantity: 5000,
    } as HarvestPlan['customerOrder'],
    actualQuantityHarvested: null,
    actualBiomassHarvested: null,
    actualAvgWeight: null,
    approvedBy: 'approver-user-id', // PII — must never cross the wire
    createdBy: 'creator-user-id', // PII — must never cross the wire
    notes: 'operator note',
    attachments: ['s3://bucket/plan.pdf'],
  } as unknown as HarvestPlan;
}

const STATS: HarvestPlanStats = {
  total: 10,
  draft: 1,
  planned: 3,
  approved: 2,
  scheduled: 1,
  inProgress: 1,
  completed: 1,
  cancelled: 1,
  postponed: 0,
  totalEstimatedBiomass: 21000,
  totalActualBiomass: 1500,
  upcomingCount: 4,
  overdueCount: 1,
};

describe('HarvestAiQueryResponder (PR-4 farm-AI read surface)', () => {
  let execute: jest.Mock;
  let responder: HarvestAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    responder = new HarvestAiQueryResponder({ execute } as unknown as QueryBus);
  });

  // -------------------------------------------------------------- HARVEST_PLANS
  it('HARVEST_PLANS: invalid payload → INVALID_REQUEST, no query executed', async () => {
    for (const bad of [
      { tenantId: TENANT },
      { tenantId: TENANT, scope: 'later' },
      { tenantId: TENANT, scope: 'upcoming' },
      { tenantId: TENANT, scope: 'upcoming', days: 181 },
      { tenantId: TENANT, scope: 'upcoming', days: 30, limit: 51 },
    ]) {
      expect(await responder.plans(bad)).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('HARVEST_PLANS: scope upcoming executes ListUpcomingHarvestPlansQuery with days', async () => {
    execute.mockResolvedValue([plan('hp1')]);

    const reply = await responder.plans({
      tenantId: TENANT,
      scope: 'upcoming',
      days: 60,
    });

    expect(execute).toHaveBeenCalledWith(expect.any(ListUpcomingHarvestPlansQuery));
    const query = execute.mock.calls[0][0] as ListUpcomingHarvestPlansQuery;
    expect(query.tenantId).toBe(TENANT);
    expect(query.days).toBe(60);

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.items[0]?.plannedDate).toBe('2026-10-01T00:00:00.000Z');
      expect(reply.data.items[0]?.estimates.estimatedBiomassKg).toBe(2100);
      const serialized = JSON.stringify(reply.data);
      expect(serialized).not.toContain('approvedBy');
      expect(serialized).not.toContain('createdBy');
      expect(serialized).not.toContain('customerName');
      expect(serialized).not.toContain('destinationAddress');
      expect(serialized).not.toContain('operator note');
      expect(serialized).not.toContain('s3://');
    }
  });

  it('HARVEST_PLANS: scope overdue executes ListOverdueHarvestPlansQuery', async () => {
    execute.mockResolvedValue([]);

    const reply = await responder.plans({
      tenantId: TENANT,
      scope: 'overdue',
      days: 30,
      limit: 10,
    });

    expect(execute).toHaveBeenCalledWith(expect.any(ListOverdueHarvestPlansQuery));
    expect(reply).toMatchObject({ ok: true, data: { items: [], truncated: false, total: 0 } });
  });

  it('HARVEST_PLANS: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(
      await responder.plans({ tenantId: TENANT, scope: 'upcoming', days: 30 }),
    ).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
  });

  // --------------------------------------------------------- HARVEST_PLAN_STATS
  it('HARVEST_PLAN_STATS: invalid payload → INVALID_REQUEST, no query executed', async () => {
    expect(await responder.stats({})).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('HARVEST_PLAN_STATS: happy path passes the aggregate through', async () => {
    execute.mockResolvedValue(STATS);

    const reply = await responder.stats({ tenantId: TENANT });

    expect(execute).toHaveBeenCalledWith(expect.any(GetHarvestPlanStatsQuery));
    expect(reply).toMatchObject({
      ok: true,
      data: { total: 10, upcomingCount: 4, overdueCount: 1 },
    });
  });

  it('HARVEST_PLAN_STATS: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.stats({ tenantId: TENANT })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });
});
