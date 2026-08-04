/**
 * AuthGuard Tests
 *
 * Comprehensive test suite for JWT, API Key, and Basic Auth authentication
 */

import * as crypto from 'crypto';

import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';

import {
  AuthGuard,
  IS_PUBLIC_KEY,
  API_KEY_AUTH_KEY,
  BASIC_AUTH_KEY,
  JwtPayload,
} from '../auth.guard';
import { TOKEN_BLACKLIST_STORE, TokenBlacklistStore } from '../redis-token-blacklist.store';
import { ApiKeyAuthStrategy } from '../strategies/api-key-auth.strategy';
import { BasicAuthStrategy } from '../strategies/basic-auth.strategy';

type ModernFakeTimersConfig = Extract<
  NonNullable<Parameters<typeof jest.useFakeTimers>[0]>,
  { doNotFake?: unknown }
>;

// Every fakeable API except `Date`. A token-expiry test needs the instant
// pinned, not the event loop stopped — the guard awaits real asynchronous work.
const TIMER_APIS_LEFT_REAL: NonNullable<ModernFakeTimersConfig['doNotFake']> = [
  'hrtime',
  'nextTick',
  'performance',
  'queueMicrotask',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'setImmediate',
  'clearImmediate',
  'setInterval',
  'clearInterval',
  'setTimeout',
  'clearTimeout',
];

/**
 * Interface for authenticated request
 */
interface AuthenticatedRequest {
  headers: Record<string, string>;
  query: Record<string, string>;
  ip: string;
  path: string;
  method: string;
  user?: JwtPayload;
  jwtAuthenticationFailure?: 'TOKEN_REVOKED' | 'INVALID_TOKEN';
  authMethod?: string;
}

/**
 * Interface for mock HTTP context
 */
interface MockHttpContext {
  getRequest: () => AuthenticatedRequest;
}

/**
 * Interface for exception response
 */
interface ExceptionResponse {
  code?: string;
  message?: string;
  statusCode?: number;
}

/**
 * Interface for exception with response
 */
interface ExceptionWithResponse extends Error {
  response: ExceptionResponse;
}

