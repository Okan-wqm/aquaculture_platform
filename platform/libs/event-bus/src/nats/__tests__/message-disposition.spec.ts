import type { DeadLetterEnvelope, DeadLetterSink } from '@aquaculture/backend-common/events';

import {
  redeliveryBackoffMs,
  settleFailedMessage,
  type AckableMessage,
  type DispositionLogger,
} from '../message-disposition';

function envelope(deliveryCount: number): DeadLetterEnvelope {
  return {
    subject: 'events.*.MealMissed',
    eventType: 'MealMissed',
    eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    payload: { eventType: 'MealMissed' },
    error: '',
    deliveryCount,
  };
}

function harness(): {
  msg: AckableMessage;
  nak: jest.MockedFunction<AckableMessage['nak']>;
  term: jest.MockedFunction<AckableMessage['term']>;
  logger: DispositionLogger;
} {
  const nak: jest.MockedFunction<AckableMessage['nak']> = jest.fn();
  const term: jest.MockedFunction<AckableMessage['term']> = jest.fn();
  return { msg: { nak, term }, nak, term, logger: { error: jest.fn() } };
}

describe('settleFailedMessage', () => {
  it('NAKs with bounded exponential backoff while attempts remain', async () => {
    const { msg, nak, term, logger } = harness();
    const sink: DeadLetterSink = { record: jest.fn() };

    await expect(
      settleFailedMessage({
        msg,
        error: 'db down',
        envelope: envelope(2),
        maxDeliver: 3,
        sink,
        logger,
      }),
    ).resolves.toBe('retry');
    expect(nak).toHaveBeenCalledWith(4000);
    expect(term).not.toHaveBeenCalled();
    expect(sink.record).not.toHaveBeenCalled();
  });

  it('records before terminating on the final attempt', async () => {
    const trace: string[] = [];
    const { msg, nak, term, logger } = harness();
    term.mockImplementation(() => trace.push('term'));
    const sink: DeadLetterSink = {
      record: jest.fn(async () => {
        trace.push('record');
      }),
    };

    await expect(
      settleFailedMessage({
        msg,
        error: 'db down',
        envelope: envelope(3),
        maxDeliver: 3,
        sink,
        logger,
      }),
    ).resolves.toBe('dead-lettered');
    expect(trace).toEqual(['record', 'term']);
    expect(nak).not.toHaveBeenCalled();
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ error: 'db down' }));
  });

  it('never terminates when the durable write rejects', async () => {
    const { msg, nak, term, logger } = harness();
    const sink: DeadLetterSink = {
      record: jest.fn().mockRejectedValue(new Error('shelf unavailable')),
    };

    await expect(
      settleFailedMessage({
        msg,
        error: 'db down',
        envelope: envelope(3),
        maxDeliver: 3,
        sink,
        logger,
      }),
    ).resolves.toBe('retry-sink-failed');
    expect(term).not.toHaveBeenCalled();
    expect(nak).toHaveBeenCalledWith(8000);
  });

  it('fails closed when no shelf is registered or max-deliver is unknown', async () => {
    const missing = harness();
    await expect(
      settleFailedMessage({
        msg: missing.msg,
        error: 'db down',
        envelope: envelope(3),
        maxDeliver: 3,
        sink: undefined,
        logger: missing.logger,
      }),
    ).resolves.toBe('retry-no-sink');
    expect(missing.term).not.toHaveBeenCalled();

    const unknown = harness();
    await expect(
      settleFailedMessage({
        msg: unknown.msg,
        error: 'db down',
        envelope: envelope(99),
        maxDeliver: undefined,
        sink: { record: jest.fn() },
        logger: unknown.logger,
      }),
    ).resolves.toBe('retry');
    expect(unknown.nak).toHaveBeenCalledWith(30_000);
    expect(unknown.term).not.toHaveBeenCalled();
  });

  it('normalizes invalid counts and caps backoff at 30 seconds', () => {
    expect(redeliveryBackoffMs(-1)).toBe(1000);
    expect(redeliveryBackoffMs(Number.NaN)).toBe(1000);
    expect(redeliveryBackoffMs(50)).toBe(30_000);
  });
});
