import {
  NATS_MAX_REQUEST_TIMEOUT_MS,
  parseNatsRequestTimeout,
} from '../nats-response-policy';
import responsePolicy from '../nats-response-policy.json';

describe('NATS request timeout stays within delivered-reply authorization', () => {
  it.each([undefined, ''])('preserves the configured service default when unset (%s)', (value) => {
    expect(parseNatsRequestTimeout(value, 15_000, 'AUTH_NATS_TIMEOUT_MS')).toBe(15_000);
  });

  it.each([1, 5_000, 15_000, 60_000, NATS_MAX_REQUEST_TIMEOUT_MS])(
    'accepts the finite integer timeout %s as a number or environment string',
    (value) => {
      expect(parseNatsRequestTimeout(value, 5_000, 'NATS_TIMEOUT_MS')).toBe(value);
      expect(parseNatsRequestTimeout(String(value), 5_000, 'NATS_TIMEOUT_MS')).toBe(value);
    },
  );

  it('keeps the maximum allowed request strictly inside the broker reply lifetime', () => {
    expect(NATS_MAX_REQUEST_TIMEOUT_MS).toBe(responsePolicy.expirySeconds * 1000 - 1);
  });

  it.each([
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    '0',
    '-1',
    '1.5',
    '15000ms',
    'not-a-number',
    'Infinity',
    ' ',
    null,
    true,
    {},
    responsePolicy.expirySeconds * 1000,
    String(responsePolicy.expirySeconds * 1000),
    responsePolicy.expirySeconds * 1000 + 1,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid or expired reply budgets (%s) without falling back or clamping', (value) => {
    expect(() => parseNatsRequestTimeout(value, 5_000, 'AUTH_NATS_TIMEOUT_MS')).toThrow(
      'AUTH_NATS_TIMEOUT_MS must be an integer from 1 to',
    );
  });

  it('validates the default against the same policy', () => {
    expect(() =>
      parseNatsRequestTimeout(undefined, responsePolicy.expirySeconds * 1000, 'NATS_TIMEOUT_MS'),
    ).toThrow('NATS_TIMEOUT_MS must be an integer from 1 to');
  });
});
