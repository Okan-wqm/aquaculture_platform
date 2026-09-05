import { ConfigService } from '@nestjs/config';

import type { DeadLetterRecord, IDeadLetterSink } from '../../interfaces/dead-letter-sink';
import type { IEvent, IEventHandler } from '../../interfaces/event-bus.interface';
import { HandlerOutcome } from '../../interfaces/handler-outcome';
import { NatsEventBus } from '../nats-event-bus';

/**
 * PLAT-HIGH-902 — the bus folds handler outcomes into ONE JetStream
 * disposition and records every terminated message in the dead-letter sink.
 * `processConsumerMessage` is exercised directly with a fake JsMsg (the same
 * Reflect-based harness as compliance-subscription.spec).
 */
const SUBJECT = 'events.*.PasswordResetRequested';
const TENANT = '11111111-1111-4111-8111-111111111111';

interface FakeJsMsg {
  ack: jest.Mock;
  nak: jest.Mock;
  term: jest.Mock;
  string: () => string;
  info: { deliveryCount: number };
}

function config(): ConfigService {
  return new ConfigService({
    NATS_STREAM_NAME: 'AQUACULTURE_EVENTS',
    SERVICE_NAME: 'notification-service',
  });
}

function event(): IEvent {
  return {
    eventId: '55555555-5555-4555-8555-555555555555',
    eventType: 'PasswordResetRequested',
    timestamp: '2026-09-05T12:00:00.000Z',
    tenantId: TENANT,
    version: 2,
  };
}

function jsMsg(deliveryCount = 1): FakeJsMsg {
  return {
    ack: jest.fn(),
    nak: jest.fn(),
    term: jest.fn(),
    string: () => JSON.stringify(event()),
    info: { deliveryCount },
  };
}

function handler(outcome: () => Promise<HandlerOutcome>): IEventHandler<IEvent> {
  return { getEventType: () => 'PasswordResetRequested', handle: jest.fn(outcome) };
}

/** A handler double that resolves to something that is NOT an outcome (contract violation). */
function handlerResolving(value: unknown): IEventHandler<IEvent> {
  return {
    getEventType: () => 'PasswordResetRequested',
    handle: jest.fn().mockResolvedValue(value),
  };
}

function harness(
  handlers: IEventHandler<IEvent>[],
  options: { maxRetries?: number } = {},
  sink?: IDeadLetterSink,
): { bus: NatsEventBus; process: (msg: FakeJsMsg) => Promise<void>; sink: IDeadLetterSink } {
  const recorded: DeadLetterRecord[] = [];
  const deadLetterSink: IDeadLetterSink = sink ?? {
    record: jest.fn(async (record: DeadLetterRecord) => {
      recorded.push(record);
    }),
  };
  const bus = new NatsEventBus(config(), undefined, undefined, deadLetterSink);
  Reflect.set(bus, 'handlers', new Map([[SUBJECT, handlers]]));
  Reflect.set(bus, 'subscriptionOptions', new Map([[SUBJECT, options]]));
  const process = (msg: FakeJsMsg): Promise<void> =>
    (
      Reflect.get(bus, 'processConsumerMessage') as (
        this: NatsEventBus,
        subject: string,
        msg: FakeJsMsg,
      ) => Promise<void>
    ).call(bus, SUBJECT, msg);
  return { bus, process, sink: deadLetterSink };
}

