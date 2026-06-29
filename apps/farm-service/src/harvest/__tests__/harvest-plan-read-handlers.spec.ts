/**
 * Harvest-plan read query handlers — fail-closed tenant boundary
 * (FARM-HIGH-074 / FARM-HIGH-060). Proves tenant scoping reads run through
 * runInTenantRead (find/findOne based handlers).
 */
import { createMockDataSource } from '@aquaculture/testing';

import { GetHarvestPlanHandler } from '../handlers/get-harvest-plan.handler';
import { GetHarvestPlanQuery } from '../queries/get-harvest-plan.query';
import { GetHarvestPlanByCodeHandler } from '../handlers/get-harvest-plan-by-code.handler';
import { GetHarvestPlanByCodeQuery } from '../queries/get-harvest-plan-by-code.query';
import { ListUpcomingHarvestPlansHandler } from '../handlers/list-upcoming-harvest-plans.handler';
import { ListUpcomingHarvestPlansQuery } from '../queries/list-upcoming-harvest-plans.query';
import { ListOverdueHarvestPlansHandler } from '../handlers/list-overdue-harvest-plans.handler';
import { ListOverdueHarvestPlansQuery } from '../queries/list-overdue-harvest-plans.query';
import { GetHarvestPlanStatsHandler } from '../handlers/get-harvest-plan-stats.handler';
import { GetHarvestPlanStatsQuery } from '../queries/get-harvest-plan-stats.query';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('Harvest-plan read handlers (fail-closed tenant boundary)', () => {
  it('GetHarvestPlanHandler reads by id scoped to the tenant', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: 'hp-1' });

    const result = await new GetHarvestPlanHandler(mockDataSource).execute(
      new GetHarvestPlanQuery(tenantId, 'hp-1'),
    );

    expect(result).toEqual({ id: 'hp-1' });
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: 'hp-1', tenantId },
    });
  });

  it('GetHarvestPlanByCodeHandler reads by plan code scoped to the tenant', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: 'hp-2', planCode: 'HP-2026-001' });

    const result = await new GetHarvestPlanByCodeHandler(mockDataSource).execute(
      new GetHarvestPlanByCodeQuery(tenantId, 'HP-2026-001'),
    );

    expect(result).toMatchObject({ planCode: 'HP-2026-001' });
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { tenantId, planCode: 'HP-2026-001' },
    });
  });

  it('ListUpcomingHarvestPlansHandler lists tenant-scoped active upcoming plans', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([{ id: 'hp-3' }]);

    const result = await new ListUpcomingHarvestPlansHandler(mockDataSource).execute(
      new ListUpcomingHarvestPlansQuery(tenantId, 30),
    );

    expect(result).toHaveLength(1);
    const [, opts] = (mockManager.find as jest.Mock).mock.calls[0];
    expect(opts.where).toMatchObject({ tenantId });
  });

  it('ListOverdueHarvestPlansHandler lists tenant-scoped overdue plans', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([]);

    const result = await new ListOverdueHarvestPlansHandler(mockDataSource).execute(
      new ListOverdueHarvestPlansQuery(tenantId),
    );

    expect(result).toEqual([]);
    const [, opts] = (mockManager.find as jest.Mock).mock.calls[0];
    expect(opts.where).toMatchObject({ tenantId });
  });

  it('GetHarvestPlanStatsHandler aggregates tenant-scoped plans', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([]); // no plans → zeroed stats

    const result = await new GetHarvestPlanStatsHandler(mockDataSource).execute(
      new GetHarvestPlanStatsQuery(tenantId),
    );

    expect(result.total).toBe(0);
    expect(result.overdueCount).toBe(0);
    expect(mockManager.find).toHaveBeenCalledWith(expect.anything(), { where: { tenantId } });
  });
});
