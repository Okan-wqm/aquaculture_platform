/**
 * Delivery outcome of one event handler — a VALUE the bus folds, not a side
 * effect it has to infer (PLAT-HIGH-902).
 *
 * # Why
 *
 * `IEventHandler.handle()` used to return `Promise<void>`. The bus could only
 * tell two states apart — threw (nak) or returned (ack) — so every handler
 * that caught its own error "to avoid a poison loop" silently acknowledged a
 * failed delivery, and every handler that returned early on a malformed
 * payload did the same. Twenty-two of forty handlers swallowed; none could
 * say "this message can never succeed, stop redelivering it". JetStream's
 * max_deliver then dropped exhausted messages without a trace.
 *
 * A handler now returns exactly one of three outcomes:
 *
 * - `ack`       — done, or nothing to do for this message (a guard that
 *                 legitimately does not apply).
 * - `retry`     — a transient failure (infrastructure, upstream 5xx/timeout);
 *                 redeliver with backoff, dead-letter when the budget is spent.
 * - `terminate` — this message can never succeed (malformed payload, legacy
 *                 shape, invalid tenancy scope, validation/domain rejection);
 *                 dead-letter it now and stop redelivering.
 *
 * A thrown error is folded as `retry` (the previous behaviour, made explicit).
 * A handler that returns anything else is a contract violation and folds as
 * `terminate` — loudly, so the gap is visible in the dead-letter stream rather
 * than acknowledged away.
 */

import { HttpException } from '@nestjs/common';

export type HandlerOutcome =
  /**
   * `reason` is present when the ack is a DECISION rather than a plain
   * success — a guard that does not apply, or a transient failure on a
   * reproducible signal. It is what keeps such an ack out of the "silently
   * swallowed" class the bus can no longer express (PLAT-HIGH-902): the
   * disposition is still ack, but it says why.
   */
  | { readonly kind: 'ack'; readonly reason?: string }
  | { readonly kind: 'retry'; readonly reason: string; readonly cause?: unknown }
  | { readonly kind: 'terminate'; readonly reason: string; readonly cause?: unknown };

const ACK: HandlerOutcome = Object.freeze({ kind: 'ack' as const });

/** Constructors + guard, merged with the type so `HandlerOutcome.ack()` reads naturally. */
export const HandlerOutcome = {
  ack(reason?: string): HandlerOutcome {
    return reason === undefined ? ACK : { kind: 'ack', reason };
  },
  retry(reason: string, cause?: unknown): HandlerOutcome {
    return cause === undefined ? { kind: 'retry', reason } : { kind: 'retry', reason, cause };
  },
  terminate(reason: string, cause?: unknown): HandlerOutcome {
    return cause === undefined
      ? { kind: 'terminate', reason }
      : { kind: 'terminate', reason, cause };
  },
  is(value: unknown): value is HandlerOutcome {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const kind = (value as { kind?: unknown }).kind;
    if (kind === 'ack') {
      return true;
    }
    return (
      (kind === 'retry' || kind === 'terminate') &&
      typeof (value as { reason?: unknown }).reason === 'string'
    );
  },
} as const;

/** Delivery position of the message being folded (JetStream `msg.info`). */
export interface DeliveryPosition {
  /** 1-based: the first delivery of a message is 1. */
  readonly deliveryCount: number;
  /** Consumer `max_deliver`; `<= 0` means unlimited (never exhausted). */
  readonly maxDeliver: number;
}

/** What the bus does with the JetStream message after folding every handler. */
export type MessageDisposition =
  | { readonly kind: 'ack' }
  | { readonly kind: 'nak'; readonly backoffMs: number; readonly reason: string }
  | {
      readonly kind: 'term';
      readonly reason: string;
      readonly retryExhausted: boolean;
      readonly cause?: unknown;
    };

export const MAX_REDELIVERY_BACKOFF_MS = 30_000;

/** Exponential redelivery backoff: 1s, 2s, 4s … capped at 30s. */
export function redeliveryBackoffMs(deliveryCount: number): number {
  const exponent = Math.max(0, deliveryCount);
  return Math.min(1000 * Math.pow(2, exponent), MAX_REDELIVERY_BACKOFF_MS);
}

/** True when a retry would exceed the consumer's delivery budget. */
export function isRetryExhausted(position: DeliveryPosition): boolean {
  return position.maxDeliver > 0 && position.deliveryCount >= position.maxDeliver;
}

