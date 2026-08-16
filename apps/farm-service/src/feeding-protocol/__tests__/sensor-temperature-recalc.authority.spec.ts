import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { createMockDataSource } from '@aquaculture/testing';
import type { SelectQueryBuilder } from 'typeorm';

import { Equipment } from '../../equipment/entities/equipment.entity';
import { FeedingDayPlan } from '../entities/feeding-day-plan.entity';
import { DayPlanRecalcService } from '../services/day-plan-recalc.service';
import {
  SENSOR_TEMPERATURE_RECALC_POLICY_V1,
  SensorTemperatureRecalcAuthority,
} from '../services/sensor-temperature-recalc.authority';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SENSOR = '22222222-2222-4222-8222-222222222222';
const UNIT_A = '33333333-3333-4333-8333-333333333333';
const UNIT_B = '44444444-4444-4444-8444-444444444444';
const MUTATION_INSTANT = '2026-07-20T10:15:00.000Z';

function mock<T>(implementation: Partial<T>): T {
  return implementation as T;
}

function governedUnitId(index: number): string {
  return `55555555-5555-4555-8555-${index.toString(16).padStart(12, '0')}`;
}

describe('SensorTemperatureRecalcAuthority', () => {
  const recalcForUnit = jest.fn().mockResolvedValue(null);
  const dayPlanRecalc = mock<DayPlanRecalcService>({ recalcForUnit });
  const authority = new SensorTemperatureRecalcAuthority(dayPlanRecalc);

  function harness(rows: readonly { unitId: string }[]) {
    const { mockDataSource, mockManager, mockQueryRunner } = createMockDataSource();
    const innerJoin = jest.fn();
    const select = jest.fn();
    const distinct = jest.fn();
    const where = jest.fn();
    const andWhere = jest.fn();
    const orderBy = jest.fn();
    const take = jest.fn();
    const getRawMany = jest.fn().mockResolvedValue([...rows]);
    const queryBuilder = mock<SelectQueryBuilder<FeedingDayPlan>>({
      innerJoin,
      select,
      distinct,
      where,
      andWhere,
      orderBy,
      take,
      getRawMany,
    });
    for (const chain of [innerJoin, select, distinct, where, andWhere, orderBy, take]) {
      chain.mockReturnValue(queryBuilder);
    }
    mockManager.createQueryBuilder.mockReturnValue(queryBuilder);
    mockQueryRunner.query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes('transaction_timestamp()') ? [{ mutationInstant: MUTATION_INSTANT }] : [],
      ),
    );
    return { mockDataSource, mockManager, innerJoin, orderBy, take };
  }

  beforeEach(() => {
    recalcForUnit.mockClear();
  });

  it('compiles entity-metadata targets and reprices each unit in canonical order under one session clock', async () => {
    const { mockDataSource, mockManager, innerJoin, orderBy, take } = harness([
      { unitId: UNIT_A },
      { unitId: UNIT_B },
    ]);

    const count = await runInTenantTransaction(
      mockDataSource,
      'farm',
      TENANT,
      (_queryRunner, mutationSession) =>
        authority.recalcAffectedUnits(mockManager, mutationSession, TENANT, SENSOR, 14.25),
    );

    expect(count).toBe(2);
    expect(mockManager.createQueryBuilder).toHaveBeenCalledWith(FeedingDayPlan, 'plan');
    expect(innerJoin).toHaveBeenCalledWith(
      Equipment,
      'unit',
      'unit.id = plan.unitId AND unit.tenantId = plan.tenantId',
    );
    expect(orderBy).toHaveBeenCalledWith('plan.unitId', 'ASC');
    expect(take).toHaveBeenCalledWith(SENSOR_TEMPERATURE_RECALC_POLICY_V1.maxUnitsPerReading + 1);
    expect(recalcForUnit).toHaveBeenCalledTimes(2);
    expect(recalcForUnit.mock.calls.map((call) => call[3])).toEqual([UNIT_A, UNIT_B]);
    expect(recalcForUnit.mock.calls[0]![0]).toBe(mockManager);
    expect(recalcForUnit.mock.calls[1]![1]).toBe(recalcForUnit.mock.calls[0]![1]);
    expect(recalcForUnit.mock.calls[1]![5].mutationInstant).toBe(
      recalcForUnit.mock.calls[0]![5].mutationInstant,
    );
    expect(recalcForUnit.mock.calls[0]![5].newTemperatureC).toBe(14.25);
  });

  it('fails closed before mutation when one reading exceeds its governed fan-out', async () => {
    const rows = Array.from(
      { length: SENSOR_TEMPERATURE_RECALC_POLICY_V1.maxUnitsPerReading + 1 },
      (_, index) => ({ unitId: governedUnitId(index) }),
    );
    const { mockDataSource, mockManager } = harness(rows);

    await expect(
      runInTenantTransaction(mockDataSource, 'farm', TENANT, (_queryRunner, mutationSession) =>
        authority.recalcAffectedUnits(mockManager, mutationSession, TENANT, SENSOR, 14.25),
      ),
    ).rejects.toThrow('exceeds the governed recalculation fan-out');

    expect(recalcForUnit).not.toHaveBeenCalled();
  });

  it('rejects duplicate or non-canonical target vectors instead of relying on query ordering', async () => {
    for (const rows of [
      [{ unitId: UNIT_A }, { unitId: UNIT_A }],
      [{ unitId: UNIT_B }, { unitId: UNIT_A }],
    ]) {
      const { mockDataSource, mockManager } = harness(rows);
      await expect(
        runInTenantTransaction(mockDataSource, 'farm', TENANT, (_queryRunner, mutationSession) =>
          authority.recalcAffectedUnits(mockManager, mutationSession, TENANT, SENSOR, 14.25),
        ),
      ).rejects.toThrow();
    }
    expect(recalcForUnit).not.toHaveBeenCalled();
  });
});
