import 'reflect-metadata';
import { of } from 'rxjs';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import type { ToolExecutionContext } from '../../../core/tool.interface';
import { GetWorkOrderStatsTool } from '../get-work-order-stats.tool';

const CTX: ToolExecutionContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  schemaName: 'tenant_1111111111111111',
  userId: 'u-1',
  userRoles: ['MODULE_USER'],
  correlationId: 'corr-1',
  persona: 'operator-farm-operations-v1',
  personaTier: 'operator',
  actuationPolicy: 'confirm_required',
};

describe('GetWorkOrderStatsTool', () => {
  let send: jest.Mock;
  let tool: GetWorkOrderStatsTool;

  beforeEach(() => {
    send = jest.fn().mockReturnValue(
      of({
        ok: true,
        data: {
          total: 0,
          byStatus: {},
          byType: {},
          byPriority: {},
          overdue: 0,
          completedOnTime: 0,
          avgCompletionMinutes: 0,
          totalCost: 0,
        },
      }),
    );
    tool = new GetWorkOrderStatsTool({ send });
  });

  it('is a module-scoped farm read tool', () => {
    const metadata = tool.getMetadata();
    expect(metadata.name).toBe('get_work_order_stats');
    expect(metadata.category).toBe('farm_query');
    expect(metadata.requiresModule).toBe('farm');
    expect(metadata.requiresConfirmation).toBe(false);
  });

  it('applies defaults and sends the contract subject with the context tenant', async () => {
    const result = await tool.execute({}, CTX);

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.MAINT_WORK_ORDER_STATS, {
      ...{},
      tenantId: CTX.tenantId,
    });
  });

  it('forwards explicit fields (limits clamped to the contract cap)', async () => {
    await tool.execute({ fromDate: '2026-01-01', toDate: '2026-06-30' }, CTX);

    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.MAINT_WORK_ORDER_STATS, {
      ...{ fromDate: '2026-01-01', toDate: '2026-06-30' },
      tenantId: CTX.tenantId,
    });
  });
});
