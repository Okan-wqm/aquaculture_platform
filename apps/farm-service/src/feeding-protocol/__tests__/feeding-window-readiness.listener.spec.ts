import { createBaseEvent } from '@platform/event-contracts';
import type { BaseEvent, FeedingWindowReadinessEvent } from '@platform/event-contracts';

const runInTenantTransaction = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  isValidUUID: (value: unknown): boolean =>
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
  runInTenantTransaction: (...args: unknown[]): unknown => runInTenantTransaction(...args),
}));

import { FeedingWindowReadinessListener } from '../listeners/feeding-window-readiness.listener';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOURCE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function event(overrides: Partial<FeedingWindowReadinessEvent> = {}): FeedingWindowReadinessEvent {
  return {
    ...createBaseEvent<FeedingWindowReadinessEvent>('FeedingWindowReadiness', TENANT),
    timestamp: '2026-07-27T07:45:00.000Z',
    schemaVersion: 'feeding-window-readiness/v1',
    sourceWindowEventId: SOURCE,
    windowStart: '2026-07-27T07:45:00.000Z',
    windowEnd: '2026-07-27T08:45:00.000Z',
    evaluatedAt: '2026-07-27T07:45:00.000Z',
    batchIndex: 0,
    batchCount: 1,
    verdicts: [
      {
        unitId: '11111111-1111-4111-8111-111111111111',
        unitCode: 'TANK-A',
        mealId: '22222222-2222-4222-8222-222222222222',
        dayPlanId: '33333333-3333-4333-8333-333333333333',
        scheduledAt: '2026-07-27T08:00:00.000Z',
        status: 'low_oxygen',
        minDissolvedOxygen: 6,
        observedDissolvedOxygen: 4.2,
        observedAt: '2026-07-27T07:40:00.000Z',
      },
    ],
    ...overrides,
  };
}

function eventBus(): ConstructorParameters<typeof FeedingWindowReadinessListener>[1] {
  return { subscribeWildcard: jest.fn() } as unknown as ConstructorParameters<
    typeof FeedingWindowReadinessListener
  >[1];
}

describe('FeedingWindowReadinessListener', () => {
  beforeEach(() => {
    runInTenantTransaction.mockReset();
  });

  it('projects the complete batch in one tenant transaction with newest-wins fencing', async () => {
    let sql = '';
    let params: readonly unknown[] = [];
    runInTenantTransaction.mockImplementation(
      async (
        _dataSource: unknown,
        _schema: unknown,
        _tenantId: unknown,
        work: (queryRunner: {
          query: (text: string, values: unknown[]) => Promise<void>;
        }) => Promise<void>,
      ) =>
        work({
          query: async (text, values) => {
            sql = text;
            params = values;
          },
        }),
    );
    const listener = new FeedingWindowReadinessListener(
      {} as ConstructorParameters<typeof FeedingWindowReadinessListener>[0],
      eventBus(),
    );

    await listener.handle(event() as BaseEvent);

    expect(runInTenantTransaction).toHaveBeenCalledTimes(1);
    expect(sql).toContain('jsonb_to_recordset');
    expect(sql).toContain('meal."readiness"->>\'evaluatedAt\' <');
    const rows = JSON.parse(params[0] as string) as Array<{
      readiness: { schemaVersion: string; sourceWindowEventId: string; status: string };
    }>;
    expect(rows).toEqual([
      expect.objectContaining({
        readiness: expect.objectContaining({
          schemaVersion: 'feeding-meal-readiness/v1',
          sourceWindowEventId: SOURCE,
          status: 'low_oxygen',
        }),
      }),
    ]);
    expect(params[1]).toBe(TENANT);
  });

  it('rejects duplicate meal verdicts instead of applying order-dependent state', async () => {
    const duplicate = event();
    await expect(
      new FeedingWindowReadinessListener(
        {} as ConstructorParameters<typeof FeedingWindowReadinessListener>[0],
        eventBus(),
      ).handle(event({ verdicts: [duplicate.verdicts[0]!, duplicate.verdicts[0]!] }) as BaseEvent),
    ).rejects.toThrow('duplicate verdict');
    expect(runInTenantTransaction).not.toHaveBeenCalled();
  });

  it('fails closed on malformed tenant or schema version', async () => {
    const listener = new FeedingWindowReadinessListener(
      {} as ConstructorParameters<typeof FeedingWindowReadinessListener>[0],
      eventBus(),
    );
    await expect(listener.handle(event({ tenantId: 'bad' }) as BaseEvent)).rejects.toThrow(
      'Malformed',
    );
    await expect(
      listener.handle(
        event({
          schemaVersion: 'legacy' as FeedingWindowReadinessEvent['schemaVersion'],
        }) as BaseEvent,
      ),
    ).rejects.toThrow('Malformed');
  });
});
