import 'reflect-metadata';
import { of } from 'rxjs';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import type { ToolExecutionContext } from '../../../core/tool.interface';
import { GetFeedingSummaryTool } from '../get-feeding-summary.tool';

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

describe('GetFeedingSummaryTool', () => {
  let send: jest.Mock;
  let tool: GetFeedingSummaryTool;

  beforeEach(() => {
    send = jest.fn().mockReturnValue(
      of({
        ok: true,
        data: {
          entityId: TANK,
          totalActualKg: 0,
          appetiteDistribution: {},
          feedTypeDistribution: [],
          dailyTrend: [],
          dailyTrendTruncated: false,
        },
      }),
    );
    tool = new GetFeedingSummaryTool({ send });
  });

  it('is a module-scoped farm read tool', () => {
    const metadata = tool.getMetadata();
    expect(metadata.name).toBe('get_feeding_summary');
    expect(metadata.category).toBe('farm_query');
    expect(metadata.requiresModule).toBe('farm');
    expect(metadata.requiresConfirmation).toBe(false);
  });

  it('applies defaults and sends the contract subject with the context tenant', async () => {
    const result = await tool.execute({ entityType: 'batch', entityId: TANK }, CTX);

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.FEEDING_SUMMARY, {
      ...{ entityType: 'batch', entityId: TANK },
      tenantId: CTX.tenantId,
    });
  });

  it('forwards explicit fields (limits clamped to the contract cap)', async () => {
    await tool.execute(
      { entityType: 'tank', entityId: TANK, fromDate: '2026-09-01', toDate: '2026-09-18' },
      CTX,
    );

    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.FEEDING_SUMMARY, {
      ...{ entityType: 'tank', entityId: TANK, fromDate: '2026-09-01', toDate: '2026-09-18' },
      tenantId: CTX.tenantId,
    });
  });
});
