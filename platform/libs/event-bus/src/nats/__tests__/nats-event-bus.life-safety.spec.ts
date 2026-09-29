import { ConfigService } from '@nestjs/config';

import type { DeadLetterRecord } from '../../interfaces/dead-letter-sink';
import type {
  IEvent,
  IEventHandler,
  SubscriptionOptions,
} from '../../interfaces/event-bus.interface';
import { HandlerOutcome, redeliveryBackoffMs } from '../../interfaces/handler-outcome';
import {
  LIFE_SAFETY_REDELIVERY,
  redeliveryPolicyCovering,
  redeliverySpanMs,
} from '../../interfaces/redelivery-policy';
import { NatsEventBus } from '../nats-event-bus';

/**
 * V-S1a-3 — life-safety consumers outlive an outage. The bus gives every
 * life-safety event type the hour-long budget automatically; a still-failing
 * alarm is dead-lettered only after it (and then pages the operator via
 * `event_bus_dead_letter_total`).
 */
const SUBJECT = 'events.*.AlertEscalated';
const TENANT = '11111111-1111-4111-8111-111111111111';

function bus(): NatsEventBus {
  return new NatsEventBus(
    new ConfigService({
      NATS_STREAM_NAME: 'AQUACULTURE_EVENTS',
      SERVICE_NAME: 'notification-service',
    }),
  );
}

function handler(outcome: HandlerOutcome): IEventHandler<IEvent> {
  return { getEventType: () => 'AlertEscalated', handle: jest.fn(() => Promise.resolve(outcome)) };
}

function options(target: NatsEventBus, subject: string): SubscriptionOptions | undefined {
  const map = Reflect.get(target, 'subscriptionOptions') as Map<
    string,
    SubscriptionOptions | undefined
  >;
  return map.get(subject);
}

describe('LIFE_SAFETY_REDELIVERY', () => {
  it('spans at least one hour with steps capped at five minutes', () => {
    expect(redeliverySpanMs(LIFE_SAFETY_REDELIVERY)).toBeGreaterThanOrEqual(60 * 60 * 1000);
    expect(LIFE_SAFETY_REDELIVERY.maxBackoffMs).toBe(5 * 60 * 1000);
  });

  it('is the smallest budget covering the span (derived, never hand-counted)', () => {
    const shorter = {
      ...LIFE_SAFETY_REDELIVERY,
      maxDeliveries: LIFE_SAFETY_REDELIVERY.maxDeliveries - 1,
    };
    expect(redeliverySpanMs(shorter)).toBeLessThan(60 * 60 * 1000);
    expect(redeliveryPolicyCovering({ minimumSpanMs: 0, maxBackoffMs: 1000 }).maxDeliveries).toBe(
      1,
    );
  });

  it('caps a backoff step at the policy cap instead of the 30-second bus default', () => {
    expect(redeliveryBackoffMs(12)).toBe(30_000);
    expect(redeliveryBackoffMs(12, LIFE_SAFETY_REDELIVERY.maxBackoffMs)).toBe(300_000);
  });
});

describe('NatsEventBus — life-safety subscriptions (V-S1a-3)', () => {
  it('gives a life-safety event type the budget automatically', async () => {
    // SCENARIO: notification-service subscribes to AlertEscalated with no options.
    // EXPECTS: the subscription carries LIFE_SAFETY_REDELIVERY.
    const target = bus();
    await target.subscribeWildcard('AlertEscalated', handler(HandlerOutcome.ack()));

    expect(options(target, SUBJECT)?.redelivery).toEqual(LIFE_SAFETY_REDELIVERY);
  });

  it('leaves continuous telemetry on the bus default', async () => {
    const target = bus();
    await target.subscribeWildcard('SensorReading', {
      getEventType: () => 'SensorReading',
      handle: () => Promise.resolve(HandlerOutcome.ack()),
    });

    const all = Reflect.get(target, 'subscriptionOptions') as Map<
      string,
      SubscriptionOptions | undefined
    >;
    for (const value of all.values()) expect(value?.redelivery).toBeUndefined();
  });

  function processing(outcome: HandlerOutcome): {
    process: (deliveryCount: number) => Promise<{ nak: jest.Mock; term: jest.Mock }>;
    recorded: DeadLetterRecord[];
  } {
    const recorded: DeadLetterRecord[] = [];
    const target = new NatsEventBus(
      new ConfigService({
        NATS_STREAM_NAME: 'AQUACULTURE_EVENTS',
        SERVICE_NAME: 'notification-service',
      }),
      undefined,
      undefined,
      {
        record: (record: DeadLetterRecord) => {
          recorded.push(record);
          return Promise.resolve();
        },
      },
    );
    Reflect.set(target, 'handlers', new Map([[SUBJECT, [handler(outcome)]]]));
    Reflect.set(
      target,
      'subscriptionOptions',
      new Map([[SUBJECT, { redelivery: LIFE_SAFETY_REDELIVERY }]]),
    );
    Reflect.set(target, 'jetStream', { publish: jest.fn(() => Promise.resolve({ seq: 1 })) });
    const event: IEvent = {
      eventId: '55555555-5555-4555-8555-555555555555',
      eventType: 'AlertEscalated',
      timestamp: '2026-09-29T04:12:00.000Z',
      tenantId: TENANT,
      version: 3,
    };
    const process = async (deliveryCount: number): Promise<{ nak: jest.Mock; term: jest.Mock }> => {
      const msg = {
        ack: jest.fn(),
        nak: jest.fn(),
        term: jest.fn(),
        string: () => JSON.stringify(event),
        info: { deliveryCount },
        subject: 'events.t.AlertEscalated',
        seq: 7,
      };
      await (
        Reflect.get(target, 'processConsumerMessage') as (
          this: NatsEventBus,
          subject: string,
          msg: unknown,
        ) => Promise<void>
      ).call(target, SUBJECT, msg);
      return { nak: msg.nak, term: msg.term };
    };
    return { process, recorded };
  }

  it('keeps redelivering a failing alarm past the 30-second default, on capped steps', async () => {
    // SCENARIO: auth-service is down; delivery 10 of an escalated page still fails.
    // EXPECTS: a 5-minute nak — the old budget had dead-lettered it at delivery 5.
    const { process, recorded } = processing(HandlerOutcome.retry('auth 503'));

    const { nak, term } = await process(10);

    expect(nak).toHaveBeenCalledWith(300_000);
    expect(term).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(0);
  });

  it('dead-letters only when the hour-long budget is spent', async () => {
    const { process, recorded } = processing(HandlerOutcome.retry('auth 503'));

    const { term } = await process(LIFE_SAFETY_REDELIVERY.maxDeliveries);

    expect(term).toHaveBeenCalledTimes(1);
    expect(recorded).toEqual([
      expect.objectContaining({
        disposition: 'retry-exhausted',
        maxDeliver: LIFE_SAFETY_REDELIVERY.maxDeliveries,
      }),
    ]);
  });
});
