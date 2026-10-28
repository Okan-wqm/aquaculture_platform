/**
 * What a gateway client may learn from a failing operation in production: the
 * message the subgraph already chose, the code, and — for a rate limit only —
 * how long to wait. Nothing else rides along.
 */
import { formatGatewayError } from './gateway-format-error';

describe('formatGatewayError', () => {
  it('keeps the message and the code, drops every other extension', () => {
    expect(
      formatGatewayError({
        message: 'Not allowed',
        extensions: { code: 'FORBIDDEN', stacktrace: ['at secret'], serviceName: 'billing' },
      }),
    ).toEqual({ message: 'Not allowed', extensions: { code: 'FORBIDDEN' } });
  });

  it('falls back to INTERNAL_SERVER_ERROR when the error carries no code', () => {
    expect(formatGatewayError({ message: 'boom' })).toEqual({
      message: 'boom',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });

  it('keeps the wait of a rate limit so the client can back off instead of giving up', () => {
    expect(
      formatGatewayError({
        message: 'Rate limit exceeded. Maximum 10 per 300s. Retry after 40 seconds.',
        extensions: { code: 'TOO_MANY_REQUESTS', retryAfter: 40 },
      }),
    ).toEqual({
      message: 'Rate limit exceeded. Maximum 10 per 300s. Retry after 40 seconds.',
      extensions: { code: 'TOO_MANY_REQUESTS', retryAfter: 40 },
    });
  });

  it('lets retryAfter through for a rate limit ONLY, and only as a number', () => {
    expect(
      formatGatewayError({ message: 'x', extensions: { code: 'UNAUTHENTICATED', retryAfter: 40 } }),
    ).toEqual({ message: 'x', extensions: { code: 'UNAUTHENTICATED' } });
    expect(
      formatGatewayError({
        message: 'x',
        extensions: { code: 'TOO_MANY_REQUESTS', retryAfter: '40; drop table' },
      }),
    ).toEqual({ message: 'x', extensions: { code: 'TOO_MANY_REQUESTS' } });
  });
});
