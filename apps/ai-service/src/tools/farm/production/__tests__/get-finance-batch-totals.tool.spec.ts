import 'reflect-metadata';
import { of } from 'rxjs';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import type { ToolExecutionContext } from '../../../core/tool.interface';
import { GetFinanceBatchTotalsTool } from '../get-finance-batch-totals.tool';

const CTX: ToolExecutionContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  schemaName: 'tenant_1111111111111111',
  userId: 'u-1',
  userRoles: ['MODULE_USER'],
  correlationId: 'corr-1',
  persona: 'manager-farm-production-v1',
  personaTier: 'manager',
  actuationPolicy: 'confirm_required',
};

describe('GetFinanceBatchTotalsTool', () => {
  let send: jest.Mock;
  let tool: GetFinanceBatchTotalsTool;

  beforeEach(() => {
    send = jest.fn().mockReturnValue(of({ ok: true, data: { items: [], truncated: false } }));
    tool = new GetFinanceBatchTotalsTool({ send });
  });

  it('is a module-scoped farm read tool', () => {
    const metadata = tool.getMetadata();
    expect(metadata.name).toBe('get_finance_batch_totals');
    expect(metadata.category).toBe('farm_query');
    expect(metadata.requiresModule).toBe('farm');
    expect(metadata.requiresConfirmation).toBe(false);
  });

  it('is a manager+ read (operators never see finance)', () => {
    expect(tool.getMetadata().requiredPermissions).toEqual(['manager', 'expert', 'supervisor']);
  });

  it('applies defaults and sends the contract subject with the context tenant', async () => {
    const result = await tool.execute({ fromDate: '2026-01-01', toDate: '2026-06-30' }, CTX);

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.FINANCE_BATCH_TOTALS, {
      ...{ fromDate: '2026-01-01', toDate: '2026-06-30', limit: 20 },
      tenantId: CTX.tenantId,
    });
  });

  it('forwards explicit fields (limits clamped to the contract cap)', async () => {
    await tool.execute({ fromDate: '2026-01-01', toDate: '2026-06-30', limit: 3 }, CTX);

    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.FINANCE_BATCH_TOTALS, {
      ...{ fromDate: '2026-01-01', toDate: '2026-06-30', limit: 3 },
      tenantId: CTX.tenantId,
    });
  });
});
