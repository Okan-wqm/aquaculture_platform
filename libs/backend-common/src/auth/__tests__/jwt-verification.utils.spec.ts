/**
 * Unit tests for getJwtVerifyOptions memoization (PERF-MEDIUM-001).
 *
 * Locks the hot-path invariant: the RSA public key file is read ONCE across many
 * verifies (was a per-request readFileSync on ~12 callsites), the cache is keyed
 * by the CONFIG VALUE so a rotation re-reads, inline-PEM mode never touches the
 * filesystem, and the returned options object is frozen + RS256-only.
 */
import { readFileSync } from 'fs';

import { Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  enforceTokenNotRevoked,
  getJwtVerifyOptions,
  __resetJwtVerifyOptionsCache,
} from '../jwt-verification.utils';

jest.mock('fs', () => ({
  readFileSync: jest.fn(() => '-----BEGIN PUBLIC KEY-----\nMOCKPEM\n-----END PUBLIC KEY-----'),
}));

const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;

describe('getJwtVerifyOptions memoization (PERF-MEDIUM-001)', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.JWT_PUBLIC_KEY;
    delete process.env.JWT_PUBLIC_KEY_PATH;
    __resetJwtVerifyOptionsCache();
    mockReadFileSync.mockClear();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    __resetJwtVerifyOptionsCache();
  });

  it('reads the key file exactly ONCE across many verifies in PATH mode', () => {
    process.env.JWT_PUBLIC_KEY_PATH = '/etc/ssl/jwt/public.pem';
    const config = new ConfigService();

    for (let i = 0; i < 50; i++) {
      getJwtVerifyOptions(config);
    }

    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it('enforces RS256 + the configured issuer/audience', () => {
    process.env.JWT_PUBLIC_KEY_PATH = '/etc/ssl/jwt/public.pem';
    process.env.JWT_ISSUER = 'issuer-x';
    process.env.JWT_AUDIENCE = 'audience-x';
    const options = getJwtVerifyOptions(new ConfigService());

    expect(options.algorithms).toEqual(['RS256']);
    expect(options.issuer).toBe('issuer-x');
    expect(options.audience).toBe('audience-x');
  });

  it('re-reads when the configured key PATH changes (rotation invalidates the cache)', () => {
    process.env.JWT_PUBLIC_KEY_PATH = '/etc/ssl/jwt/old.pem';
    getJwtVerifyOptions(new ConfigService());

    process.env.JWT_PUBLIC_KEY_PATH = '/etc/ssl/jwt/new.pem';
    getJwtVerifyOptions(new ConfigService());

    expect(mockReadFileSync).toHaveBeenCalledTimes(2);
  });

  it('never touches the filesystem in inline-PEM mode', () => {
    process.env.JWT_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nINLINE\n-----END PUBLIC KEY-----';
    getJwtVerifyOptions(new ConfigService());

    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('returns a frozen options object (cached callers cannot mutate shared state)', () => {
    process.env.JWT_PUBLIC_KEY_PATH = '/etc/ssl/jwt/public.pem';
    const options = getJwtVerifyOptions(new ConfigService());

    expect(Object.isFrozen(options)).toBe(true);
  });
});

describe('enforceTokenNotRevoked', () => {
  const logger = new Logger('revocation-test');
  let getStatus: jest.Mock;

  beforeEach(() => {
    getStatus = jest.fn().mockResolvedValue({
      jtiRevoked: false,
      userEpochRevoked: false,
    });
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('consults the JTI and user-epoch authorities before admitting a token', async () => {
    await expect(
      enforceTokenNotRevoked(
        { sub: 'admin-1', jti: 'jti-1', iat: 2_000_000_000 },
        { getStatus },
        logger,
      ),
    ).resolves.toEqual({ jti: 'jti-1', issuedAtSeconds: 2_000_000_000 });
    expect(getStatus).toHaveBeenCalledWith('jti-1', 'admin-1', 2_000_000_000);
  });

  it.each([
    ['JTI marker', true, false],
    ['user epoch', false, true],
  ])('rejects a token revoked by the %s', async (_label, jtiRevoked, userEpochRevoked) => {
    getStatus.mockResolvedValue({ jtiRevoked, userEpochRevoked });

    await expect(
      enforceTokenNotRevoked(
        { sub: 'admin-1', jti: 'jti-1', iat: 2_000_000_000 },
        { getStatus },
        logger,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token whose revocation coordinates cannot be proven', async () => {
    await expect(
      enforceTokenNotRevoked({ sub: 'admin-1' }, { getStatus }, logger),
    ).rejects.toMatchObject({ response: { code: 'MISSING_REVOCATION_CLAIMS' } });
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('propagates authority outages instead of treating them as not revoked', async () => {
    getStatus.mockRejectedValue(new Error('redis unavailable'));

    await expect(
      enforceTokenNotRevoked(
        { sub: 'admin-1', jti: 'jti-1', iat: 2_000_000_000 },
        { getStatus },
        logger,
      ),
    ).rejects.toThrow('redis unavailable');
  });
});
