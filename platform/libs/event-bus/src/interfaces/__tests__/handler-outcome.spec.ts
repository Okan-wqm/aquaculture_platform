import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';

import {
  HandlerOutcome,
  foldHandlerOutcomes,
  isRetryExhausted,
  isTerminalHandlerError,
  outcomeForError,
  redeliveryBackoffMs,
} from '../handler-outcome';

/**
 * PLAT-HIGH-902 — the fold is the bus's only decision about a JetStream
 * message; these cases pin its precedence, its budget boundary and its
 * loud handling of a handler that returns no outcome.
 */
describe('foldHandlerOutcomes (PLAT-HIGH-902)', () => {
  const first = { deliveryCount: 1, maxDeliver: 3 };

  it('acks when every handler acks — and when there is no handler at all', () => {
    expect(foldHandlerOutcomes([HandlerOutcome.ack(), HandlerOutcome.ack()], first)).toEqual({
      kind: 'ack',
    });
    expect(foldHandlerOutcomes([], first)).toEqual({ kind: 'ack' });
  });

  it('naks with exponential backoff when a handler asks for a retry', () => {
    expect(
      foldHandlerOutcomes([HandlerOutcome.ack(), HandlerOutcome.retry('smtp 503')], first),
    ).toEqual({ kind: 'nak', backoffMs: 2000, reason: 'smtp 503' });
    expect(
      foldHandlerOutcomes([HandlerOutcome.retry('x')], { deliveryCount: 2, maxDeliver: 3 }),
    ).toEqual({ kind: 'nak', backoffMs: 4000, reason: 'x' });
  });

  it('retry outranks terminate: a message some handler still wants is redelivered', () => {
    expect(
      foldHandlerOutcomes(
        [HandlerOutcome.terminate('legacy shape'), HandlerOutcome.retry('db down')],
        first,
      ),
    ).toEqual({ kind: 'nak', backoffMs: 2000, reason: 'db down' });
  });

  it('terminates when a handler terminates and nobody asks for a retry', () => {
    const cause = new Error('boom');
    expect(
      foldHandlerOutcomes(
        [HandlerOutcome.ack(), HandlerOutcome.terminate('invalid scope', cause)],
        first,
      ),
    ).toEqual({ kind: 'term', reason: 'invalid scope', retryExhausted: false, cause });
  });

  it('turns a retry into a retry-exhausted terminate at the delivery budget boundary', () => {
    const atBudget = { deliveryCount: 3, maxDeliver: 3 };
    const disposition = foldHandlerOutcomes([HandlerOutcome.retry('still down')], atBudget);
    expect(disposition.kind).toBe('term');
    expect(disposition).toEqual(
      expect.objectContaining({
        retryExhausted: true,
        reason: expect.stringContaining('exhausted after 3 deliveries: still down'),
      }),
    );
    expect(isRetryExhausted({ deliveryCount: 2, maxDeliver: 3 })).toBe(false);
    expect(isRetryExhausted({ deliveryCount: 3, maxDeliver: 3 })).toBe(true);
  });

  it('never exhausts an unlimited (maxDeliver <= 0) consumer', () => {
    expect(
      foldHandlerOutcomes([HandlerOutcome.retry('x')], { deliveryCount: 500, maxDeliver: -1 }),
    ).toEqual({ kind: 'nak', backoffMs: 30_000, reason: 'x' });
    expect(isRetryExhausted({ deliveryCount: 500, maxDeliver: 0 })).toBe(false);
  });

  it('terminates loudly when a handler returns no outcome (contract violation)', () => {
    const disposition = foldHandlerOutcomes([undefined, HandlerOutcome.ack()], first);
    expect(disposition).toEqual({
      kind: 'term',
      reason: 'handler returned no HandlerOutcome (contract violation)',
      retryExhausted: false,
    });
    expect(HandlerOutcome.is({ kind: 'retry' })).toBe(false);
    expect(HandlerOutcome.is({ kind: 'ack' })).toBe(true);
  });

  it('caps the backoff at 30 seconds', () => {
    expect(redeliveryBackoffMs(0)).toBe(1000);
    expect(redeliveryBackoffMs(4)).toBe(16_000);
    expect(redeliveryBackoffMs(10)).toBe(30_000);
  });

  it('classifies a validation/domain rejection as terminal and everything else as transient', () => {
    expect(isTerminalHandlerError(new BadRequestException('bad payload'))).toBe(true);
    expect(isTerminalHandlerError(new ServiceUnavailableException('down'))).toBe(false);
    expect(isTerminalHandlerError(new Error('ECONNREFUSED'))).toBe(false);
    const validation = new Error('x');
    validation.name = 'ValidationError';
    expect(isTerminalHandlerError(validation)).toBe(true);

    expect(outcomeForError('incident', new BadRequestException('bad')).kind).toBe('terminate');
    expect(outcomeForError('incident', new Error('db down'))).toEqual(
      expect.objectContaining({ kind: 'retry', reason: 'incident: db down' }),
    );
  });
});
