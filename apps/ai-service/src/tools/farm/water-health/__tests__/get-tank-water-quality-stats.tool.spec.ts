import 'reflect-metadata';
import { of } from 'rxjs';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import {
  humanToolContext,
  tenantBoundClient,
} from '../../../../tenant-boundary/__tests__/fixtures/tenant-bound.fixture';
import { GetTankWaterQualityStatsTool } from '../get-tank-water-quality-stats.tool';

const TANK = '22222222-2222-4222-8222-222222222222';
const CTX = humanToolContext({
  userId: 'u-1',
  userRoles: ['MODULE_USER'],
  correlationId: 'corr-1',
  persona: 'operator-farm-water-health-v1',
  personaTier: 'operator',
  offeredToolNames: [],
  actuationPolicy: 'confirm_required',
});

describe('GetTankWaterQualityStatsTool', () => {
  let send: jest.Mock;
  let tool: GetTankWaterQualityStatsTool;

  beforeEach(() => {
    send = jest.fn().mockReturnValue(
      of({
        ok: true,
        tenantId: CTX.tenant.tenantId,
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
    tool = new GetTankWaterQualityStatsTool(tenantBoundClient({ send }));
  });

  it('is a module-scoped farm read tool', () => {
    const metadata = tool.getMetadata();
    expect(metadata.name).toBe('get_tank_water_quality_stats');
    expect(metadata.category).toBe('farm_query');
    expect(metadata.requiresModule).toBe('farm');
    expect(metadata.requiresConfirmation).toBe(false);
  });

  it('applies defaults and sends the contract subject with the context tenant', async () => {
    const result = await tool.execute({ tankId: TANK }, CTX);

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.WQ_TANK_STATS, {
      ...{ tankId: TANK, days: 7 },
      tenantId: CTX.tenant.tenantId,
    });
  });

  it('forwards explicit fields (limits clamped to the contract cap)', async () => {
    await tool.execute({ tankId: TANK, days: 30 }, CTX);

    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.WQ_TANK_STATS, {
      ...{ tankId: TANK, days: 30 },
      tenantId: CTX.tenant.tenantId,
    });
  });
});
