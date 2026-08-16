import type { DataSource, EntityManager } from 'typeorm';

import type { DeadLetterEnvelope } from './dead-letter.contract';
import { TypeormDeadLetterSink } from './typeorm-dead-letter.sink';

function envelope(): DeadLetterEnvelope {
  return {
    subject: 'events.*.MealMissed',
    eventType: 'MealMissed',
    eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    payload: { eventType: 'MealMissed', mealId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    error: 'db down',
    deliveryCount: 3,
  };
}

describe('TypeormDeadLetterSink', () => {
  it('serializes duplicate terminal deliveries under one stable delivery key', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const manager = { query } as unknown as EntityManager;
    const dataSource = {
      transaction: jest.fn(async (work: (value: EntityManager) => Promise<void>) => work(manager)),
    } as unknown as DataSource;
    const sink = new TypeormDeadLetterSink(dataSource, {
      schema: 'alert',
      source: 'alert-engine',
    });

    await sink.record(envelope());

    expect(query).toHaveBeenCalledTimes(2);
    const lockKey = query.mock.calls[0]?.[1]?.[0];
    const insertParams = query.mock.calls[1]?.[1];
    expect(lockKey).toMatch(/^[a-f0-9]{64}$/);
    expect(insertParams?.[8]).toBe(lockKey);
    expect(JSON.parse(insertParams?.[7] as string)).toEqual({
      subject: 'events.*.MealMissed',
      deliveryKey: lockKey,
    });
    expect(String(query.mock.calls[1]?.[0])).toContain('WHERE NOT EXISTS');
  });

  it('rejects injectable schema identifiers at composition time', () => {
    const dataSource = {} as DataSource;
    expect(
      () =>
        new TypeormDeadLetterSink(dataSource, {
          schema: 'alert"; DROP SCHEMA alert; --',
          source: 'alert-engine',
        }),
    ).toThrow('safe SQL identifier');
  });
});
