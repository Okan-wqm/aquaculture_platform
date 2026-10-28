import { ConfigService } from '@nestjs/config';

import type { DeadLetterRecord, IDeadLetterSink } from '../../interfaces/dead-letter-sink';
import type { IEvent, IEventHandler } from '../../interfaces/event-bus.interface';
import type { IEventHandlerScope } from '../../interfaces/event-handler-scope';
import { HandlerOutcome } from '../../interfaces/handler-outcome';
import { NatsEventBus } from '../nats-event-bus';

/**
 * PLAT-HIGH-936 — a handler runs INSIDE the scope its service binds for the
 * event's tenant, and so does the dead-letter record of that event.
 *
 * A NATS handler has no HTTP request behind it, so nothing binds the tenant to
 * the database session: a write to an RLS-protected table is refused (the
 * notification-service task handlers failed on `notification_logs` every 30 s).
 * The bus is the one place every handler passes through, so the scope is bound
 * there once instead of being re-implemented (or forgotten) in each handler.
 */
const SUBJECT = 'events.*.TaskOverdue';
const TENANT = '11111111-1111-4111-8111-111111111111';

interface FakeJsMsg {
  ack: jest.Mock;
  nak: jest.Mock;
  term: jest.Mock;
  string: () => string;
  info: { deliveryCount: number };
}

function event(): IEvent {
  return {
    eventId: '55555555-5555-4555-8555-555555555555',
    eventType: 'TaskOverdue',
    timestamp: '2026-10-27T12:00:00.000Z',
    tenantId: TENANT,
    version: 2,
  };
}

function jsMsg(): FakeJsMsg {
  return {
    ack: jest.fn(),
    nak: jest.fn(),
    term: jest.fn(),
    string: () => JSON.stringify(event()),
    info: { deliveryCount: 1 },
  };
}

/** A scope that records what ran inside it and what ran outside. */
function recordingScope(): { scope: IEventHandlerScope; inside: () => boolean; tenants: string[] } {
  let depth = 0;
  const tenants: string[] = [];
  const scope: IEventHandlerScope = {
    run: async <T>(scoped: IEvent, work: () => Promise<T>): Promise<T> => {
      depth += 1;
      tenants.push(String(scoped.tenantId));
      try {
        return await work();
      } finally {
        depth -= 1;
      }
    },
  };
  return { scope, inside: () => depth > 0, tenants };
}

function harness(
  handler: IEventHandler<IEvent>,
  scope?: IEventHandlerScope,
  sink?: IDeadLetterSink,
): { process: (msg: FakeJsMsg) => Promise<void> } {
  const bus = new NatsEventBus(
    new ConfigService({
      NATS_STREAM_NAME: 'AQUACULTURE_EVENTS',
      SERVICE_NAME: 'notification-service',
    }),
    undefined,
    undefined,
    sink,
    scope,
  );
  Reflect.set(bus, 'handlers', new Map([[SUBJECT, [handler]]]));
  Reflect.set(bus, 'subscriptionOptions', new Map([[SUBJECT, { maxRetries: 5 }]]));
  Reflect.set(bus, 'jetStream', { publish: jest.fn(() => Promise.resolve({ seq: 1 })) });
  const process = (msg: FakeJsMsg): Promise<void> =>
    (
      Reflect.get(bus, 'processConsumerMessage') as (
        this: NatsEventBus,
        subject: string,
        msg: FakeJsMsg,
      ) => Promise<void>
    ).call(bus, SUBJECT, msg);
  return { process };
}

describe('NatsEventBus handler scope (PLAT-HIGH-936)', () => {
  it('runs every handler inside the scope bound for the event, and only inside it', async () => {
    const { scope, inside, tenants } = recordingScope();
    const ranInside: boolean[] = [];
    const handler: IEventHandler<IEvent> = {
      getEventType: () => 'TaskOverdue',
      handle: jest.fn(() => {
        ranInside.push(inside());
        return Promise.resolve(HandlerOutcome.ack());
      }),
    };
    const { process } = harness(handler, scope);
    const msg = jsMsg();

    await process(msg);

    expect(ranInside).toEqual([true]);
    expect(tenants).toEqual([TENANT]);
    expect(inside()).toBe(false); // released: nothing leaks to the next message
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });

  it('releases the scope when the handler throws, and still classifies the failure', async () => {
    const { scope, inside } = recordingScope();
    const handler: IEventHandler<IEvent> = {
      getEventType: () => 'TaskOverdue',
      handle: jest.fn(() => Promise.reject(new Error('connection reset'))),
    };
    const { process } = harness(handler, scope);
    const msg = jsMsg();

    await process(msg);

    expect(inside()).toBe(false);
    expect(msg.nak).toHaveBeenCalledTimes(1); // transient: retried, not lost
  });

  it('records the dead letter of an event inside the same scope', async () => {
    const { scope, inside } = recordingScope();
    const recordedInside: boolean[] = [];
    const sink: IDeadLetterSink = {
      record: jest.fn((_record: DeadLetterRecord) => {
        recordedInside.push(inside());
        return Promise.resolve();
      }),
    };
    const handler: IEventHandler<IEvent> = {
      getEventType: () => 'TaskOverdue',
      handle: jest.fn(() => Promise.resolve(HandlerOutcome.terminate('malformed task'))),
    };
    const { process } = harness(handler, scope, sink);
    const msg = jsMsg();

    await process(msg);

    expect(recordedInside).toEqual([true]);
    expect(msg.term).toHaveBeenCalledTimes(1);
  });

  it('without a bound scope the handler runs exactly as before', async () => {
    const handler: IEventHandler<IEvent> = {
      getEventType: () => 'TaskOverdue',
      handle: jest.fn(() => Promise.resolve(HandlerOutcome.ack())),
    };
    const { process } = harness(handler);
    const msg = jsMsg();

    await process(msg);

    expect(handler.handle).toHaveBeenCalledTimes(1);
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });
});
