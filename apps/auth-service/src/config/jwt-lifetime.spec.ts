import { MAX_USER_TOKEN_LIFETIME_SECONDS } from '@aquaculture/backend-common/security';

import { parseAccessTokenLifetimeSeconds } from './jwt-lifetime';

describe('parseAccessTokenLifetimeSeconds', () => {
  it.each([
    ['15m', 900],
    ['1h', 3_600],
    ['1d', MAX_USER_TOKEN_LIFETIME_SECONDS],
  ])('parses %s within the revocation-marker lifetime', (input, expected) => {
    expect(parseAccessTokenLifetimeSeconds(input)).toBe(expected);
  });

  it.each(['', '15', '0s', '-1h', '1.5h', '2d', '1w', '999999999999999999999s'])(
    'fails closed for invalid or overlong lifetime %p',
    (input) => {
      expect(() => parseAccessTokenLifetimeSeconds(input)).toThrow();
    },
  );
});
