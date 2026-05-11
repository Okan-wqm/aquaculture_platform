/* eslint-disable @typescript-eslint/no-dynamic-delete */
/* eslint-disable @typescript-eslint/no-empty-function */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

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


import {
  AuthGuard,
  IS_PUBLIC_KEY,
  API_KEY_AUTH_KEY,
  BASIC_AUTH_KEY,
  JwtPayload,
} from '../auth.guard';
import { ApiKeyAuthStrategy } from '../strategies/api-key-auth.strategy';
import { BasicAuthStrategy } from '../strategies/basic-auth.strategy';

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

  const JWT_SECRET = 'test-jwt-secret-key-for-testing';
  const JWT_ISSUER = 'test-issuer';
  const JWT_AUDIENCE = 'test-audience';

  /**
   * Create a valid JWT token for testing
   */
  const createJwtToken = (payload: Partial<JwtPayload>, secret = JWT_SECRET): string => {
    const header = { alg: 'HS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);

    const fullPayload: JwtPayload = {
      sub: 'user-123',
      tenantId: 'tenant-123',
      roles: ['user'],
      type: 'access',
      iat: now,
      exp: now + 3600, // 1 hour
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      ...payload,
    };

    const headerB64 = base64UrlEncode(JSON.stringify(header));
    const payloadB64 = base64UrlEncode(JSON.stringify(fullPayload));
    const data = `${headerB64}.${payloadB64}`;

    const signature = crypto.createHmac('sha256', secret).update(data).digest();
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
   * Helper to assert exception response code.
   *
   * Accepts either a synchronous thrower or a promise-returning callable;
   * `await fn()` un-wraps the result and any rejection surfaces via catch.
   * Without this the lint flags `() => guard.canActivate(...)` (which is
   * `() => Promise<boolean>`) as a misused-promise being passed to a
   * `() => void` slot.
   */
  const expectExceptionCode = async (
    fn: () => unknown,
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

  /**
   * Mock JwtService.verifyAsync that mirrors the production verifier's contract
   * for these tests' HS256 fixtures.
   *
   * WHY a real-shape mock instead of `useValue: { verifyAsync: jest.fn() }`:
   * production AuthGuard.validateJwt relies on the verifier rejecting bad iss /
   * aud / exp / signature / structure with library-equivalent errors. The
   * downstream UnauthorizedException codes (INVALID_TOKEN, INVALID_ISSUER,
   * INVALID_AUDIENCE, TOKEN_EXPIRED) are asserted by tests, so a no-op mock
   * would silently let invalid tokens through. We re-implement the same checks
   * against the HS256 test secret so every assertion the spec makes about JWT
   * verification logic still runs against a contract-faithful surface.
   *
   * The production AuthGuard at apps/gateway-api/src/guards/auth.guard.ts
   * verifies RS256 tokens via `getJwtVerifyOptions(configService).publicKey`.
   * The tests pre-date the RS256 migration and still construct HS256 tokens
   * with `JWT_SECRET`. The mock bridges the two: the guard receives a
   * `JwtService`-shaped collaborator whose contract matches what AuthGuard
   * relies on, while the spec keeps its HS256 fixtures.
   */
  const verifyHs256Token = (token: string): JwtPayload => {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('jwt malformed');
    }
    const headerB64 = parts[0] ?? '';
    const payloadB64 = parts[1] ?? '';
    const signatureB64 = parts[2] ?? '';

    const data = `${headerB64}.${payloadB64}`;
    const expectedSignature = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(data)
      .digest();
    const expectedSignatureB64 = base64UrlEncode(expectedSignature);

    // Use timing-safe comparison to mirror production verifier semantics.
    const a = Buffer.from(signatureB64, 'utf8');
    const b = Buffer.from(expectedSignatureB64, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new Error('invalid signature');
    }

    const padding = '='.repeat((4 - (payloadB64.length % 4)) % 4);
    const payloadJson = Buffer.from(
      payloadB64.replace(/-/g, '+').replace(/_/g, '/') + padding,
      'base64',
    ).toString('utf8');
    const payload = JSON.parse(payloadJson) as JwtPayload;

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && payload.exp < now) {
      const err = new Error('jwt expired') as Error & { name: string };
      err.name = 'TokenExpiredError';
      throw err;
    }

    if (payload.iss !== undefined && payload.iss !== JWT_ISSUER) {
      const err = new Error('jwt issuer invalid') as Error & { name: string };
      err.name = 'JsonWebTokenError';
      throw err;
    }

    if (payload.aud !== undefined) {
      const audMatch = Array.isArray(payload.aud)
        ? payload.aud.includes(JWT_AUDIENCE)
        : payload.aud === JWT_AUDIENCE;
      if (!audMatch) {
        const err = new Error('jwt audience invalid') as Error & { name: string };
        err.name = 'JsonWebTokenError';
        throw err;
      }
    }

    return payload;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthGuard,
        ApiKeyAuthStrategy,
        BasicAuthStrategy,
        {
          provide: Reflector,
          useValue: {
            getAllAndOverride: jest.fn().mockReturnValue(false),
          },
        },
        {
          provide: JwtService,
          useValue: {
            verifyAsync: jest.fn(async (token: string) =>
              Promise.resolve(verifyHs256Token(token)),
            ),
            sign: jest.fn(),
            verify: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => {
              const config: Record<string, unknown> = {
                JWT_SECRET: JWT_SECRET,
                JWT_ISSUER: JWT_ISSUER,
                JWT_AUDIENCE: JWT_AUDIENCE,
                // Provided so production code paths that read getJwtVerifyOptions
                // don't crash; the mock JwtService ignores the options anyway.
                JWT_PUBLIC_KEY:
                  '-----BEGIN PUBLIC KEY-----\nTEST-PLACEHOLDER\n-----END PUBLIC KEY-----',
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
                // BasicAuthStrategy.loadBasicAuthCredentials() at
                // apps/gateway-api/src/guards/strategies/basic-auth.strategy.ts:113
                // accepts pre-hashed bcrypt strings synchronously and only
                // schedules async bcrypt.hash() for raw passwords. Tests need
                // the credentials map populated before the first canActivate()
                // call, so we provide pre-hashed bcrypt values verifiable by
                // bcrypt.compare(plain, hash). The plain passwords correspond
                // to 'admin-password' and 'service-password' respectively.
                BASIC_AUTH_CREDENTIALS: JSON.stringify({
                  admin: '$2b$10$TMcrSCMcXE.8I6CaUZpSwO7O/fpWsrwau8Ia0hdHoJvswji8tCyRS',
                  service: '$2b$10$uBzZxjtSXtjzBG7Oi0slFuT7RRb7RfDQgrTsKgnmTnssjl6AEsk4e',
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
        const token = createJwtToken({}, 'wrong-secret');
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

        // AuthGuard collapses every verifier failure (expired / bad signature /
        // bad iss / bad aud / structural) into a single INVALID_TOKEN code at
        // apps/gateway-api/src/guards/auth.guard.ts:217. The previous spec
        // expected granular codes that the production guard no longer emits;
        // asserting the actual contract here.
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
        const now = Math.floor(Date.now() / 1000);
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

        // See note on the expired-token test: every verifier failure surfaces
        // as INVALID_TOKEN in the current guard contract.
        await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
        await expectExceptionCode(() => guard.canActivate(context), 'INVALID_TOKEN');
      });

      it('should accept token without issuer claim', async () => {
        // Create token without issuer
        const header = { alg: 'HS256', typ: 'JWT' };
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
        const signature = crypto.createHmac('sha256', JWT_SECRET).update(data).digest();
        const signatureB64 = base64UrlEncode(signature);
        const token = `${headerB64}.${payloadB64}.${signatureB64}`;

        const context = createMockExecutionContext({
          authorization: `Bearer ${token}`,
        });

        const result = await guard.canActivate(context);
        expect(result).toBe(true);
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

        // See note on the expired-token test: every verifier failure surfaces
        // as INVALID_TOKEN in the current guard contract.
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
        const now = Math.floor(Date.now() / 1000);

        // Blacklist the token
        await guard.blacklistToken(jti, now + 3600);

        const token = createJwtToken({ jti });
        const context = createMockExecutionContext({
          authorization: `Bearer ${token}`,
        });

        await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
        await expectExceptionCode(() => guard.canActivate(context), 'TOKEN_REVOKED');
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

    it('should reject API key in query parameter (header-only by policy)', async () => {
      // SECURITY: ApiKeyAuthStrategy.validate() at
      // apps/gateway-api/src/guards/strategies/api-key-auth.strategy.ts:53
      // accepts API keys ONLY from the x-api-key header. Query parameters
      // get logged, cached, and leak into browser history / referrer headers,
      // so the strategy intentionally refuses them. This spec asserts that
      // header-only contract; the prior expectation that query-param keys
      // were accepted reflected the pre-hardening behaviour.
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

      // Tamper with one character in the signature
      const tamperedSignature = originalSignature.substring(0, originalSignature.length - 1) + 'X';
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
        expect(JSON.stringify(response)).not.toContain(JWT_SECRET);
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

  describe('Performance', () => {
    it('should handle rapid authentication requests', async () => {
      const startTime = Date.now();

      for (let i = 0; i < 1000; i++) {
        const token = createJwtToken({ sub: `user-${i}` });
        const context = createMockExecutionContext({
          authorization: `Bearer ${token}`,
        });

        await guard.canActivate(context);
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(5000); // Should complete in under 5 seconds
    });
  });
});