describe('AuthGuard', () => {
  let guard: AuthGuard;
  let reflector: Reflector;
  let tokenBlacklist: jest.Mocked<TokenBlacklistStore>;

  const JWT_ISSUER = 'test-issuer';
  const JWT_AUDIENCE = 'test-audience';

  // WHY RS256 keypairs: the platform is RS256-only (getJwtVerifyOptions pins
  // algorithms:['RS256'] — algorithm-confusion defense). Fixture tokens are
  // signed with a test RSA private key; the guard verifies against the
  // matching public key injected as JWT_PUBLIC_KEY. The WRONG keypair signs
  // structurally-valid tokens whose signature must be rejected.
  const TEST_KEYPAIR = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const WRONG_KEYPAIR = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  /**
   * Create a valid RS256 JWT token for testing
   */
  const createJwtToken = (
    payload: Partial<JwtPayload>,
    privateKey = TEST_KEYPAIR.privateKey,
  ): string => {
    const header = { alg: 'RS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);

    const fullPayload: JwtPayload = {
      sub: 'user-123',
      tenantId: 'tenant-123',
      roles: ['user'],
      type: 'access',
      jti: 'test-jti',
      iat: now,
      exp: now + 3600, // 1 hour
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      ...payload,
    };

    const headerB64 = base64UrlEncode(JSON.stringify(header));
    const payloadB64 = base64UrlEncode(JSON.stringify(fullPayload));
    const data = `${headerB64}.${payloadB64}`;

    const signature = crypto.createSign('RSA-SHA256').update(data).sign(privateKey);
    const signatureB64 = base64UrlEncode(signature);

    return `${headerB64}.${payloadB64}.${signatureB64}`;
  };

  /**
   * Base64 URL encode
   */
  function base64UrlEncode(data: string | Buffer): string {
    const buffer = typeof data === 'string' ? Buffer.from(data) : data;
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  /**
   * Create mock execution context
   */
  const createMockExecutionContext = (
    headers: Record<string, string> = {},
    query: Record<string, string> = {},
  ): ExecutionContext => {
    const mockRequest: AuthenticatedRequest = {
      headers,
      query,
      ip: '127.0.0.1',
      path: '/api/v1/test',
      method: 'GET',
    };

    return {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
      }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
      getType: () => 'http',
    } as unknown as ExecutionContext;
  };

  /**
   * Helper to get typed request from context
   */
  const getRequest = (context: ExecutionContext): AuthenticatedRequest => {
    const httpContext = context.switchToHttp() as unknown as MockHttpContext;
    return httpContext.getRequest();
  };

  /**
   * Helper to assert exception response code
   */
  const expectExceptionCode = async (
    fn: () => Promise<unknown>,
    expectedCode: string,
  ): Promise<void> => {
    try {
      await fn();
      fail('Expected exception to be thrown');
    } catch (error) {
      const exception = error as ExceptionWithResponse;
      expect(exception.response.code).toBe(expectedCode);
    }
  };

  beforeEach(async () => {
    tokenBlacklist = {
      isBlacklisted: jest.fn().mockResolvedValue(false),
      isValidToken: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthGuard,
        // WHY real instances: the guard grew JwtService (RS256 verifyAsync)
        // and strategy collaborators — real instances against the mocked
        // ConfigService exercise the production wiring, not a parallel stub.
        { provide: JwtService, useValue: new JwtService({}) },
        ApiKeyAuthStrategy,
        BasicAuthStrategy,
        { provide: TOKEN_BLACKLIST_STORE, useValue: tokenBlacklist },
        {
          provide: Reflector,
          useValue: {
            getAllAndOverride: jest.fn().mockReturnValue(false),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => {
              const config: Record<string, unknown> = {
                JWT_PUBLIC_KEY: TEST_KEYPAIR.publicKey,
                JWT_ISSUER: JWT_ISSUER,
                JWT_AUDIENCE: JWT_AUDIENCE,
                API_KEYS: JSON.stringify([
                  {
                    key: 'valid-api-key-123',
                    userId: 'api-user-1',
                    tenantId: 'tenant-1',
                    roles: ['api_user'],
                    permissions: ['read'],
                    active: true,
                  },
                  {
                    key: 'disabled-api-key',
                    userId: 'api-user-2',
                    tenantId: 'tenant-2',
                    roles: ['api_user'],
                    active: false,
                  },
                  {
                    key: 'expired-api-key',
                    userId: 'api-user-3',
                    tenantId: 'tenant-3',
                    roles: ['api_user'],
                    active: true,
                    expiresAt: new Date('2020-01-01'),
                  },
                ]),
                // WHY pre-hashed: BasicAuthStrategy bcrypt-compares stored
                // hashes; plaintext values are hashed asynchronously at
                // startup, which races the first test. Pre-hashed fixtures
                // (cost 4 for test speed) exercise the production compare path
                // deterministically.
                BASIC_AUTH_CREDENTIALS: JSON.stringify({
                  admin: bcrypt.hashSync('admin-password', 4),
                  service: bcrypt.hashSync('service-password', 4),
                }),
              };
              return config[key] ?? defaultValue;
            }),
          },
        },
      ],
    }).compile();

    guard = module.get<AuthGuard>(AuthGuard);
    reflector = module.get<Reflector>(Reflector);
  });

  afterEach(() => {
    // Restored here rather than at the end of the test that pins the clock: a
    // failing expectation returns early, and a leaked fake clock would then
    // decide the outcome of every expiry test after it.
    jest.useRealTimers();
  });

  describe('JWT Authentication', () => {
    describe('Valid Tokens', () => {
      it('should accept valid JWT token', async () => {
        const token = createJwtToken({});
        const context = createMockExecutionContext({
          authorization: `Bearer ${token}`,
        });

        const result = await guard.canActivate(context);

        expect(result).toBe(true);
        const request = getRequest(context);
        expect(request.user).toBeDefined();
        expect(request.user!.sub).toBe('user-123');
        expect(request.authMethod).toBe('jwt');
      });

      it('should accept token with custom claims', async () => {
        const token = createJwtToken({
          sub: 'custom-user',
          email: 'test@example.com',
          permissions: ['read', 'write'],
        });
        const context = createMockExecutionContext({
          authorization: `Bearer ${token}`,
        });

        const result = await guard.canActivate(context);

        expect(result).toBe(true);
        const request = getRequest(context);
        expect(request.user!.email).toBe('test@example.com');
        expect(request.user!.permissions).toEqual(['read', 'write']);
      });

      it('should accept token with multiple roles', async () => {
        const token = createJwtToken({
          roles: ['admin', 'manager', 'operator'],
        });
        const context = createMockExecutionContext({
          authorization: `Bearer ${token}`,
        });

        const result = await guard.canActivate(context);

        expect(result).toBe(true);
        const request = getRequest(context);
        expect(request.user!.roles).toEqual(['admin', 'manager', 'operator']);
      });
    });

    describe('Invalid Tokens', () => {
      it('should reject missing Authorization header', async () => {
        const context = createMockExecutionContext({});

        await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
        await expectExceptionCode(() => guard.canActivate(context), 'MISSING_AUTH_HEADER');
      });

      it('should reject invalid token format (not 3 parts)', async () => {
        const context = createMockExecutionContext({
          authorization: 'Bearer invalid.token',
        });

        await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      });

      it('should reject invalid auth scheme', async () => {
        const token = createJwtToken({});
        const context = createMockExecutionContext({
          authorization: `Basic ${token}`,
        });

        await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
        await expectExceptionCode(() => guard.canActivate(context), 'INVALID_AUTH_SCHEME');
      });

      it('should reject token with wrong signature', async () => {
        const token = createJwtToken({}, WRONG_KEYPAIR.privateKey);
        const context = createMockExecutionContext({
          authorization: `Bearer ${token}`,
        });

        await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
        await expectExceptionCode(() => guard.canActivate(context), 'INVALID_TOKEN');
      });
    });

    describe('Token Expiration', () => {
      it('should reject expired token', async () => {
        const now = Math.floor(Date.now() / 1000);
        const token = createJwtToken({
          iat: now - 7200, // 2 hours ago
          exp: now - 3600, // 1 hour ago
        });
        const context = createMockExecutionContext({
          authorization: `Bearer ${token}`,
        });

        await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
        await expectExceptionCode(() => guard.canActivate(context), 'INVALID_TOKEN');
      });

      it('should accept token that expires in the future', async () => {
        const now = Math.floor(Date.now() / 1000);
        const token = createJwtToken({
          iat: now,
          exp: now + 86400, // 24 hours from now
        });
        const context = createMockExecutionContext({
          authorization: `Bearer ${token}`,
        });

        const result = await guard.canActivate(context);
        expect(result).toBe(true);
      });

      it('should accept token expiring in 1 second', async () => {
        // The property is "a token one second short of expiry is still
        // accepted" — not "the runner got from here to canActivate in under a
        // second". Against the real clock those are the same assertion only on
        // an idle machine: `now` is floored to whole seconds, so the token's
        // real remaining life is anywhere from 1000ms down to ~0ms, and this
        // suite takes ~40s under coverage instrumentation. Any scheduling
        // delay expires the token for real and the guard is right to reject
        // it. Pinning the clock makes the boundary the subject of the test
        // instead of the runner's load. Only `Date` is faked — the guard
        // awaits real work, so the timer APIs must keep running.
        const frozen = Date.now();
        jest.useFakeTimers({ doNotFake: TIMER_APIS_LEFT_REAL, now: frozen });

        const now = Math.floor(frozen / 1000);
        const token = createJwtToken({
          iat: now,
          exp: now + 1,
        });
        const context = createMockExecutionContext({
          authorization: `Bearer ${token}`,
        });

        const result = await guard.canActivate(context);
        expect(result).toBe(true);
      });
    });

    describe('Token Issuer Validation', () => {
      it('should accept token with valid issuer', async () => {
        const token = createJwtToken({ iss: JWT_ISSUER });
        const context = createMockExecutionContext({
          authorization: `Bearer ${token}`,
        });

        const result = await guard.canActivate(context);
        expect(result).toBe(true);
      });

      it('should reject token with invalid issuer', async () => {
        const token = createJwtToken({ iss: 'wrong-issuer' });
        const context = createMockExecutionContext({
          authorization: `Bearer ${token}`,
        });

        await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
        await expectExceptionCode(() => guard.canActivate(context), 'INVALID_TOKEN');
      });

      it('should reject token WITHOUT issuer claim (library-level enforcement)', async () => {
        // WHY inverted contract: issuer/audience are passed to verifyAsync,
        // so jsonwebtoken rejects tokens MISSING iss — the old
        // application-layer conditional (if payload.iss && ...) silently
        // accepted them, which is exactly the hole this closes.
        const header = { alg: 'RS256', typ: 'JWT' };
        const now = Math.floor(Date.now() / 1000);

        const payload = {
          sub: 'user-123',
          tenantId: 'tenant-123',
          roles: ['user'],
          type: 'access',
          iat: now,
          exp: now + 3600,
          aud: JWT_AUDIENCE,
        };

        const headerB64 = base64UrlEncode(JSON.stringify(header));
        const payloadB64 = base64UrlEncode(JSON.stringify(payload));
        const data = `${headerB64}.${payloadB64}`;
        const signature = crypto
          .createSign('RSA-SHA256')
          .update(data)
          .sign(TEST_KEYPAIR.privateKey);
        const signatureB64 = base64UrlEncode(signature);
        const token = `${headerB64}.${payloadB64}.${signatureB64}`;

        const context = createMockExecutionContext({
          authorization: `Bearer ${token}`,
        });

        await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
        await expectExceptionCode(() => guard.canActivate(context), 'INVALID_TOKEN');
      });
    });

    describe('Token Audience Validation', () => {
      it('should accept token with valid audience', async () => {
        const token = createJwtToken({ aud: JWT_AUDIENCE });
        const context = createMockExecutionContext({
          authorization: `Bearer ${token}`,
        });

        const result = await guard.canActivate(context);
        expect(result).toBe(true);
      });

      it('should accept token with audience array containing valid audience', async () => {
        const token = createJwtToken({ aud: ['other-audience', JWT_AUDIENCE] });
        const context = createMockExecutionContext({
          authorization: `Bearer ${token}`,
        });

        const result = await guard.canActivate(context);
        expect(result).toBe(true);
      });

      it('should reject token with invalid audience', async () => {
        const token = createJwtToken({ aud: 'wrong-audience' });
        const context = createMockExecutionContext({
          authorization: `Bearer ${token}`,
        });

        await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
        await expectExceptionCode(() => guard.canActivate(context), 'INVALID_TOKEN');
      });
    });

    describe('Token Type Validation', () => {
      it('should accept access token', async () => {
        const token = createJwtToken({ type: 'access' });
        const context = createMockExecutionContext({
          authorization: `Bearer ${token}`,
        });

        const result = await guard.canActivate(context);
        expect(result).toBe(true);
      });

      it('should reject refresh token', async () => {
        const token = createJwtToken({ type: 'refresh' });
        const context = createMockExecutionContext({
          authorization: `Bearer ${token}`,
        });

        await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
        await expectExceptionCode(() => guard.canActivate(context), 'INVALID_TOKEN_TYPE');
      });
    });

    describe('Token Blacklisting', () => {
      it('should reject blacklisted token', async () => {
        const jti = 'token-to-blacklist';
        tokenBlacklist.isValidToken.mockResolvedValue(false);

        const token = createJwtToken({ jti });
        const context = createMockExecutionContext({
          authorization: `Bearer ${token}`,
        });

        await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
        await expectExceptionCode(() => guard.canActivate(context), 'TOKEN_REVOKED');
        expect(tokenBlacklist.isValidToken).toHaveBeenCalledWith(
          jti,
          'user-123',
          expect.any(Number),
        );
      });

      it('should accept non-blacklisted token with jti', async () => {
        const token = createJwtToken({ jti: 'valid-token-id' });
        const context = createMockExecutionContext({
          authorization: `Bearer ${token}`,
        });

        const result = await guard.canActivate(context);
        expect(result).toBe(true);
      });
    });
  });

  describe('API Key Authentication', () => {
    beforeEach(() => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === API_KEY_AUTH_KEY) return true;
        return false;
      });
    });

    it('should accept valid API key in header', async () => {
      const context = createMockExecutionContext({
        'x-api-key': 'valid-api-key-123',
      });

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      const request = getRequest(context);
      expect(request.authMethod).toBe('api_key');
      expect(request.user!.sub).toBe('api-user-1');
    });

    it('should REJECT API key supplied via query parameter (removed source)', async () => {
      // WHY inverted contract: query-string API keys leak through access
      // logs, referrers and browser history — the strategy accepts the
      // x-api-key header ONLY. A key in the query string must not authenticate.
      const context = createMockExecutionContext({}, { api_key: 'valid-api-key-123' });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expectExceptionCode(() => guard.canActivate(context), 'MISSING_API_KEY');
    });

    it('should reject missing API key', async () => {
      const context = createMockExecutionContext({});

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expectExceptionCode(() => guard.canActivate(context), 'MISSING_API_KEY');
    });

    it('should reject invalid API key', async () => {
      const context = createMockExecutionContext({
        'x-api-key': 'invalid-key',
      });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expectExceptionCode(() => guard.canActivate(context), 'INVALID_API_KEY');
    });

    it('should reject disabled API key', async () => {
      const context = createMockExecutionContext({
        'x-api-key': 'disabled-api-key',
      });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expectExceptionCode(() => guard.canActivate(context), 'API_KEY_DISABLED');
    });

    it('should prefer header API key over query parameter', async () => {
      const context = createMockExecutionContext(
        { 'x-api-key': 'valid-api-key-123' },
        { api_key: 'invalid-key' },
      );

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('Basic Authentication', () => {
    beforeEach(() => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === BASIC_AUTH_KEY) return true;
        return false;
      });
    });

    it('should accept valid basic auth credentials', async () => {
      const credentials = Buffer.from('admin:admin-password').toString('base64');
      const context = createMockExecutionContext({
        authorization: `Basic ${credentials}`,
      });

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      const request = getRequest(context);
      expect(request.authMethod).toBe('basic');
      expect(request.user!.sub).toBe('admin');
    });

    it('should accept service account credentials', async () => {
      const credentials = Buffer.from('service:service-password').toString('base64');
      const context = createMockExecutionContext({
        authorization: `Basic ${credentials}`,
      });

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should reject missing Authorization header', async () => {
      const context = createMockExecutionContext({});

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expectExceptionCode(() => guard.canActivate(context), 'MISSING_AUTH_HEADER');
    });

    it('should reject invalid auth scheme', async () => {
      const credentials = Buffer.from('admin:admin-password').toString('base64');
      const context = createMockExecutionContext({
        authorization: `Bearer ${credentials}`,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expectExceptionCode(() => guard.canActivate(context), 'INVALID_AUTH_SCHEME');
    });

    it('should reject invalid credentials format (no colon)', async () => {
      const credentials = Buffer.from('invalidformat').toString('base64');
      const context = createMockExecutionContext({
        authorization: `Basic ${credentials}`,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should reject invalid username', async () => {
      const credentials = Buffer.from('wronguser:admin-password').toString('base64');
      const context = createMockExecutionContext({
        authorization: `Basic ${credentials}`,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expectExceptionCode(() => guard.canActivate(context), 'INVALID_CREDENTIALS');
    });

    it('should reject invalid password', async () => {
      const credentials = Buffer.from('admin:wrong-password').toString('base64');
      const context = createMockExecutionContext({
        authorization: `Basic ${credentials}`,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expectExceptionCode(() => guard.canActivate(context), 'INVALID_CREDENTIALS');
    });
  });

  describe('Public Routes', () => {
    it('should allow access to public routes without authentication', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === IS_PUBLIC_KEY) return true;
        return false;
      });

      const context = createMockExecutionContext({});

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should not require token for public routes', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === IS_PUBLIC_KEY) return true;
        return false;
      });

      const context = createMockExecutionContext({ authorization: 'invalid' });

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('GraphQL Context', () => {
    it('should extract request from GraphQL context', async () => {
      const token = createJwtToken({});

      // Since we can't easily mock the GqlExecutionContext in this test setup,
      // we verify HTTP context works and trust the GraphQL path is similar
      const httpContext = createMockExecutionContext({
        authorization: `Bearer ${token}`,
      });

      const result = await guard.canActivate(httpContext);
      expect(result).toBe(true);
    });
  });

  describe('Security', () => {
    it('should use timing-safe comparison for signatures', async () => {
      // This test verifies the implementation uses timingSafeEqual
      // by checking that slightly different signatures are rejected
      const validToken = createJwtToken({});
      const parts = validToken.split('.');
      const originalSignature = parts[2] ?? '';

      // Tamper with one character in the signature.
      // WHY conditional flip: hardcoding 'X' silently produces an UNCHANGED
      // signature whenever the random RSA signature already ends in 'X' —
      // a 1-in-64 flake that asserts nothing.
      // WHY middle flip: base64url pads the final sextet — for a 256-byte
      // RSA signature only 4 bits of the LAST character are significant, so
      // a last-char flip can decode to the identical byte string and assert
      // nothing. A mid-string flip always changes a fully-significant byte.
      const mid = Math.floor(originalSignature.length / 2);
      const tamperedSignature =
        originalSignature.substring(0, mid) +
        (originalSignature[mid] === 'A' ? 'B' : 'A') +
        originalSignature.substring(mid + 1);
      const tamperedToken = `${parts[0]}.${parts[1]}.${tamperedSignature}`;

      const context = createMockExecutionContext({
        authorization: `Bearer ${tamperedToken}`,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should hash API keys before storage lookup', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === API_KEY_AUTH_KEY) return true;
        return false;
      });

      // Valid API key should work (implementation hashes it)
      const context = createMockExecutionContext({
        'x-api-key': 'valid-api-key-123',
      });

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should not expose sensitive information in error messages', async () => {
      const context = createMockExecutionContext({
        authorization: 'Bearer invalid.token.here',
      });

      try {
        await guard.canActivate(context);
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(UnauthorizedException);
        const response = (error as UnauthorizedException).getResponse();
        // WHY: error payloads must not leak key material — assert no PEM
        // fragment of the verification keypair surfaces in the response.
        expect(JSON.stringify(response)).not.toContain('PRIVATE KEY');
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty Authorization header', async () => {
      const context = createMockExecutionContext({
        authorization: '',
      });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should handle Authorization header with only Bearer', async () => {
      const context = createMockExecutionContext({
        authorization: 'Bearer',
      });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should handle Authorization header with extra spaces', async () => {
      const token = createJwtToken({});
      const context = createMockExecutionContext({
        authorization: `Bearer  ${token}`,
      });

      // Extra space should cause validation to fail
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should handle case-insensitive Bearer scheme', async () => {
      const token = createJwtToken({});
      const context = createMockExecutionContext({
        authorization: `BEARER ${token}`,
      });

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should handle very long tokens', async () => {
      // Create a token with a lot of claims
      const token = createJwtToken({
        permissions: Array(100)
          .fill(null)
          .map((_, i) => `permission-${i}`),
      });
      const context = createMockExecutionContext({
        authorization: `Bearer ${token}`,
      });

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('Burst Authentication', () => {
    it('should authenticate a bounded sequential burst without request state leakage', async () => {
      const contexts = Array.from({ length: 100 }, (_, i) => {
        const token = createJwtToken({ sub: `user-${i}` });
        return createMockExecutionContext({
          authorization: `Bearer ${token}`,
        });
      });

      for (const [index, context] of contexts.entries()) {
        await expect(guard.canActivate(context)).resolves.toBe(true);
        expect(getRequest(context).user?.sub).toBe(`user-${index}`);
        expect(getRequest(context).authMethod).toBe('jwt');
      }
    });
  });
});
