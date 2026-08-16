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
const EVALUATED_AT = new Date('2026-07-27T07:45:00.000Z');

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

function serviceWithRows(rows: readonly Record<string, unknown>[]): FeedingWindowReadinessService {
  runInTenantRead.mockReset();
  runInTenantRead.mockImplementation(
    async (
      _dataSource: unknown,
      _schema: unknown,
      _tenant: unknown,
      work: (queryRunner: { query: jest.Mock }) => Promise<unknown>,
    ) => work({ query: jest.fn().mockResolvedValue(rows) }),
  );
  return new FeedingWindowReadinessService(
    {} as ConstructorParameters<typeof FeedingWindowReadinessService>[0],
  );
}

describe('FeedingWindowReadinessService', () => {
  it('returns one explicit verdict for every guarded meal', async () => {
    const service = serviceWithRows([
      {
        unitId: UNIT_A,
        instrumented: true,
        dissolvedOxygen: '4.2',
        observedAt: '2026-07-27T07:40:00.000Z',
      },
      { unitId: UNIT_B, instrumented: false, dissolvedOxygen: null, observedAt: null },
    ]);

    const verdicts = await service.evaluate(
      TENANT,
      [
        entry(),
        entry({
          unitId: UNIT_B,
          unitCode: 'TANK-B',
          mealId: 'abababab-abab-4bab-8bab-abababababab',
        }),
      ],
      EVALUATED_AT,
    );

    expect(verdicts.map(({ status }) => status)).toEqual(['low_oxygen', 'not_instrumented']);
    expect(runInTenantRead).toHaveBeenCalledTimes(1);
  });

  it('distinguishes ready from an instrumented unit with no fresh reading', async () => {
    const service = serviceWithRows([
      {
        unitId: UNIT_A,
        instrumented: true,
        dissolvedOxygen: 6,
        observedAt: '2026-07-27T07:40:00.000Z',
      },
      { unitId: UNIT_B, instrumented: true, dissolvedOxygen: null, observedAt: null },
    ]);

    const verdicts = await service.evaluate(
      TENANT,
      [
        entry(),
        entry({
          unitId: UNIT_B,
          mealId: 'abababab-abab-4bab-8bab-abababababab',
        }),
      ],
      EVALUATED_AT,
    );
    expect(verdicts.map(({ status }) => status)).toEqual(['ready', 'no_reading']);
  });

  it('uses the tenant-local sensor_metrics/channel projection in one bounded query', async () => {
    let sql = '';
    let params: readonly unknown[] = [];
    runInTenantRead.mockReset();
    runInTenantRead.mockImplementation(
      async (
        _dataSource: unknown,
        _schema: unknown,
        _tenant: unknown,
        work: (queryRunner: {
          query: (text: string, values: unknown[]) => Promise<unknown[]>;
        }) => Promise<unknown>,
      ) =>
        work({
          query: async (text, values) => {
            sql = text;
            params = values;
            return [];
          },
        }),
    );
    const service = new FeedingWindowReadinessService(
      {} as ConstructorParameters<typeof FeedingWindowReadinessService>[0],
    );

    await service.evaluate(TENANT, [entry()], EVALUATED_AT);

    expect(sql).toContain('FROM sensor_metrics m');
    expect(sql).toContain("c.channel_key = 'dissolved_oxygen'");
    expect(sql).toContain('m.tenant_id = $2::uuid');
    expect(sql).not.toContain('sensor_readings');
    expect(params[1]).toBe(TENANT);
    expect(params[3]).toBe(EVALUATED_AT.toISOString());
  });

  it('does not query when no meal opts into the oxygen guard', async () => {
    const service = serviceWithRows([]);
    await expect(
      service.evaluate(TENANT, [entry({ minDissolvedOxygen: undefined })], EVALUATED_AT),
    ).resolves.toEqual([]);
    expect(runInTenantRead).not.toHaveBeenCalled();
  });

  it('rejects malformed guarded entries and oversize batches instead of truncating', async () => {
    const service = serviceWithRows([]);
    await expect(
      service.evaluate(TENANT, [entry({ unitId: 'not-a-uuid' })], EVALUATED_AT),
    ).rejects.toThrow('UUID unitId');
    await expect(
      service.evaluate(
        TENANT,
        Array.from({ length: 501 }, () => entry()),
        EVALUATED_AT,
      ),
    ).rejects.toThrow('exceeds 500');
  });
});
