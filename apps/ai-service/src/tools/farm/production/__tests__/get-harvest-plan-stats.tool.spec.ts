import 'reflect-metadata';
import { of } from 'rxjs';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import type { ToolExecutionContext } from '../../../core/tool.interface';
import { GetHarvestPlanStatsTool } from '../get-harvest-plan-stats.tool';

const CTX: ToolExecutionContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  schemaName: 'tenant_1111111111111111',
  userId: 'u-1',
  userRoles: ['MODULE_USER'],
  correlationId: 'corr-1',
  persona: 'manager-farm-production-v1',
  personaTier: 'manager',
  offeredToolNames: [],
  actuationPolicy: 'confirm_required',
};

describe('GetHarvestPlanStatsTool', () => {
  let send: jest.Mock;
  let tool: GetHarvestPlanStatsTool;

  beforeEach(() => {
    send = jest.fn().mockReturnValue(
      of({
        ok: true,
        data: { total: 0, upcomingCount: 0, overdueCount: 0, totalEstimatedBiomassKg: 0 },
      }),
    );
    tool = new GetHarvestPlanStatsTool({ send });
  });

  it('is a module-scoped farm read tool', () => {
    const metadata = tool.getMetadata();
    expect(metadata.name).toBe('get_harvest_plan_stats');
    expect(metadata.category).toBe('farm_query');
    expect(metadata.requiresModule).toBe('farm');
    expect(metadata.requiresConfirmation).toBe(false);
  });

  it('applies defaults and sends the contract subject with the context tenant', async () => {
    const result = await tool.execute({}, CTX);

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.HARVEST_PLAN_STATS, {
      ...{},
      tenantId: CTX.tenantId,
    });
  });

  it('forwards explicit fields (limits clamped to the contract cap)', async () => {
    await tool.execute({}, CTX);

    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.HARVEST_PLAN_STATS, {
      ...{},
      tenantId: CTX.tenantId,
    });
  });
});
