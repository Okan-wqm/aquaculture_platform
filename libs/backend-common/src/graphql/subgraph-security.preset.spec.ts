import type { GraphQLFormattedError } from 'graphql';

import { subgraphFormatError } from './subgraph-security.preset';

/**
 * The production mask hides driver/DB text but must keep the message of codes
 * the client can act on: a masked 429 reached users as a meaningless
 * "An error occurred..." instead of "Retry after Xs" (#1670, 2026-09-21).
 */
describe('subgraphFormatError', () => {
  const formatter = subgraphFormatError(true);

  function format(error: GraphQLFormattedError): GraphQLFormattedError {
    if (!formatter) throw new Error('production formatter missing');
    return formatter(error, undefined);
  }

  it('returns no formatter outside production (messages stay verbatim)', () => {
    expect(subgraphFormatError(false)).toBeUndefined();
  });

  it.each([
    'BAD_USER_INPUT',
    'GRAPHQL_VALIDATION_FAILED',
    'TOO_MANY_REQUESTS',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
  ])('keeps the actionable message of %s', (code) => {
    const error: GraphQLFormattedError = {
      message: `${code}: Retry after 30s`,
      extensions: { code },
    };
    expect(format(error)).toBe(error);
  });

  it('masks every other code and never leaks the original text', () => {
    expect(
      format({
        message: 'duplicate key value violates unique constraint "farm_workers_email"',
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
      }),
    ).toEqual({
      message: 'An error occurred while processing your request',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });

  it('labels a code-less error INTERNAL_SERVER_ERROR', () => {
    expect(format({ message: 'relation "x" does not exist' })).toEqual({
      message: 'An error occurred while processing your request',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });
});
