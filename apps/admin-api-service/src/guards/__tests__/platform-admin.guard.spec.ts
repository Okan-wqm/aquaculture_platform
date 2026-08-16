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
  RateLimitAuthorityUnavailableError,
  RateLimitEnforcementService,
} from '@aquaculture/backend-common/rate-limit';
import {
  SecurityEventService,
  TOKEN_REVOCATION_READER,
} from '@aquaculture/backend-common/security';
import {
  ExecutionContext,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';

import { ROLES_KEY } from '../../decorators/roles.decorator';
import { PlatformAdminGuard, JwtPayload, IS_PUBLIC_KEY } from '../platform-admin.guard';

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
  headers: { authorization?: string; 'user-agent'?: string };
  method: string;
  url: string;
  path: string;
  ip: string;
  socket: { remoteAddress?: string };
  user?: {
    sub: string;
    id: string;
    email?: string;
    roles: string[];
    role?: string;
    tenantId?: string;
    mfaVerified?: boolean;
    iat?: number;
    jti?: string;
  };
}

describe('PlatformAdminGuard', () => {
  const TEST_JWT_SECRET = 'a-very-secure-test-secret-that-is-at-least-32-chars-long';
  let nodeEnv = 'development';

  let guard: PlatformAdminGuard;
  let reflector: Reflector;
  let getRevocationStatus: jest.Mock;
  let evaluateRateLimit: jest.Mock;
  let publishTokenRejected: jest.Mock;
  let publishRateLimitExceeded: jest.Mock;

  function createMockExecutionContext(overrides: {
    authHeader?: string;
    method?: string;
    url?: string;
    isPublic?: boolean;
    requiredRoles?: string[];
  }): ExecutionContext {
    const request: MockRequest = {
      headers: overrides.authHeader !== undefined ? { authorization: overrides.authHeader } : {},
      method: overrides.method || 'GET',
      url: overrides.url || '/test',
      path: overrides.url || '/test',
      ip: '203.0.113.10',
      socket: { remoteAddress: '203.0.113.10' },
    };

    const mockReflector = reflector;

    // Set up reflector responses
    jest.spyOn(mockReflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
      if (key === IS_PUBLIC_KEY) return overrides.isPublic || false;
      if (key === ROLES_KEY) return overrides.requiredRoles || undefined;
      return undefined;
    });

    return {
      switchToHttp: () => ({
        getRequest: <T = MockRequest>() => request as T,
        getResponse: () => ({ setHeader: jest.fn() }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
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
    getRevocationStatus = jest.fn().mockResolvedValue({
      jtiRevoked: false,
      userEpochRevoked: false,
    });
    evaluateRateLimit = jest.fn().mockResolvedValue({
      key: 'admin-failed-auth:ip:203.0.113.10',
      entry: { count: 1, resetTime: Date.now() + 60_000 },
      allowed: true,
    });
    publishTokenRejected = jest.fn().mockResolvedValue(undefined);
    publishRateLimitExceeded = jest.fn().mockResolvedValue(undefined);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformAdminGuard,
        Reflector,
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
          provide: TOKEN_REVOCATION_READER,
          useValue: { getStatus: getRevocationStatus },
        },
        { provide: RateLimitEnforcementService, useValue: { evaluate: evaluateRateLimit } },
        {
          provide: SecurityEventService,
          useValue: { publishTokenRejected, publishRateLimitExceeded },
        },
      ],
    }).compile();

    guard = module.get(PlatformAdminGuard);
    reflector = module.get(Reflector);
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

    it('propagates only verified MFA/revocation claims to the canonical request user', async () => {
      const issuedAt = Math.floor(Date.now() / 1000);
      const token = signToken({
        sub: 'admin-mfa',
        mfaVerified: true,
        iat: issuedAt,
        jti: 'mfa-token-jti',
      });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });

      await guard.canActivate(context);

      expect(context.switchToHttp().getRequest<MockRequest>().user).toMatchObject({
        sub: 'admin-mfa',
        id: 'admin-mfa',
        mfaVerified: true,
        iat: issuedAt,
        jti: 'mfa-token-jti',
      });
    });

    it('rejects an individually revoked, otherwise-valid admin token', async () => {
      getRevocationStatus.mockResolvedValue({
        jtiRevoked: true,
        userEpochRevoked: false,
      });
      const context = createMockExecutionContext({
        authHeader: `Bearer ${signToken({ sub: 'revoked-admin', jti: 'revoked-jti' })}`,
      });

      await expect(guard.canActivate(context)).rejects.toThrow('Token has been revoked');
      expect(getRevocationStatus).toHaveBeenCalledWith(
        'revoked-jti',
        'revoked-admin',
        expect.any(Number),
      );
    });

    it('rejects a token older than the user revocation epoch', async () => {
      getRevocationStatus.mockResolvedValue({
        jtiRevoked: false,
        userEpochRevoked: true,
      });
      const context = createMockExecutionContext({
        authHeader: `Bearer ${signToken({ sub: 'family-revoked-admin' })}`,
      });

      await expect(guard.canActivate(context)).rejects.toThrow('Token has been revoked');
    });

    it('fails closed with 503 when the revocation authority is unavailable', async () => {
      getRevocationStatus.mockRejectedValue(new Error('redis unavailable'));
      const context = createMockExecutionContext({
        authHeader: `Bearer ${signToken({ sub: 'admin-redis-outage' })}`,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(ServiceUnavailableException);
      expect(evaluateRateLimit).not.toHaveBeenCalled();
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

    it('should perform case-insensitive role matching', async () => {
      const token = signToken({ roles: ['super_admin'] });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('should not let custom @Roles() widen admin-api beyond the platform admin auth role', async () => {
      const token = signToken({ roles: ['TENANT_ADMIN'] });
      const context = createMockExecutionContext({
        authHeader: `Bearer ${token}`,
        requiredRoles: ['TENANT_ADMIN', 'SUPER_ADMIN'],
      });
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should reject user not in custom @Roles() list', async () => {
      const token = signToken({ roles: ['MODULE_USER'] });
      const context = createMockExecutionContext({
        authHeader: `Bearer ${token}`,
        requiredRoles: ['SUPER_ADMIN'],
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
      } catch (e) {
        expect(e).toBeInstanceOf(ForbiddenException);
        expect((e as ForbiddenException).message).toContain('SUPER_ADMIN');
      }
    });
  });

  // ========================================================================
  // 5. Security Edge Cases
  // ========================================================================
  describe('Security edge cases', () => {
    it('accounts failed authentication through the canonical distributed limiter', async () => {
      const context = createMockExecutionContext({ authHeader: 'Bearer malformed' });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      expect(evaluateRateLimit).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'admin-failed-auth', requiresDistributedStore: true }),
        { ip: '203.0.113.10' },
      );
      expect(publishTokenRejected).toHaveBeenCalled();
    });

    it('returns 429 and publishes the shared event when the failed-auth budget is exhausted', async () => {
      evaluateRateLimit.mockResolvedValue({
        key: 'admin-failed-auth:ip:203.0.113.10',
        entry: { count: 21, resetTime: Date.now() + 60_000 },
        allowed: false,
      });
      const context = createMockExecutionContext({ authHeader: 'Bearer malformed' });

      await expect(guard.canActivate(context)).rejects.toThrow(HttpException);
      await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 429 });
      expect(publishRateLimitExceeded).toHaveBeenCalled();
    });

    it('fails closed when failed-auth distributed state is unavailable', async () => {
      evaluateRateLimit.mockRejectedValue(
        new RateLimitAuthorityUnavailableError('admin-failed-auth'),
      );
      const context = createMockExecutionContext({ authHeader: 'Bearer malformed' });

      await expect(guard.canActivate(context)).rejects.toThrow(ServiceUnavailableException);
    });

    it('should not leak error details for generic JWT errors', async () => {
      // Completely invalid token
      const context = createMockExecutionContext({ authHeader: 'Bearer x' });
      try {
        await guard.canActivate(context);
        fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(UnauthorizedException);
        // Should not contain internal details
        const msg = (e as UnauthorizedException).message;
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
      } catch (e) {
        expect(e).not.toBeInstanceOf(UnauthorizedException);
      }
    });
  });
});
