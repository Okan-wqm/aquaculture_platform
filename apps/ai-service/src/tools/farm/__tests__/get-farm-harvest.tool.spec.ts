import 'reflect-metadata';
import { of } from 'rxjs';
import { GetFarmHarvestTool } from '../get-farm-harvest.tool';
import type { ToolExecutionContext } from '../../core/tool.interface';

const CTX: ToolExecutionContext = {
  tenantId: '44444444-4444-4444-8444-444444444444',
  schemaName: 'tenant_4444444444444444',
  userId: 'u-1',
  userRoles: ['operator'],
  correlationId: 'corr-1',
  persona: 'operator',
  actuationPolicy: 'allowed',
};

const PLAN = {
  id: 'h1', planCode: 'HP-2024-001', name: 'Levrek hasat', batchId: 'b1', status: 'scheduled', plannedDate: '2026-07-15',
};

describe('GetFarmHarvestTool', () => {
  let send: jest.Mock;
  let tool: GetFarmHarvestTool;

  beforeEach(() => {
    send = jest.fn();
    tool = new GetFarmHarvestTool({ send });
  });

  it('is a plain read tool (no confirmation)', () => {
    expect(tool.getMetadata().requiresConfirmation).toBe(false);
    expect(tool.getMetadata().name).toBe('get_farm_harvest');
    expect(tool.getMetadata().category).toBe('farm_query');
  });

  it('requests the harvest plans for the context tenant and returns them + count', async () => {
    send.mockReturnValue(of([PLAN]));

    const result = await tool.execute({}, CTX);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ plans: [PLAN], count: 1 });
    expect(send).toHaveBeenCalledWith('request.farm.getHarvestOverview', {
      tenantId: CTX.tenantId,
    });
  });

  it('coalesces an empty/absent result to a zero-count result', async () => {
    send.mockReturnValue(of([]));
    const result = await tool.execute({}, CTX);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ plans: [], count: 0 });
  });
});
