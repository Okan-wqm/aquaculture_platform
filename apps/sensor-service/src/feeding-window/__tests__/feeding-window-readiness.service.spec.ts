/**
 * FeedingWindowReadinessService (W7 — FARM-MEDIUM-271)
 *
 * Pins the verdict rules, which are the whole point of the service:
 *   - only entries that DECLARE an oxygen floor are evaluated (the protocol
 *     opted in; everything else was never promised a check),
 *   - a unit with NO DO sensor produces NO verdict — reporting it would page an
 *     operator about every non-instrumented tank,
 *   - a unit WITH a sensor but no fresh reading produces `no_reading`, because
 *     the guard the operator configured is not actually guarding anything,
 *   - a fresh reading at/above the floor is silent (only decisions go on the
 *     wire; ~500 "ready" events per tick would be noise),
 *   - the tenant read runs through `runInTenantRead` (per-tenant tables), and
 *     the whole batch is ONE query.
 */
import type { MealWindowEntry } from '@platform/event-contracts';

const runInTenantRead = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  runInTenantRead: (...args: unknown[]): unknown => runInTenantRead(...args),
  isValidUUID: (value: unknown): boolean =>
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
}));

import { FeedingWindowReadinessService } from '../feeding-window-readiness.service';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UNIT_A = '11111111-1111-4111-8111-111111111111';
const UNIT_B = '22222222-2222-4222-8222-222222222222';
const UNIT_C = '33333333-3333-4333-8333-333333333333';

interface OxygenRow {
  unitId: string;
  dissolvedOxygen: string | null;
  observedAt: Date | null;
}

function entry(overrides: Partial<MealWindowEntry> = {}): MealWindowEntry {
  return {
    unitId: UNIT_A,
    unitCode: 'TANK-A',
    dayPlanId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    mealId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    mealIndex: 0,
    scheduledAt: '2026-07-27T08:00:00.000Z',
    feedId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    plannedKg: 12.5,
    protocolId: '99999999-9999-4999-8999-999999999999',
    minDissolvedOxygen: 6,
    lowOxygenReductionPercent: 30,
    ...overrides,
  };
}

function makeService(rows: OxygenRow[]): FeedingWindowReadinessService {
  runInTenantRead.mockReset();
  runInTenantRead.mockResolvedValue(rows);
  // The service only uses the DataSource by handing it to runInTenantRead,
  // which is mocked — a bare object is a faithful double, not a cast-around.
  return new FeedingWindowReadinessService(
    {} as ConstructorParameters<typeof FeedingWindowReadinessService>[0],
  );
}

describe('FeedingWindowReadinessService', () => {
  it('flags a fresh reading below the protocol floor as low_oxygen', async () => {
    const observedAt = new Date('2026-07-27T07:45:00.000Z');
    const service = makeService([
      { unitId: UNIT_A, dissolvedOxygen: '4.2', observedAt },
    ]);

    const verdicts = await service.evaluate(TENANT, [entry()]);

    expect(verdicts).toHaveLength(1);
    const [verdict] = verdicts;
    expect(verdict?.status).toBe('low_oxygen');
    expect(verdict?.observedDissolvedOxygen).toBe(4.2);
    expect(verdict?.observedAt).toBe(observedAt.toISOString());
    expect(verdict?.entry.unitCode).toBe('TANK-A');
  });

  it('stays silent when the reading is at or above the floor', async () => {
    const service = makeService([
      { unitId: UNIT_A, dissolvedOxygen: '6', observedAt: new Date() },
    ]);

    await expect(service.evaluate(TENANT, [entry()])).resolves.toEqual([]);
  });

  it('reports no_reading when the unit has a sensor but no fresh measurement', async () => {
    const service = makeService([
      { unitId: UNIT_A, dissolvedOxygen: null, observedAt: null },
    ]);

    const verdicts = await service.evaluate(TENANT, [entry()]);

    expect(verdicts).toHaveLength(1);
    const [verdict] = verdicts;
    expect(verdict?.status).toBe('no_reading');
    expect(verdict?.observedDissolvedOxygen).toBeUndefined();
  });

  it('produces NO verdict for a unit with no DO sensor at all', async () => {
    // No row comes back for UNIT_B — nothing was ever promised for it.
    const service = makeService([]);

    await expect(
      service.evaluate(TENANT, [entry({ unitId: UNIT_B, unitCode: 'TANK-B' })]),
    ).resolves.toEqual([]);
  });

  it('ignores entries that declare no oxygen floor, and queries nothing when none do', async () => {
    const service = makeService([]);

    await expect(
      service.evaluate(TENANT, [entry({ minDissolvedOxygen: undefined })]),
    ).resolves.toEqual([]);
    expect(runInTenantRead).not.toHaveBeenCalled();
  });

  it('evaluates the whole batch with ONE tenant-scoped read', async () => {
    const service = makeService([
      { unitId: UNIT_A, dissolvedOxygen: '3.0', observedAt: new Date() },
      { unitId: UNIT_C, dissolvedOxygen: '9.0', observedAt: new Date() },
    ]);

    const verdicts = await service.evaluate(TENANT, [
      entry({ unitId: UNIT_A, unitCode: 'TANK-A' }),
      entry({ unitId: UNIT_B, unitCode: 'TANK-B' }),
      entry({ unitId: UNIT_C, unitCode: 'TANK-C' }),
    ]);

    expect(runInTenantRead).toHaveBeenCalledTimes(1);
    const [, sourceSchema, tenantId] = runInTenantRead.mock.calls[0];
    expect(sourceSchema).toBe('sensor');
    expect(tenantId).toBe(TENANT);
    expect(verdicts.map((v) => v.entry.unitCode)).toEqual(['TANK-A']);
  });

  it('skips a malformed unitId rather than letting it reach the tenant read', async () => {
    const service = makeService([]);

    await expect(
      service.evaluate(TENANT, [entry({ unitId: 'not-a-uuid' })]),
    ).resolves.toEqual([]);
    expect(runInTenantRead).not.toHaveBeenCalled();
  });
});
