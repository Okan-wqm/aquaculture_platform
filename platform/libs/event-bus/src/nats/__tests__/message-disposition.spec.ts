/**
 * Failed-message disposition (W7 — FARM-MEDIUM-260).
 *
 * The contract pinned here, in order of how badly getting it wrong hurts:
 *
 *   1. Retries left  → NAK with exponential backoff (unchanged pre-W7).
 *   2. Retries gone  → the shelf write happens FIRST, and only a SUCCESSFUL
 *      write earns `term()`.
 *   3. Shelf write failed, or no shelf registered → NAK, never `term()`. Not
 *      because the NAK saves it (past `max_deliver` JetStream drops it either
 *      way) but because `term()` is irreversible and must not be taken on the
 *      strength of a write nobody confirmed.
 *   4. Unknown `max_deliver` → treat as "retries remain". Guessing that this
 *      was the last attempt could terminate a message JetStream would have
 *      redelivered.
 */
import type { DeadLetterEnvelope, DeadLetterSink } from '@aquaculture/backend-common/events';

import {
  redeliveryBackoffMs,
  settleFailedMessage,
  type AckableMessage,
  type DispositionLogger,
} from '../message-disposition';

const SUBJECT = 'events.*.MealMissed';

function envelope(deliveryCount: number): DeadLetterEnvelope {
  return {
    subject: SUBJECT,
    eventType: 'MealMissed',
    eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    payload: { eventType: 'MealMissed', mealId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
    error: '',
    deliveryCount,
  };
}

interface Harness {
  msg: AckableMessage;
  nak: jest.MockedFunction<AckableMessage['nak']>;
  term: jest.MockedFunction<AckableMessage['term']>;
  logger: DispositionLogger;
  errors: string[];
}

function harness(): Harness {
  const nak: jest.MockedFunction<AckableMessage['nak']> = jest.fn();
  const term: jest.MockedFunction<AckableMessage['term']> = jest.fn();
  const errors: string[] = [];
  return {
    msg: { nak, term },
    nak,
    term,
    logger: {
      error: (message: string): void => {
        errors.push(message);
      },
    },
    errors,
  };
}

function sinkThat(
  behaviour: 'resolves' | 'rejects',
  trace?: string[],
): { sink: DeadLetterSink; record: jest.MockedFunction<DeadLetterSink['record']> } {
  const record: jest.MockedFunction<DeadLetterSink['record']> = jest.fn(
    (_entry: DeadLetterEnvelope): Promise<void> => {
      trace?.push('record');
      return behaviour === 'resolves'
        ? Promise.resolve()
        : Promise.reject(new Error('dlq table missing'));
    },
  );
  return { sink: { record }, record };
}

describe('settleFailedMessage', () => {
  it('NAKs with exponential backoff while retries remain, without touching the shelf', async () => {
    const { msg, nak, term, logger } = harness();
    const { sink, record } = sinkThat('resolves');

    const outcome = await settleFailedMessage({
      msg,
      error: 'db down',
      envelope: envelope(2),
      maxDeliver: 3,
      sink,
      logger,
    });

    expect(outcome).toBe('retry');
    expect(nak).toHaveBeenCalledWith(4000); // min(1000 * 2^2, 30000)
    expect(term).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('writes the shelf THEN terminates once max_deliver is exhausted', async () => {
    const trace: string[] = [];
    const { msg, nak, term, logger } = harness();
    term.mockImplementation(() => {
      trace.push('term');
    });
    const { sink, record } = sinkThat('resolves', trace);

    const outcome = await settleFailedMessage({
      msg,
      error: 'db down',
      envelope: envelope(3),
      maxDeliver: 3,
      sink,
      logger,
    });

    expect(outcome).toBe('dead-lettered');
    expect(trace).toEqual(['record', 'term']);
    expect(nak).not.toHaveBeenCalled();

    const recorded = record.mock.calls[0]?.[0];
    expect(recorded?.subject).toBe(SUBJECT);
    expect(recorded?.eventType).toBe('MealMissed');
    expect(recorded?.tenantId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(recorded?.eventId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(recorded?.deliveryCount).toBe(3);
    // The terminal error is stamped onto the envelope by the settler, so the
    // caller cannot forget to attach it.
    expect(recorded?.error).toBe('db down');
  });

  it('NAKs instead of terminating when the shelf write fails', async () => {
    const { msg, nak, term, logger, errors } = harness();
    const { sink } = sinkThat('rejects');

    const outcome = await settleFailedMessage({
      msg,
      error: 'db down',
      envelope: envelope(3),
      maxDeliver: 3,
      sink,
      logger,
    });

    // `term()` is the irreversible action and is never taken on the strength
    // of a write nobody confirmed — the NAK is not a save (past max_deliver
    // JetStream drops it either way), it preserves the consumer-level evidence.
    expect(outcome).toBe('retry-sink-failed');
    expect(term).not.toHaveBeenCalled();
    expect(nak).toHaveBeenCalledWith(8000);
    expect(errors.join(' ')).toContain('Dead-letter write FAILED');
  });

  it('NAKs and names the missing module rather than silently dropping', async () => {
    const { msg, nak, term, logger, errors } = harness();

    const outcome = await settleFailedMessage({
      msg,
      error: 'db down',
      envelope: envelope(3),
      maxDeliver: 3,
      sink: undefined,
      logger,
    });

    expect(outcome).toBe('retry-no-sink');
    expect(term).not.toHaveBeenCalled();
    expect(nak).toHaveBeenCalledWith(8000);
    // The log must say the message is GONE, not imply a retry will save it.
    expect(errors.join(' ')).toContain('Register DeadLetterModule');
    expect(errors.join(' ')).toContain('not recoverable');
  });

  it('treats an unknown max_deliver as "retries remain"', async () => {
    const { msg, nak, term, logger } = harness();
    const { sink, record } = sinkThat('resolves');

    const outcome = await settleFailedMessage({
      msg,
      error: 'db down',
      envelope: envelope(99),
      maxDeliver: undefined,
      sink,
      logger,
    });

    expect(outcome).toBe('retry');
    expect(term).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(nak).toHaveBeenCalledWith(30000); // capped
  });

  it('caps the backoff at 30s', () => {
    expect(redeliveryBackoffMs(0)).toBe(1000);
    expect(redeliveryBackoffMs(1)).toBe(2000);
    expect(redeliveryBackoffMs(5)).toBe(30000);
    expect(redeliveryBackoffMs(50)).toBe(30000);
  });
});
