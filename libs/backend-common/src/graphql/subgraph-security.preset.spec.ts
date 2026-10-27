/**
 * subgraphFormatError — what a client may learn from a failing operation in
 * production. Internal text never leaves (a raw driver message can carry row
 * values); operational answers the client must act on do.
 */
import type { GraphQLFormattedError } from 'graphql';

import { subgraphFormatError } from './subgraph-security.preset';

const formatted = (
  message: string,
  extensions: Record<string, unknown>,
): GraphQLFormattedError => ({ message, extensions });

describe('subgraphFormatError', () => {
  const format = subgraphFormatError(true);

  it('does nothing outside production (messages stay verbatim for developers)', () => {
    expect(subgraphFormatError(false)).toBeUndefined();
  });

  it('masks an internal error: generic message, only the code survives', () => {
    expect(
      format?.(
        formatted('duplicate key value violates unique constraint "x"', {
          code: 'INTERNAL_SERVER_ERROR',
          detail: 'Key (a)=(1)',
        }),
        null,
      ),
    ).toEqual({
      message: 'An error occurred while processing your request',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });

  it('keeps validation answers verbatim (safe, and the caller must act on them)', () => {
    const error = formatted('Variable "$id" got invalid value', { code: 'BAD_USER_INPUT' });

    expect(format?.(error, null)).toEqual(error);
  });

  it('keeps a rate-limit answer verbatim INCLUDING the wait: the client backs off, it does not give up', () => {
    // Collapsed to a generic message with only the code, a client could not tell
    // "wait 40 s" from "something broke" and a refresh that was merely throttled
    // read as a dead session.
    const error = formatted('Rate limit exceeded. Maximum 10 per 300s. Retry after 40 seconds.', {
      code: 'TOO_MANY_REQUESTS',
      retryAfter: 40,
    });

    expect(format?.(error, null)).toEqual(error);
  });

  it('drops every other extension of an unlisted code (nothing rides along by accident)', () => {
    expect(
      format?.(
        formatted('boom', { code: 'UNAUTHENTICATED', stacktrace: ['at x'], retryAfter: 5 }),
        null,
      ),
    ).toEqual({
      message: 'An error occurred while processing your request',
      extensions: { code: 'UNAUTHENTICATED' },
    });
  });
});
