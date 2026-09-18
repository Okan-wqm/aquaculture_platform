import 'reflect-metadata';
import { of } from 'rxjs';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import type { ToolExecutionContext } from '../../../core/tool.interface';
import { GetSystemWaterQualityStatsTool } from '../get-system-water-quality-stats.tool';

const TANK = '22222222-2222-4222-8222-222222222222';
const CTX: ToolExecutionContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  schemaName: 'tenant_1111111111111111',
  userId: 'u-1',
  userRoles: ['MODULE_USER'],
  correlationId: 'corr-1',
  persona: 'operator-farm-water-health-v1',
  personaTier: 'operator',
  actuationPolicy: 'confirm_required',
};

describe('GetSystemWaterQualityStatsTool', () => {
  let send: jest.Mock;
  let tool: GetSystemWaterQualityStatsTool;

  beforeEach(() => {
    send = jest.fn().mockReturnValue(
      of({
        ok: true,
        data: {
          scopeId: TANK,
          days: 7,
          measurementCount: 0,
          criticalCount: 0,
          warningCount: 0,
          avgTemperatureC: null,
          avgDoMgL: null,
          avgPh: null,
          avgAmmoniaMgL: null,
          avgNitriteMgL: null,
          lastMeasurement: null,
        },
      }),
    );
    tool = new GetSystemWaterQualityStatsTool({ send });
  });

  it('is a module-scoped farm read tool', () => {
    const metadata = tool.getMetadata();
    expect(metadata.name).toBe('get_system_water_quality_stats');
    expect(metadata.category).toBe('farm_query');
    expect(metadata.requiresModule).toBe('farm');
    expect(metadata.requiresConfirmation).toBe(false);
  });

  it('applies defaults and sends the contract subject with the context tenant', async () => {
    const result = await tool.execute({ systemId: TANK }, CTX);

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.WQ_SYSTEM_STATS, {
      ...{ systemId: TANK, days: 7 },
      tenantId: CTX.tenantId,
    });
  });

  it('forwards explicit fields (limits clamped to the contract cap)', async () => {
    await tool.execute({ systemId: TANK, days: 14 }, CTX);

    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.WQ_SYSTEM_STATS, {
      ...{ systemId: TANK, days: 14 },
      tenantId: CTX.tenantId,
    });
  });
});
