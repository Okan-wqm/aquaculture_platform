import 'reflect-metadata';
import { of } from 'rxjs';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import type { ToolExecutionContext } from '../../../core/tool.interface';
import { CheckBatchHarvestEligibilityTool } from '../check-batch-harvest-eligibility.tool';

const TANK = '22222222-2222-4222-8222-222222222222';
const CTX: ToolExecutionContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  schemaName: 'tenant_1111111111111111',
  userId: 'u-1',
  userRoles: ['MODULE_USER'],
  correlationId: 'corr-1',
  persona: 'operator-farm-water-health-v1',
  personaTier: 'operator',
  offeredToolNames: [],
  actuationPolicy: 'confirm_required',
};

describe('CheckBatchHarvestEligibilityTool', () => {
  let send: jest.Mock;
  let tool: CheckBatchHarvestEligibilityTool;

  beforeEach(() => {
    send = jest.fn().mockReturnValue(
      of({
        ok: true,
        data: {
          batchId: TANK,
          harvestDate: '2026-10-01',
          eligible: true,
          blockedUntil: null,
          reason: null,
          blockingEvents: [],
        },
      }),
    );
    tool = new CheckBatchHarvestEligibilityTool({ send });
  });

  it('is a module-scoped farm read tool', () => {
    const metadata = tool.getMetadata();
    expect(metadata.name).toBe('check_batch_harvest_eligibility');
    expect(metadata.category).toBe('farm_query');
    expect(metadata.requiresModule).toBe('farm');
    expect(metadata.requiresConfirmation).toBe(false);
  });

  it('applies defaults and sends the contract subject with the context tenant', async () => {
    const result = await tool.execute({ batchId: TANK, harvestDate: '2026-10-01' }, CTX);

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.FH_HARVEST_ELIGIBILITY, {
      ...{ batchId: TANK, harvestDate: '2026-10-01' },
      tenantId: CTX.tenantId,
    });
  });

  it('forwards explicit fields (limits clamped to the contract cap)', async () => {
    await tool.execute({ batchId: TANK, harvestDate: '2026-11-15' }, CTX);

    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.FH_HARVEST_ELIGIBILITY, {
      ...{ batchId: TANK, harvestDate: '2026-11-15' },
      tenantId: CTX.tenantId,
    });
  });
});
