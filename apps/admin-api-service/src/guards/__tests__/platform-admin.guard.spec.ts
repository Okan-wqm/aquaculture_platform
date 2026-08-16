/**
 * PlatformAdminGuard - Comprehensive Security Tests
 *
 * Tests cover:
 * - JWT verification and validation
 * - Role-based access control (RBAC)
 * - Public route bypass
 * - Token expiration handling
 * - Malformed/tampered token rejection
 * - JWT secret configuration validation
 */
import {
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  RequestMethod,
  UnauthorizedException,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import {
  SecurityEventService,
  SlidingWindowStrategy,
  TOKEN_BLACKLIST,
  USER_TOKEN_REVOCATION,
} from '@aquaculture/backend-common/security';
import { Role } from '@platform/identity';
import * as jwt from 'jsonwebtoken';

import {
  PlatformAdminGuard,
  hasGeneratedRoutePermissions,
  type JwtPayload,
} from '../platform-admin.guard';

jest.mock('@aquaculture/backend-common/auth', () => {
  const actual = jest.requireActual<typeof import('@aquaculture/backend-common/auth')>(
    '@aquaculture/backend-common/auth',
  );
  return {
    ...actual,
    getJwtVerifyOptions: jest.fn(() => ({
      secret: 'a-very-secure-test-secret-that-is-at-least-32-chars-long',
    })),
  };
});

interface MockRequest {
  headers: { authorization?: string };
  method: string;
  url: string;
  path: string;
  ip: string;
  socket: { remoteAddress?: string };
  get(name: string): string | undefined;
  user?: {
    sub: string;
    id: string;
    email?: string;
    roles: string[];
    role?: string;
    tenantId?: string;
  };
}

describe('PlatformAdminGuard', () => {
  const TEST_JWT_SECRET = 'a-very-secure-test-secret-that-is-at-least-32-chars-long';
  let nodeEnv = 'development';

  let guard: PlatformAdminGuard;
  let moduleRef: TestingModule;
  let consumeWithConfig: jest.Mock;
  let publishTokenRejected: jest.Mock;
  let publishRateLimitExceeded: jest.Mock;
  let setHeader: jest.Mock;

  class ProtectedUsersController {
    readonly testController = true;
  }

  class PublicHealthController {
    readonly testController = true;
  }

  function protectedUsersHandler(): void {}
  function publicHealthHandler(): void {}

  Reflect.defineMetadata(PATH_METADATA, 'users', ProtectedUsersController);
  Reflect.defineMetadata(PATH_METADATA, '', protectedUsersHandler);
  Reflect.defineMetadata(METHOD_METADATA, RequestMethod.GET, protectedUsersHandler);
  Reflect.defineMetadata(PATH_METADATA, 'health', PublicHealthController);
  Reflect.defineMetadata(PATH_METADATA, '', publicHealthHandler);
  Reflect.defineMetadata(METHOD_METADATA, RequestMethod.GET, publicHealthHandler);

  function createMockExecutionContext(overrides: {
    authHeader?: string;
    method?: string;
    url?: string;
    isPublic?: boolean;
  }): ExecutionContext {
    const request: MockRequest = {
      headers: overrides.authHeader !== undefined ? { authorization: overrides.authHeader } : {},
      method: overrides.method || 'GET',
      url: overrides.url || '/test',
      path: overrides.url || '/test',
      ip: '203.0.113.9',
      socket: {},
      get: (name: string) =>
        name.toLowerCase() === 'user-agent' ? 'platform-admin-test' : undefined,
    };

    const response = { setHeader };

    const context = overrides.isPublic
      ? new ExecutionContextHost([request, response], PublicHealthController, publicHealthHandler)
      : new ExecutionContextHost(
          [request, response],
          ProtectedUsersController,
          protectedUsersHandler,
        );
    context.setType('http');
    return context;
  }

  function signToken(
    payload: Partial<JwtPayload>,
    secret = TEST_JWT_SECRET,
    options?: jwt.SignOptions,
  ): string {
    const defaults: JwtPayload = {
      sub: 'user-123',
      email: 'admin@test.com',
      roles: ['SUPER_ADMIN'],
      type: 'access',
      jti: 'test-jti',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    return jwt.sign({ ...defaults, ...payload }, secret, options);
  }

  beforeEach(async () => {
    nodeEnv = 'development';
    consumeWithConfig = jest.fn().mockResolvedValue({
      allowed: true,
      remaining: 19,
      resetTime: new Date(Date.now() + 60_000),
    });
    publishTokenRejected = jest.fn().mockResolvedValue(undefined);
    publishRateLimitExceeded = jest.fn().mockResolvedValue(undefined);
    setHeader = jest.fn();
    moduleRef = await Test.createTestingModule({
      providers: [
        PlatformAdminGuard,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => {
              if (key === 'JWT_SECRET') return TEST_JWT_SECRET;
              if (key === 'NODE_ENV') return nodeEnv;
              if (key === 'ALLOW_DEV_JWT_SECRET') return 'false';
              return defaultValue;
            }),
          },
        },
        {
          provide: JwtService,
          useValue: {
            verifyAsync: jest.fn((token: string) =>
              Promise.resolve(jwt.verify(token, TEST_JWT_SECRET) as JwtPayload),
            ),
          },
        },
        {
          provide: TOKEN_BLACKLIST,
          useValue: { isBlacklisted: jest.fn().mockResolvedValue(false) },
        },
        {
          provide: USER_TOKEN_REVOCATION,
          useValue: { isTokenValid: jest.fn().mockResolvedValue(true) },
        },
        {
          provide: SlidingWindowStrategy,
          useValue: { consumeWithConfig },
        },
        {
          provide: SecurityEventService,
          useValue: { publishTokenRejected, publishRateLimitExceeded },
        },
      ],
    }).compile();

    guard = moduleRef.get(PlatformAdminGuard);
  });

  // ========================================================================
  // 1. Public Route Bypass
  // ========================================================================
  describe('Public routes', () => {
    it('should allow access to @Public() decorated routes without token', async () => {
      const context = createMockExecutionContext({ isPublic: true });
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('should allow access to @Public() routes even with invalid token', async () => {
      const context = createMockExecutionContext({
        isPublic: true,
        authHeader: 'Bearer invalid-token',
      });
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });
  });

  // ========================================================================
  // 2. Missing / Malformed Authorization Header
  // ========================================================================
  describe('Authorization header validation', () => {
    it('should reject requests with no authorization header', async () => {
      const context = createMockExecutionContext({});
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('No authorization header provided');
    });

    it('should reject requests with empty authorization header', async () => {
      const context = createMockExecutionContext({ authHeader: '' });
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should reject requests with non-Bearer scheme', async () => {
      const context = createMockExecutionContext({ authHeader: 'Basic abc123' });
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow(
        'Invalid authorization header format',
      );
    });

    it('should reject Bearer without token', async () => {
      const context = createMockExecutionContext({ authHeader: 'Bearer ' });
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should reject Bearer with only whitespace', async () => {
      const context = createMockExecutionContext({ authHeader: 'Bearer' });
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('accounts failed authentication in the distributed per-IP bucket', async () => {
      const context = createMockExecutionContext({});
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);

      expect(consumeWithConfig).toHaveBeenCalledWith(
        'admin-failed-auth:ip:203.0.113.9',
        20,
        60_000,
      );
      expect(publishTokenRejected).toHaveBeenCalledWith(
        expect.objectContaining({
          ip: '203.0.113.9',
          reason: 'No authorization header provided',
        }),
      );
    });

    it('returns 429 with Retry-After when the failed-auth bucket is exhausted', async () => {
      consumeWithConfig.mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetTime: new Date(Date.now() + 30_000),
        retryAfter: 30,
      });
      const context = createMockExecutionContext({ authHeader: 'Bearer not.a.jwt' });

      try {
        await guard.canActivate(context);
        fail('Expected failed authentication to be throttled');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        if (!(error instanceof HttpException)) throw error;
        expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      }
      expect(setHeader).toHaveBeenCalledWith('Retry-After', '30');
      expect(publishRateLimitExceeded).toHaveBeenCalledTimes(1);
    });

    it('does not count an authenticated role denial as failed authentication', async () => {
      const token = signToken({ roles: ['TENANT_ADMIN'] });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      expect(consumeWithConfig).not.toHaveBeenCalled();
      expect(publishTokenRejected).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // 3. JWT Token Verification
  // ========================================================================
  describe('JWT token verification', () => {
    it('should accept a valid SUPER_ADMIN token', async () => {
      const token = signToken({ sub: 'admin-1', roles: ['SUPER_ADMIN'] });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('should reject a literal PLATFORM_ADMIN token because the auth role is SUPER_ADMIN', async () => {
      const token = signToken({ sub: 'admin-2', roles: ['PLATFORM_ADMIN'] });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should reject a token signed with wrong secret', async () => {
      const token = signToken({}, 'wrong-secret-that-is-also-at-least-32-characters');
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Invalid token');
    });

    it('should reject a malformed JWT', async () => {
      const context = createMockExecutionContext({ authHeader: 'Bearer not.a.jwt' });
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should reject a tampered JWT (modified payload)', async () => {
      const token = signToken({ roles: ['SUPER_ADMIN'] });
      // Tamper with the payload portion (middle segment)
      const parts = token.split('.');
      const encodedPayload = parts[1];
      if (!encodedPayload) throw new Error('JWT payload segment missing');
      const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString()) as Record<
        string,
        unknown
      >;
      payload.roles = ['HACKED_ROLE'];
      parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const tamperedToken = parts.join('.');

      const context = createMockExecutionContext({ authHeader: `Bearer ${tamperedToken}` });
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should reject an expired token', async () => {
      const token = signToken({
        iat: Math.floor(Date.now() / 1000) - 7200,
        exp: Math.floor(Date.now() / 1000) - 3600, // Expired 1 hour ago
      });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Token has expired');
    });

    it('rejects a signature-valid token whose jti is revoked', async () => {
      const blacklist = moduleRef.get<{ isBlacklisted: jest.Mock }>(TOKEN_BLACKLIST);
      blacklist.isBlacklisted.mockResolvedValue(true);
      const token = signToken({ jti: 'revoked-jti' });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await expect(guard.canActivate(context)).rejects.toMatchObject({
        response: { code: 'TOKEN_REVOKED' },
      });
    });

    it('rejects a signature-valid token older than the user invalidation epoch', async () => {
      const revocation = moduleRef.get<{ isTokenValid: jest.Mock }>(USER_TOKEN_REVOCATION);
      revocation.isTokenValid.mockResolvedValue(false);
      const token = signToken({ jti: 'family-revoked-jti' });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await expect(guard.canActivate(context)).rejects.toMatchObject({
        response: { code: 'TOKEN_REVOKED' },
      });
    });

    it('should reject a signed refresh token on admin-api routes', async () => {
      const token = signToken({ type: 'refresh' });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should reject a signed token without access token type', async () => {
      const token = signToken({ type: undefined });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should reject an access token without jti in production', async () => {
      nodeEnv = 'production';
      const token = signToken({ jti: undefined });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should attach user info to request on success', async () => {
      const token = signToken({
        sub: 'user-555',
        email: 'test@admin.com',
        roles: ['SUPER_ADMIN'],
        tenantId: 'tenant-abc',
      });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await guard.canActivate(context);

      const request = context.switchToHttp().getRequest<MockRequest>();
      const user = request.user;
      expect(user).toBeDefined();
      if (!user) throw new Error('Expected guard to attach user to request');
      expect(user.id).toBe('user-555');
      expect(user.email).toBe('test@admin.com');
      expect(user.roles).toContain('SUPER_ADMIN');
      expect(user.tenantId).toBe('tenant-abc');
    });

    it('attaches the canonical `sub` so the shared ThrottlerGuard recognizes the user (no anonymous-tier 429 storm)', async () => {
      // Regression: the shared backend-common ThrottlerGuard reads
      // `request.user?.sub`. When this guard exposed only `id`, every
      // authenticated SUPER_ADMIN was throttled at the anonymous tier (20/60s)
      // and keyed by IP, so a single operator's admin-panel fan-out tripped 429s.
      const token = signToken({ sub: 'admin-sub-1', roles: ['SUPER_ADMIN'] });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await guard.canActivate(context);

      const user = context.switchToHttp().getRequest<MockRequest>().user;
      if (!user) throw new Error('Expected guard to attach user to request');
      // Both the canonical identity field and the admin-api-local alias resolve
      // to the JWT subject — the throttler now sees an authenticated user.
      expect(user.sub).toBe('admin-sub-1');
      expect(user.id).toBe('admin-sub-1');
    });
  });

  // ========================================================================
  // 4. Role-Based Access Control (RBAC)
  // ========================================================================
  describe('Role-based access control', () => {
    it('should allow SUPER_ADMIN when no @Roles() decorator (default roles)', async () => {
      const token = signToken({ roles: ['SUPER_ADMIN'] });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('should reject PLATFORM_ADMIN when no @Roles() decorator (auth role remains SUPER_ADMIN)', async () => {
      const token = signToken({ roles: ['PLATFORM_ADMIN'] });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should reject TENANT_ADMIN when no @Roles() decorator (default requires admin)', async () => {
      const token = signToken({ roles: ['TENANT_ADMIN'] });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should reject MODULE_USER when no @Roles() decorator', async () => {
      const token = signToken({ roles: ['MODULE_USER'] });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should reject user with empty roles array', async () => {
      const token = signToken({ roles: [], role: undefined });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('rejects non-canonical role casing from a signed token', async () => {
      const token = signToken({ roles: ['super_admin'] });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('does not let a signed tenant role widen the generated platform-admin policy', async () => {
      const token = signToken({ roles: ['TENANT_ADMIN'] });
      const context = createMockExecutionContext({
        authHeader: `Bearer ${token}`,
      });
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('rejects a module role outside the generated role requirement', async () => {
      const token = signToken({ roles: ['MODULE_USER'] });
      const context = createMockExecutionContext({
        authHeader: `Bearer ${token}`,
      });
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should handle singular role field (role instead of roles)', async () => {
      const token = signToken({ role: 'SUPER_ADMIN', roles: undefined });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('should include required roles in ForbiddenException message', async () => {
      const token = signToken({ roles: ['MODULE_USER'] });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      try {
        await guard.canActivate(context);
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenException);
        if (!(error instanceof ForbiddenException)) throw error;
        expect(error.message).toContain('SUPER_ADMIN');
      }
    });
  });

  // ========================================================================
  // 5. Security Edge Cases
  // ========================================================================
  describe('Security edge cases', () => {
    it('should not leak error details for generic JWT errors', async () => {
      // Completely invalid token
      const context = createMockExecutionContext({ authHeader: 'Bearer x' });
      try {
        await guard.canActivate(context);
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(UnauthorizedException);
        if (!(error instanceof UnauthorizedException)) throw error;
        // Should not contain internal details
        const msg = error.message;
        expect(msg).not.toContain('stack');
        expect(msg).not.toContain('at ');
      }
    });

    it('should handle JWT with no roles or role field gracefully', async () => {
      // Sign without roles fields
      const payload = {
        sub: 'user-1',
        email: 'test@test.com',
        type: 'access',
        jti: 'test-jti-no-roles',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const token = jwt.sign(payload, TEST_JWT_SECRET);
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      // Should deny access (empty roles)
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should not re-throw ForbiddenException as UnauthorizedException', async () => {
      const token = signToken({ roles: ['MODULE_USER'] });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      // Not UnauthorizedException
      try {
        await guard.canActivate(context);
      } catch (error) {
        expect(error).not.toBeInstanceOf(UnauthorizedException);
      }
    });
  });
});

describe('generated route permission evaluation', () => {
  it.each([Role.SUPER_ADMIN, Role.TENANT_ADMIN])(
    'honours canonical all-permission mode for %s',
    (role) => {
      expect(hasGeneratedRoutePermissions([role], new Set(), ['users:view'])).toBe(true);
    },
  );

  it('requires assigned capabilities for non-bypass roles', () => {
    expect(hasGeneratedRoutePermissions([Role.MODULE_MANAGER], new Set(), ['users:view'])).toBe(
      false,
    );
    expect(
      hasGeneratedRoutePermissions([Role.MODULE_MANAGER], new Set(['users:view']), ['users:view']),
    ).toBe(true);
  });
});
