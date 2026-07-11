import 'reflect-metadata';
import { of } from 'rxjs';
import { GetFarmFeedingTool } from '../get-farm-feeding.tool';
import type { ToolExecutionContext } from '../../core/tool.interface';

const CTX: ToolExecutionContext = {
  tenantId: '55555555-5555-4555-8555-555555555555',
  schemaName: 'tenant_5555555555555555',
  userId: 'u-1',
  userRoles: ['operator'],
  correlationId: 'corr-1',
  persona: 'operator',
  actuationPolicy: 'allowed',
};

const FEEDING = {
  id: 'f1', batchId: 'b1', tankId: 't1', feedingDate: '2026-07-06', feedingTime: '08:00', plannedAmountKg: 12.5, actualAmountKg: 12.0,
};

describe('GetFarmFeedingTool', () => {
  let send: jest.Mock;
  let tool: GetFarmFeedingTool;

  beforeEach(() => {
    send = jest.fn();
    tool = new GetFarmFeedingTool({ send });
  });

  it('is a plain read tool (no confirmation)', () => {
    expect(tool.getMetadata().requiresConfirmation).toBe(false);
    expect(tool.getMetadata().name).toBe('get_farm_feeding');
    expect(tool.getMetadata().category).toBe('farm_query');
  });

  it('requests the recent feedings for the context tenant and returns them + count', async () => {
    send.mockReturnValue(of([FEEDING]));

    const result = await tool.execute({}, CTX);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ feedings: [FEEDING], count: 1 });
    expect(send).toHaveBeenCalledWith('request.farm.getFeedingOverview', {
      tenantId: CTX.tenantId,
    });
  });

  it('coalesces an empty/absent result to a zero-count result', async () => {
    send.mockReturnValue(of([]));
    const result = await tool.execute({}, CTX);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ feedings: [], count: 0 });
  });
});
