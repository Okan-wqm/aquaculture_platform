import type { IEventBus } from '@platform/event-bus';
import { createBaseEvent } from '@platform/event-contracts';
import type {
  FeedingWindowReadinessVerdictV1,
  MealWindowUpcomingEvent,
} from '@platform/event-contracts';

import type { FeedingWindowReadinessService } from '../feeding-window-readiness.service';
import { FeedingWindowEventHandler } from '../feeding-window.handler';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function sourceEvent(overrides: Partial<MealWindowUpcomingEvent> = {}): MealWindowUpcomingEvent {
  return {
    ...createBaseEvent<MealWindowUpcomingEvent>('MealWindowUpcoming', TENANT_ID),
    timestamp: '2026-07-27T07:45:00.000Z',
    windowStart: '2026-07-27T07:45:00.000Z',
    windowEnd: '2026-07-27T08:00:00.000Z',
    leadMinutes: 15,
    batchIndex: 0,
    batchCount: 1,
    meals: [
      {
        unitId: '11111111-1111-4111-8111-111111111111',
        unitCode: 'TANK-A',
        dayPlanId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        mealId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        mealIndex: 0,
        scheduledAt: '2026-07-27T08:00:00.000Z',
        feedId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        plannedKg: 12.5,
        protocolId: '99999999-9999-4999-8999-999999999999',
        minDissolvedOxygen: 6,
      },
    ],
    ...overrides,
  };
}

function verdict(): FeedingWindowReadinessVerdictV1 {
  return {
    unitId: '11111111-1111-4111-8111-111111111111',
    unitCode: 'TANK-A',
    dayPlanId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    mealId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    scheduledAt: '2026-07-27T08:00:00.000Z',
    status: 'ready',
    minDissolvedOxygen: 6,
    observedDissolvedOxygen: 6.2,
    observedAt: '2026-07-27T07:44:00.000Z',
  };
}

describe('FeedingWindowEventHandler', () => {
  const evaluate = jest.fn();
  const publish = jest.fn();
  const subscribeWildcard = jest.fn();
  const handler = new FeedingWindowEventHandler(
    { evaluate } as unknown as FeedingWindowReadinessService,
    { publish, subscribeWildcard } as unknown as IEventBus,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('publishes one complete versioned verdict batch preserving source coordinates', async () => {
    evaluate.mockResolvedValue([verdict()]);
    publish.mockResolvedValue(undefined);
    const source = sourceEvent();

    await handler.handle(source);

    expect(evaluate).toHaveBeenCalledWith(
      TENANT_ID,
      source.meals,
      new Date('2026-07-27T07:45:00.000Z'),
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'FeedingWindowReadiness',
        tenantId: TENANT_ID,
        schemaVersion: 'feeding-window-readiness/v1',
        sourceWindowEventId: String(source.eventId),
        batchIndex: 0,
        batchCount: 1,
        verdicts: [verdict()],
      }),
    );
  });

  it('does not emit an ambiguous empty readiness answer', async () => {
    evaluate.mockResolvedValue([]);

    await handler.handle(sourceEvent());

    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects a malformed tenant before database evaluation', async () => {
    await expect(handler.handle(sourceEvent({ tenantId: 'not-a-uuid' }))).rejects.toThrow(
      'valid tenantId',
    );
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('acknowledges a reproducible evaluation failure for the next governed sweep', async () => {
    evaluate.mockRejectedValue(new Error('sensor projection unavailable'));

    await expect(handler.handle(sourceEvent())).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
  });
});
