import 'reflect-metadata';

import { QueryBus } from '@platform/cqrs';

import { TankAiQueryResponder } from '../tank-ai-query.responder';
import { GetTankCapacityQuery, TankCapacityResult } from '../../queries/get-tank-capacity.query';

const TENANT = '33333333-3333-4333-8333-333333333333';
const TANK = '11111111-1111-4111-8111-111111111111';

const CAPACITY: TankCapacityResult = {
  tankId: TANK,
  tankCode: 'TNK-001',
  tankName: 'Havuz 1',
  volumeM3: 120,
  maxCapacityKg: 12000,
  maxDensityKgM3: 100,
  optimalDensityMinKgM3: 40,
  optimalDensityMaxKgM3: 70,
  currentQuantity: 9500,
  currentBiomassKg: 3400,
  currentDensityKgM3: 28.3,
  currentAvgWeightG: 358,
  capacityUsedKg: 3400,
  capacityAvailableKg: 8600,
  capacityUsedPercent: 28.3,
  densityStatus: 'low',
  capacityStatus: 'available',
  batchCount: 1,
  primaryBatchId: 'b1',
  primaryBatchNumber: 'B-2026-001',
  warnings: [],
};

describe('TankAiQueryResponder (PR-4 farm-AI read surface)', () => {
  let execute: jest.Mock;
  let responder: TankAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    responder = new TankAiQueryResponder({ execute } as unknown as QueryBus);
  });

  it('TANK_CAPACITY: invalid payload → INVALID_REQUEST, no query executed', async () => {
    for (const bad of [null, { tenantId: TENANT }, { tenantId: TENANT, tankId: 'tank-1' }]) {
      expect(await responder.capacity(bad)).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('TANK_CAPACITY: happy path executes the tenant-scoped query and replies ok', async () => {
    execute.mockResolvedValue(CAPACITY);

    const reply = await responder.capacity({ tenantId: TENANT, tankId: TANK });

    expect(execute).toHaveBeenCalledWith(expect.any(GetTankCapacityQuery));
    const query = execute.mock.calls[0][0] as GetTankCapacityQuery;
    expect(query.tenantId).toBe(TENANT);
    expect(query.tankId).toBe(TANK);

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.tankCode).toBe('TNK-001');
      expect(reply.data.capacityUsedPercent).toBe(28.3);
      expect(reply.data.densityStatus).toBe('low');
    }
  });

  it('TANK_CAPACITY: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.capacity({ tenantId: TENANT, tankId: TANK })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });
});
