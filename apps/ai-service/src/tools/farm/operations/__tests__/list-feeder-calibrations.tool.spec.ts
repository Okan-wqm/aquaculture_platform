import 'reflect-metadata';
import { of } from 'rxjs';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import {
  humanToolContext,
  tenantBoundClient,
} from '../../../../tenant-boundary/__tests__/fixtures/tenant-bound.fixture';
import { ListFeederCalibrationsTool } from '../list-feeder-calibrations.tool';

const TANK = '22222222-2222-4222-8222-222222222222';
const CTX = humanToolContext({
  userId: 'u-1',
  userRoles: ['MODULE_USER'],
  correlationId: 'corr-1',
  persona: 'operator-farm-operations-v1',
  personaTier: 'operator',
  offeredToolNames: [],
  actuationPolicy: 'confirm_required',
});

describe('ListFeederCalibrationsTool', () => {
  let send: jest.Mock;
  let tool: ListFeederCalibrationsTool;

  beforeEach(() => {
    send = jest
      .fn()
      .mockReturnValue(
        of({ ok: true, tenantId: CTX.tenant.tenantId, data: { items: [], truncated: false } }),
      );
    tool = new ListFeederCalibrationsTool(tenantBoundClient({ send }));
  });

  it('is a module-scoped farm read tool', () => {
    const metadata = tool.getMetadata();
    expect(metadata.name).toBe('list_feeder_calibrations');
    expect(metadata.category).toBe('farm_query');
    expect(metadata.requiresModule).toBe('farm');
    expect(metadata.requiresConfirmation).toBe(false);
  });

  it('applies defaults and sends the contract subject with the context tenant', async () => {
    const result = await tool.execute({ equipmentId: TANK }, CTX);

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.EQUIPMENT_FEEDER_CALIBRATIONS, {
      ...{ equipmentId: TANK, limit: 20 },
      tenantId: CTX.tenant.tenantId,
    });
  });

  it('forwards explicit fields (limits clamped to the contract cap)', async () => {
    await tool.execute({ equipmentId: TANK, limit: 3 }, CTX);

    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.EQUIPMENT_FEEDER_CALIBRATIONS, {
      ...{ equipmentId: TANK, limit: 3 },
      tenantId: CTX.tenant.tenantId,
    });
  });
});
