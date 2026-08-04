import { ConfigService } from '@nestjs/config';

import { parseHashRefreshTokens } from './hash-refresh-tokens';

function config(values: Record<string, unknown>): ConfigService {
  return new ConfigService(values);
}

describe('parseHashRefreshTokens', () => {
  it.each([
    [undefined, true],
    [true, true],
    [false, false],
    ['true', true],
    ['false', false],
  ])('parses %p without JavaScript truthiness drift', (raw, expected) => {
    expect(parseHashRefreshTokens(config({ HASH_REFRESH_TOKENS: raw }))).toBe(expected);
  });

  it.each(['TRUE', '0', 0, 1, null, ''])('rejects invalid value %p', (raw) => {
    expect(() => parseHashRefreshTokens(config({ HASH_REFRESH_TOKENS: raw }))).toThrow(
      'HASH_REFRESH_TOKENS must be true or false',
    );
  });

  it.each(['production', 'staging'])('rejects disabled hashing in %s', (environment) => {
    expect(() =>
      parseHashRefreshTokens(config({ HASH_REFRESH_TOKENS: 'false', NODE_ENV: environment })),
    ).toThrow('must be enabled');
  });
});