/**
 * Fold the outcomes of every handler of one message into a single disposition.
 *
 * Precedence: retry > terminate > ack. A message some handler still wants
 * redelivered is redelivered (handlers are idempotent by contract; the ones
 * that were done ack again). Only when no handler wants a retry does a
 * terminate win, and only when nobody objects is the message acknowledged.
 *
 * A non-outcome value (a handler that returned `undefined`, a plain object …)
 * is a contract violation and terminates the message with an explicit reason,
 * so the gap shows up in the dead-letter stream instead of being acked away.
 *
 * A retry whose budget is spent (`deliveryCount >= maxDeliver`) becomes a
 * terminate with `retryExhausted: true`: JetStream would otherwise drop the
 * message silently once max_deliver is reached.
 */
export function foldHandlerOutcomes(
  outcomes: ReadonlyArray<unknown>,
  position: DeliveryPosition,
): MessageDisposition {
  let retry: { reason: string; cause?: unknown } | null = null;
  let terminate: { reason: string; cause?: unknown } | null = null;

  for (const outcome of outcomes) {
    if (!HandlerOutcome.is(outcome)) {
      terminate ??= {
        reason: 'handler returned no HandlerOutcome (contract violation)',
        cause: outcome,
      };
      continue;
    }
    if (outcome.kind === 'retry') {
      retry ??= { reason: outcome.reason, cause: outcome.cause };
    } else if (outcome.kind === 'terminate') {
      terminate ??= { reason: outcome.reason, cause: outcome.cause };
    }
  }

  if (retry !== null) {
    if (isRetryExhausted(position)) {
      return {
        kind: 'term',
        reason: `retry budget exhausted after ${position.deliveryCount} deliveries: ${retry.reason}`,
        retryExhausted: true,
        ...(retry.cause === undefined ? {} : { cause: retry.cause }),
      };
    }
    return {
      kind: 'nak',
      backoffMs: redeliveryBackoffMs(position.deliveryCount),
      reason: retry.reason,
    };
  }
  if (terminate !== null) {
    return {
      kind: 'term',
      reason: terminate.reason,
      retryExhausted: false,
      ...(terminate.cause === undefined ? {} : { cause: terminate.cause }),
    };
  }
  return { kind: 'ack' };
}

/**
 * Is a thrown error one that redelivery can never fix?
 *
 * A validation / domain rejection (HTTP 400 / 409 / 422 thrown as a Nest
 * HttpException, or a class-validator `ValidationError`) describes the
 * MESSAGE, not the moment: the same payload fails the same way on every
 * redelivery. Everything else (connection refused, timeout, 5xx, a plain
 * Error from a driver) is assumed transient and retried within the budget.
 * Handlers that catch broadly use this to pick `terminate` vs `retry`
 * instead of swallowing. An error carrying its own `failureClass`
 * ('permanent' | 'transient') is believed as declared.
 */
export function isTerminalHandlerError(error: unknown): boolean {
  // An error that classified itself (EmailDeliveryError, an internal HTTP
  // call result, InvalidEventTenantScopeError) is believed as is.
  const declared = (error as { failureClass?: unknown } | null)?.failureClass;
  if (declared === 'permanent') return true;
  if (declared === 'transient') return false;
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return status === 400 || status === 409 || status === 422;
  }
  return error instanceof Error && error.name === 'ValidationError';
}

/**
 * `terminate` for an error redelivery cannot fix, `retry` otherwise — unless
 * the SIGNAL itself is reproducible.
 *
 * The two questions are independent and both have an owner. Whether an error
 * can ever succeed on redelivery is a property of the ERROR, answered here by
 * `isTerminalHandlerError`. Whether a lost delivery loses the FACT is a
 * property of the EVENT, answered by the event contract's delivery semantics
 * (`requiresDurableDelivery`) — a `one_shot` signal is raised once at write
 * time and nothing re-derives it, while a `reproducible` one is re-emitted by
 * the sweep that computes it.
 *
 * Retrying a reproducible signal buys nothing and costs a redelivery storm on
 * the platform's highest-volume subjects, so its transient failures are
 * acknowledged — but as an explicit `ack` carrying the reason, never as a
 * silent `return` (PLAT-HIGH-902). A terminal error is dead-lettered either
 * way: a payload the handler can never accept has to be visible.
 */
export function outcomeForError(
  context: string,
  error: unknown,
  options: { readonly reproducible?: boolean } = {},
): HandlerOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (isTerminalHandlerError(error)) {
    return HandlerOutcome.terminate(`${context}: ${message}`, error);
  }
  if (options.reproducible === true) {
    return HandlerOutcome.ack(
      `${context}: ${message} — acknowledged, the signal is reproducible and its next ` +
        'emission re-raises it; retrying would only storm the subject',
    );
  }
  return HandlerOutcome.retry(`${context}: ${message}`, error);
}
