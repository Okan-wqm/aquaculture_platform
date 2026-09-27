import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { QueryBus } from '@platform/cqrs';
import {
  GetTankCapacityQuery,
  type TankCapacityResult,
} from '../../queries/get-tank-capacity.query';
import { TankAiQueryResponder } from '../tank-ai-query.responder';

const TENANT = '11111111-1111-4111-8111-111111111111';
const TANK = '22222222-2222-4222-8222-222222222222';
const BATCH = '33333333-3333-4333-8333-333333333333';

describe('TankAiQueryResponder (FARM-MEDIUM-328)', () => {
  let execute: jest.Mock;
  let responder: TankAiQueryResponder;

  const capacity: TankCapacityResult = {
    tankId: TANK,
    tankCode: 'TNK-001',
    tankName: 'Havuz 1',
    volumeM3: 120,
    maxCapacityKg: 2400,
    maxDensityKgM3: 20,
    optimalDensityMinKgM3: 8,
    optimalDensityMaxKgM3: 15,
    currentQuantity: 5000,
    currentBiomassKg: 1500,
    currentDensityKgM3: 12.5,
    currentAvgWeightG: 300,
    capacityUsedKg: 1500,
    capacityAvailableKg: 900,
    capacityUsedPercent: 62.5,
    densityStatus: 'optimal',
    capacityStatus: 'available',
    batchCount: 1,
    primaryBatchId: BATCH,
    primaryBatchNumber: 'B-2026-01',
    warnings: [],
  };

  beforeEach(() => {
    execute = jest.fn();
    const queryBus: Pick<QueryBus, 'execute'> = { execute };
    responder = new TankAiQueryResponder(queryBus as QueryBus);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('rejects a non-UUID tank id before touching the query bus', async () => {
    const reply = await responder.getCapacity({ tenantId: TENANT, tankId: 'tank-1' });
    expect(reply).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('projects the capacity result field-for-field with unit-suffixed names', async () => {
    execute.mockResolvedValue(capacity);

    const reply = await responder.getCapacity({ tenantId: TENANT, tankId: TANK });

    expect(execute).toHaveBeenCalledWith(expect.any(GetTankCapacityQuery));
    const query = execute.mock.calls[0]?.[0] as GetTankCapacityQuery;
    expect(query.tenantId).toBe(TENANT);
    expect(query.tankId).toBe(TANK);
    expect(reply).toEqual({
      ok: true,
      data: {
        tankId: TANK,
        tankCode: 'TNK-001',
        tankName: 'Havuz 1',
        volumeM3: 120,
        maxCapacityKg: 2400,
        maxDensityKgM3: 20,
        optimalDensityMinKgM3: 8,
        optimalDensityMaxKgM3: 15,
        currentQuantity: 5000,
        currentBiomassKg: 1500,
        currentDensityKgM3: 12.5,
        currentAvgWeightG: 300,
        capacityUsedKg: 1500,
        capacityAvailableKg: 900,
        capacityUsedPct: 62.5,
        densityStatus: 'optimal',
        capacityStatus: 'available',
        batchCount: 1,
        primaryBatchId: BATCH,
        primaryBatchNumber: 'B-2026-01',
        warnings: [],
      },
    });
  });

  it('maps an empty tank (no primary batch) to nulls, and a query failure to INTERNAL_ERROR', async () => {
    execute.mockResolvedValueOnce({
      ...capacity,
      primaryBatchId: undefined,
      primaryBatchNumber: undefined,
      batchCount: 0,
    });
    const empty = await responder.getCapacity({ tenantId: TENANT, tankId: TANK });
    expect(empty.ok && empty.data).toMatchObject({
      primaryBatchId: null,
      primaryBatchNumber: null,
    });

    execute.mockRejectedValueOnce(new Error('tank not found'));
    const failed = await responder.getCapacity({ tenantId: TENANT, tankId: TANK });
    expect(failed).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
  });
});
