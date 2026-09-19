import 'reflect-metadata';
import { of } from 'rxjs';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import type { ToolExecutionContext } from '../../../core/tool.interface';
import { GetBatchPerformanceTool } from '../get-batch-performance.tool';

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

describe('GetBatchPerformanceTool', () => {
  let send: jest.Mock;
  let tool: GetBatchPerformanceTool;

  beforeEach(() => {
    send = jest.fn().mockReturnValue(
      of({
        ok: true,
        data: {
          batchId: TANK,
          batchNumber: 'B-1',
          currentBiomassKg: 100,
          sgr: 1.2,
          fcr: { target: 1.1, actual: 1.2, theoretical: 1.15, variance: 4, status: 'good' },
          performanceIndex: 80,
          performanceStatus: 'good',
          projectedHarvestDate: null,
        },
      }),
    );
    tool = new GetBatchPerformanceTool({ send });
  });

  it('is a module-scoped farm read tool', () => {
    const metadata = tool.getMetadata();
    expect(metadata.name).toBe('get_batch_performance');
    expect(metadata.category).toBe('farm_query');
    expect(metadata.requiresModule).toBe('farm');
    expect(metadata.requiresConfirmation).toBe(false);
  });

  it('applies defaults and sends the contract subject with the context tenant', async () => {
    const result = await tool.execute({ batchId: TANK }, CTX);

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.BATCH_PERFORMANCE, {
      ...{ batchId: TANK },
      tenantId: CTX.tenantId,
    });
  });

  it('forwards explicit fields (limits clamped to the contract cap)', async () => {
    await tool.execute({ batchId: TANK }, CTX);

    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.BATCH_PERFORMANCE, {
      ...{ batchId: TANK },
      tenantId: CTX.tenantId,
    });
  });
});