describe('NatsEventBus handler outcome fold (PLAT-HIGH-902)', () => {
  it('acks when every handler acks', async () => {
    const { process } = harness([handler(async () => HandlerOutcome.ack())]);
    const msg = jsMsg();
    await process(msg);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.nak).not.toHaveBeenCalled();
    expect(msg.term).not.toHaveBeenCalled();
  });

  it('naks with backoff when a handler asks for a retry', async () => {
    const { process, sink } = harness([
      handler(async () => HandlerOutcome.ack()),
      handler(async () => HandlerOutcome.retry('smtp 503')),
    ]);
    const msg = jsMsg(2);
    await process(msg);
    expect(msg.nak).toHaveBeenCalledWith(4000);
    expect(msg.ack).not.toHaveBeenCalled();
    expect(sink.record).not.toHaveBeenCalled();
  });

  it('folds a thrown error as a retry (the previous behaviour, made explicit)', async () => {
    const { process } = harness([
      handler(async () => {
        throw new Error('db down');
      }),
    ]);
    const msg = jsMsg(1);
    await process(msg);
    expect(msg.nak).toHaveBeenCalledWith(2000);
  });

  it('terminates and dead-letters when a handler terminates', async () => {
    const cause = new Error('bad scope');
    const { process, sink } = harness([
      handler(async () => HandlerOutcome.terminate('invalid tenancy scope', cause)),
    ]);
    const msg = jsMsg(1);
    await process(msg);
    expect(msg.term).toHaveBeenCalledWith('invalid tenancy scope');
    expect(msg.ack).not.toHaveBeenCalled();
    expect(sink.record).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: SUBJECT,
        event: expect.objectContaining({ eventType: 'PasswordResetRequested', tenantId: TENANT }),
        disposition: 'terminated',
        reason: 'invalid tenancy scope',
        deliveryCount: 1,
        maxDeliver: 3,
        cause,
      }),
    );
  });

  it('retry outranks terminate across handlers of one message', async () => {
    const { process, sink } = harness([
      handler(async () => HandlerOutcome.terminate('legacy')),
      handler(async () => HandlerOutcome.retry('transient')),
    ]);
    const msg = jsMsg(1);
    await process(msg);
    expect(msg.nak).toHaveBeenCalledTimes(1);
    expect(msg.term).not.toHaveBeenCalled();
    expect(sink.record).not.toHaveBeenCalled();
  });

  it('dead-letters a retry once the delivery budget is spent (retry-exhausted)', async () => {
    const { process, sink } = harness([handler(async () => HandlerOutcome.retry('still down'))], {
      maxRetries: 3,
    });
    const msg = jsMsg(3);
    await process(msg);
    expect(msg.term).toHaveBeenCalledTimes(1);
    expect(msg.nak).not.toHaveBeenCalled();
    expect(sink.record).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: 'retry-exhausted', deliveryCount: 3, maxDeliver: 3 }),
    );
  });

  it('never exhausts an unlimited consumer (maxRetries -1)', async () => {
    const { process, sink } = harness([handler(async () => HandlerOutcome.retry('x'))], {
      maxRetries: -1,
    });
    const msg = jsMsg(40);
    await process(msg);
    expect(msg.nak).toHaveBeenCalledWith(30_000);
    expect(sink.record).not.toHaveBeenCalled();
  });

  it('terminates loudly when a handler returns no outcome', async () => {
    const { process, sink } = harness([handlerResolving(undefined)]);
    const msg = jsMsg(1);
    await process(msg);
    expect(msg.term).toHaveBeenCalledWith(
      'handler returned no HandlerOutcome (contract violation)',
    );
    expect(sink.record).toHaveBeenCalledTimes(1);
  });

  it('still terminates when the dead-letter sink itself fails', async () => {
    const failingSink: IDeadLetterSink = {
      record: jest.fn().mockRejectedValue(new Error('db unavailable')),
    };
    const { process } = harness(
      [handler(async () => HandlerOutcome.terminate('poison'))],
      {},
      failingSink,
    );
    const msg = jsMsg(1);
    await process(msg);
    expect(msg.term).toHaveBeenCalledWith('poison');
  });

  it('naks an undeserializable message (a malformed frame is not a handler outcome)', async () => {
    const { process, sink } = harness([handler(async () => HandlerOutcome.ack())]);
    const msg = { ...jsMsg(1), string: () => '{not json' };
    await process(msg);
    expect(msg.nak).toHaveBeenCalledTimes(1);
    expect(sink.record).not.toHaveBeenCalled();
  });
});
