import 'reflect-metadata';
import { of } from 'rxjs';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import type { ToolExecutionContext } from '../../../core/tool.interface';
import { ListHealthEventsTool } from '../list-health-events.tool';

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

describe('ListHealthEventsTool', () => {
  let send: jest.Mock;
  let tool: ListHealthEventsTool;

  beforeEach(() => {
    send = jest
      .fn()
      .mockReturnValue(of({ ok: true, data: { items: [], truncated: false, total: 0 } }));
    tool = new ListHealthEventsTool({ send });
  });

  it('is a module-scoped farm read tool', () => {
    const metadata = tool.getMetadata();
    expect(metadata.name).toBe('list_health_events');
    expect(metadata.category).toBe('farm_query');
    expect(metadata.requiresModule).toBe('farm');
    expect(metadata.requiresConfirmation).toBe(false);
  });

  it('applies defaults and sends the contract subject with the context tenant', async () => {
    const result = await tool.execute({}, CTX);

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.FH_EVENTS, {
      ...{ activeOnly: true, limit: 20 },
      tenantId: CTX.tenantId,
    });
  });

  it('forwards explicit fields (limits clamped to the contract cap)', async () => {
    await tool.execute({ batchId: TANK, severity: 'critical', activeOnly: false, limit: 3 }, CTX);

    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.FH_EVENTS, {
      ...{ batchId: TANK, severity: 'critical', activeOnly: false, limit: 3 },
      tenantId: CTX.tenantId,
    });
  });
});
