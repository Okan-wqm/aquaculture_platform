import 'reflect-metadata';
import { of } from 'rxjs';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import type { ToolExecutionContext } from '../../../core/tool.interface';
import { GetTransfersSummaryTool } from '../get-transfers-summary.tool';

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

describe('GetTransfersSummaryTool', () => {
  let send: jest.Mock;
  let tool: GetTransfersSummaryTool;

  beforeEach(() => {
    send = jest.fn().mockReturnValue(
      of({
        ok: true,
        data: {
          siteId: TANK,
          fromDate: '2026-01-01',
          toDate: '2026-06-30',
          recordCount: 0,
          totalInCount: 0,
          totalInBiomassKg: 0,
          totalOutCount: 0,
          totalOutBiomassKg: 0,
          records: [],
          truncated: false,
        },
      }),
    );
    tool = new GetTransfersSummaryTool({ send });
  });

  it('is a module-scoped farm read tool', () => {
    const metadata = tool.getMetadata();
    expect(metadata.name).toBe('get_transfers_summary');
    expect(metadata.category).toBe('farm_query');
    expect(metadata.requiresModule).toBe('farm');
    expect(metadata.requiresConfirmation).toBe(false);
  });

  it('applies defaults and sends the contract subject with the context tenant', async () => {
    const result = await tool.execute(
      { siteId: TANK, fromDate: '2026-01-01', toDate: '2026-06-30' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.BATCH_TRANSFERS_SUMMARY, {
      ...{ siteId: TANK, fromDate: '2026-01-01', toDate: '2026-06-30' },
      tenantId: CTX.tenantId,
    });
  });

  it('forwards explicit fields (limits clamped to the contract cap)', async () => {
    await tool.execute({ siteId: TANK, fromDate: '2026-07-01', toDate: '2026-07-31' }, CTX);

    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.BATCH_TRANSFERS_SUMMARY, {
      ...{ siteId: TANK, fromDate: '2026-07-01', toDate: '2026-07-31' },
      tenantId: CTX.tenantId,
    });
  });
});
