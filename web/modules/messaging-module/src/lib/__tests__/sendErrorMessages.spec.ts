import { describe, expect, it } from 'vitest';

import { sendErrorBannerKey } from '../sendErrorMessages';

/** graphql-request ClientError shape — what a failed request rejects with. */
function clientError(code: string): unknown {
  return {
    name: 'ClientError',
    message: 'GraphQL Error',
    response: { errors: [{ message: 'refused', extensions: { code } }] },
  };
}

describe('sendErrorBannerKey', () => {
  it('maps each contractual code to its specific banner copy key', () => {
    expect(sendErrorBannerKey(clientError('TOO_MANY_REQUESTS'))).toBe('messaging.error.rateLimited');
    expect(sendErrorBannerKey(clientError('RATE_LIMITED'))).toBe('messaging.error.rateLimited');
    expect(sendErrorBannerKey(clientError('FORBIDDEN'))).toBe('messaging.error.forbidden');
    expect(sendErrorBannerKey(clientError('NOT_FOUND'))).toBe('messaging.error.notFound');
    expect(sendErrorBannerKey(clientError('UNAUTHENTICATED'))).toBe('messaging.error.unauthenticated');
  });

  it('falls back to the generic send-failed banner for unknown codes', () => {
    expect(sendErrorBannerKey(clientError('INTERNAL_SERVER_ERROR'))).toBe('messaging.error.sendFailed');
    expect(sendErrorBannerKey(clientError('SOMETHING_ELSE'))).toBe('messaging.error.sendFailed');
  });

  it('falls back to the generic banner for transport failures without a GraphQL error', () => {
    expect(sendErrorBannerKey(new TypeError('fetch failed'))).toBe('messaging.error.sendFailed');
    expect(sendErrorBannerKey(undefined)).toBe('messaging.error.sendFailed');
  });
});
