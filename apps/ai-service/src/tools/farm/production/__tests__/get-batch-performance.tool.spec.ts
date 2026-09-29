import 'reflect-metadata';
import { of } from 'rxjs';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import {
  humanToolContext,
  tenantBoundClient,
} from '../../../../tenant-boundary/__tests__/fixtures/tenant-bound.fixture';
import { GetBatchPerformanceTool } from '../get-batch-performance.tool';

const TANK = '22222222-2222-4222-8222-222222222222';
const CTX = humanToolContext({
  userId: 'u-1',
  userRoles: ['MODULE_USER'],
  correlationId: 'corr-1',
  persona: 'manager-farm-production-v1',
  personaTier: 'manager',
  offeredToolNames: [],
  actuationPolicy: 'confirm_required',
});

describe('GetBatchPerformanceTool', () => {
  let send: jest.Mock;
  let tool: GetBatchPerformanceTool;

  beforeEach(() => {
    send = jest.fn().mockReturnValue(
      of({
        ok: true,
        tenantId: CTX.tenant.tenantId,
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
    tool = new GetBatchPerformanceTool(tenantBoundClient({ send }));
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
      tenantId: CTX.tenant.tenantId,
    });
  });

  it('forwards explicit fields (limits clamped to the contract cap)', async () => {
    await tool.execute({ batchId: TANK }, CTX);

    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.BATCH_PERFORMANCE, {
      ...{ batchId: TANK },
      tenantId: CTX.tenant.tenantId,
    });
  });
});
