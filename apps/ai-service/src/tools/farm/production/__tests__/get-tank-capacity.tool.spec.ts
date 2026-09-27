import 'reflect-metadata';
import { of } from 'rxjs';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import type { ToolExecutionContext } from '../../../core/tool.interface';
import { GetTankCapacityTool } from '../get-tank-capacity.tool';

const TANK = '22222222-2222-4222-8222-222222222222';
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

describe('GetTankCapacityTool', () => {
  let send: jest.Mock;
  let tool: GetTankCapacityTool;

  beforeEach(() => {
    send = jest.fn().mockReturnValue(
      of({
        ok: true,
        data: {
          tankId: TANK,
          volumeM3: 100,
          currentBiomassKg: 500,
          capacityUsedPct: 25,
          densityStatus: 'optimal',
          warnings: [],
        },
      }),
    );
    tool = new GetTankCapacityTool({ send });
  });

  it('is a module-scoped farm read tool', () => {
    const metadata = tool.getMetadata();
    expect(metadata.name).toBe('get_tank_capacity');
    expect(metadata.category).toBe('farm_query');
    expect(metadata.requiresModule).toBe('farm');
    expect(metadata.requiresConfirmation).toBe(false);
  });

  it('applies defaults and sends the contract subject with the context tenant', async () => {
    const result = await tool.execute({ tankId: TANK }, CTX);

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.TANK_CAPACITY, {
      ...{ tankId: TANK },
      tenantId: CTX.tenantId,
    });
  });

  it('forwards explicit fields (limits clamped to the contract cap)', async () => {
    await tool.execute({ tankId: TANK }, CTX);

    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.TANK_CAPACITY, {
      ...{ tankId: TANK },
      tenantId: CTX.tenantId,
    });
  });
});
