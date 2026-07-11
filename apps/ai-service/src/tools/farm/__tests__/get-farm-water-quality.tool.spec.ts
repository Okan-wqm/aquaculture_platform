import 'reflect-metadata';
import { of } from 'rxjs';
import { GetFarmWaterQualityTool } from '../get-farm-water-quality.tool';
import type { ToolExecutionContext } from '../../core/tool.interface';

const CTX: ToolExecutionContext = {
  tenantId: '33333333-3333-4333-8333-333333333333',
  schemaName: 'tenant_3333333333333333',
  userId: 'u-1',
  userRoles: ['operator'],
  correlationId: 'corr-1',
  persona: 'operator',
  actuationPolicy: 'allowed',
};

const READING = {
  id: 'm1', tankId: 't1', pondId: null, measuredAt: '2026-07-06T06:00:00.000Z',
  temperature: 18.5, dissolvedOxygen: 7.2, pH: 7.8, ammonia: null, nitrite: null,
};

describe('GetFarmWaterQualityTool', () => {
  let send: jest.Mock;
  let tool: GetFarmWaterQualityTool;

  beforeEach(() => {
    send = jest.fn();
    tool = new GetFarmWaterQualityTool({ send });
  });

  it('is a plain read tool (no confirmation)', () => {
    expect(tool.getMetadata().requiresConfirmation).toBe(false);
    expect(tool.getMetadata().name).toBe('get_farm_water_quality');
    expect(tool.getMetadata().category).toBe('farm_query');
  });

  it('requests recent readings for the context tenant and returns them + count', async () => {
    send.mockReturnValue(of([READING]));

    const result = await tool.execute({}, CTX);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ readings: [READING], count: 1 });
    expect(send).toHaveBeenCalledWith('request.farm.getWaterQualityOverview', {
      tenantId: CTX.tenantId,
    });
  });

  it('coalesces an empty/absent result to a zero-count result', async () => {
    send.mockReturnValue(of([]));
    const result = await tool.execute({}, CTX);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ readings: [], count: 0 });
  });
});
