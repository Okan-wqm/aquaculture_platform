import 'reflect-metadata';
import { of } from 'rxjs';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import type { ToolExecutionContext } from '../../../core/tool.interface';
import { GetWaterQualityHistoryTool } from '../get-water-quality-history.tool';

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

describe('GetWaterQualityHistoryTool', () => {
  let send: jest.Mock;
  let tool: GetWaterQualityHistoryTool;

  beforeEach(() => {
    send = jest.fn().mockReturnValue(of({ ok: true, data: { items: [], truncated: false } }));
    tool = new GetWaterQualityHistoryTool({ send });
  });

  it('is a module-scoped farm read tool', () => {
    const metadata = tool.getMetadata();
    expect(metadata.name).toBe('get_water_quality_history');
    expect(metadata.category).toBe('farm_query');
    expect(metadata.requiresModule).toBe('farm');
    expect(metadata.requiresConfirmation).toBe(false);
  });

  it('applies defaults and sends the contract subject with the context tenant', async () => {
    const result = await tool.execute(
      { tankId: TANK, fromDate: '2026-09-01', toDate: '2026-09-18' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.WQ_HISTORY, {
      ...{ tankId: TANK, fromDate: '2026-09-01', toDate: '2026-09-18', limit: 20 },
      tenantId: CTX.tenantId,
    });
  });

  it('forwards explicit fields (limits clamped to the contract cap)', async () => {
    await tool.execute(
      { tankId: TANK, fromDate: '2026-09-01', toDate: '2026-09-18', limit: 500 },
      CTX,
    );

    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.WQ_HISTORY, {
      ...{ tankId: TANK, fromDate: '2026-09-01', toDate: '2026-09-18', limit: 50 },
      tenantId: CTX.tenantId,
    });
  });
});
