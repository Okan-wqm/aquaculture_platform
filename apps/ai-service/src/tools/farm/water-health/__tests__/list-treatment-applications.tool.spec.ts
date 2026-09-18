import 'reflect-metadata';
import { of } from 'rxjs';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import type { ToolExecutionContext } from '../../../core/tool.interface';
import { ListTreatmentApplicationsTool } from '../list-treatment-applications.tool';

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

describe('ListTreatmentApplicationsTool', () => {
  let send: jest.Mock;
  let tool: ListTreatmentApplicationsTool;

  beforeEach(() => {
    send = jest.fn().mockReturnValue(of({ ok: true, data: { items: [], truncated: false } }));
    tool = new ListTreatmentApplicationsTool({ send });
  });

  it('is a module-scoped farm read tool', () => {
    const metadata = tool.getMetadata();
    expect(metadata.name).toBe('list_treatment_applications');
    expect(metadata.category).toBe('farm_query');
    expect(metadata.requiresModule).toBe('farm');
    expect(metadata.requiresConfirmation).toBe(false);
  });

  it('applies defaults and sends the contract subject with the context tenant', async () => {
    const result = await tool.execute({}, CTX);

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.FH_TREATMENTS, {
      ...{ limit: 20 },
      tenantId: CTX.tenantId,
    });
  });

  it('forwards explicit fields (limits clamped to the contract cap)', async () => {
    await tool.execute(
      { siteId: TANK, fromDate: '2026-01-01', toDate: '2026-06-30', limit: 8 },
      CTX,
    );

    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.FH_TREATMENTS, {
      ...{ siteId: TANK, fromDate: '2026-01-01', toDate: '2026-06-30', limit: 8 },
      tenantId: CTX.tenantId,
    });
  });
});
