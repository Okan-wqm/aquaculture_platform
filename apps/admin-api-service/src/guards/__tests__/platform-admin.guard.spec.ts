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
  IpRateLimiterService,
  SecurityEventService,
  TOKEN_BLACKLIST,
  USER_TOKEN_REVOCATION,
} from '@aquaculture/backend-common/security';
import {
  ExecutionContext,
  HttpException,
  HttpStatus,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';

import { IS_PUBLIC_KEY } from '../../decorators/public.decorator';
import { ROLES_KEY } from '../../decorators/roles.decorator';
import { PlatformAdminGuard, JwtPayload } from '../platform-admin.guard';

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
  let reflector: Reflector;
  // APA-367: the guard now REQUIRES both revocation stores. Default them to
  // "token valid" so the existing signature/RBAC tests are unaffected; the
  // revocation describe-block flips them per-case.
  let isBlacklisted: jest.Mock;
  let isTokenValid: jest.Mock;
  // APA-369: per-IP failed-auth limiter + security-event publisher. Defaults:
  // limiter allows (so existing 401 tests still throw 401, not 429); event
  // publishers are no-ops. The APA-369 describe-block flips them per-case.
  let checkLimit: jest.Mock;
  let publishTokenRejected: jest.Mock;
  let publishRateLimitExceeded: jest.Mock;
  let setHeader: jest.Mock;

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
    };

    const mockReflector = reflector;

    // Set up reflector responses
    jest.spyOn(mockReflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
      if (key === IS_PUBLIC_KEY) return overrides.isPublic || false;
      if (key === ROLES_KEY) return overrides.requiredRoles || undefined;
      return undefined;
    });

    return {
      // These are HTTP-boundary tests. The guard short-circuits non-http
      // (rpc/ws) contexts (APA-030), so the mock must report 'http' or every
      // assertion below would pass trivially via the rpc bypass.
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: <T = MockRequest>() => request as T,
        getResponse: () => ({ setHeader }),
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
    isBlacklisted = jest.fn().mockResolvedValue(false);
    isTokenValid = jest.fn().mockResolvedValue(true);
    checkLimit = jest.fn().mockReturnValue({ allowed: true, remaining: 99 });
    publishTokenRejected = jest.fn().mockResolvedValue(undefined);
    publishRateLimitExceeded = jest.fn().mockResolvedValue(undefined);
    setHeader = jest.fn();
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
        // APA-367: revocation stores are REQUIRED injections. isBlacklisted covers
        // the per-jti + `token:blacklist:` bulk namespace; isTokenValid covers the
        // `user_blacklist:` epoch (force-logout / deletion / RBAC reduction).
        { provide: TOKEN_BLACKLIST, useValue: { isBlacklisted } },
        { provide: USER_TOKEN_REVOCATION, useValue: { isTokenValid } },
        // APA-369: per-IP failed-auth limiter + incident-pipeline event publisher.
        { provide: IpRateLimiterService, useValue: { checkLimit } },
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
  // 3b. Token revocation (APA-367)
  //
  // admin-api is a directly-reachable auth boundary (prod nginx routes /api/
  // straight here, bypassing gateway-api's blacklist-checking guard), so it must
  // self-enforce revocation. A signature-valid SUPER_ADMIN token whose session
  // was force-logged-out / whose owner was deleted / whose password was reset
  // must be rejected here, not honoured until natural TTL.
  // ========================================================================
  describe('Token revocation (APA-367)', () => {
    it('rejects a valid-signature SUPER_ADMIN token whose jti is individually blacklisted', async () => {
      isBlacklisted.mockResolvedValue(true);
      const token = signToken({ sub: 'admin-1', jti: 'revoked-jti', roles: ['SUPER_ADMIN'] });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Token has been revoked');
      expect(isBlacklisted).toHaveBeenCalledWith('revoked-jti');
    });

    it('rejects a token issued before a user-level revocation epoch (force-logout / deletion)', async () => {
      // Per-jti store says clean, but the user_blacklist epoch invalidates it.
      isBlacklisted.mockResolvedValue(false);
      isTokenValid.mockResolvedValue(false);
      const token = signToken({ sub: 'admin-2', roles: ['SUPER_ADMIN'] });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Token has been revoked');
      expect(isTokenValid).toHaveBeenCalledWith('admin-2', expect.any(Date));
    });

    it('admits a non-revoked SUPER_ADMIN token and consults BOTH revocation namespaces', async () => {
      const token = signToken({ sub: 'admin-3', jti: 'live-jti', roles: ['SUPER_ADMIN'] });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(isBlacklisted).toHaveBeenCalledWith('live-jti');
      expect(isTokenValid).toHaveBeenCalledWith('admin-3', expect.any(Date));
    });
  });

  // ========================================================================
  // 3c. Failed-auth throttling + security events (APA-369)
  //
  // This guard is the FIRST APP_GUARD, so failed-auth requests never reach the
  // shared ThrottlerGuard. It must therefore account failed auth against a
  // per-IP bucket itself, emit an incident-pipeline event, and log at warn.
  // ========================================================================
  describe('Failed-auth throttling + security events (APA-369)', () => {
    it('accounts a failed auth against the per-IP bucket and emits AUTH_TOKEN_REJECTED (401 under the limit)', async () => {
      const context = createMockExecutionContext({}); // no authorization header
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      expect(checkLimit).toHaveBeenCalledTimes(1);
      expect(publishTokenRejected).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'No authorization header provided' }),
      );
      expect(publishRateLimitExceeded).not.toHaveBeenCalled();
    });

    it('rejects with 429 + emits RATE_LIMIT_EXCEEDED once the IP crosses the failed-auth limit', async () => {
      checkLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfter: 30 });
      const context = createMockExecutionContext({ authHeader: 'Bearer not.a.jwt' });
      try {
        await guard.canActivate(context);
        fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      }
      expect(publishRateLimitExceeded).toHaveBeenCalledTimes(1);
      expect(setHeader).toHaveBeenCalledWith('Retry-After', '30');
    });

    it('does NOT count a valid SUPER_ADMIN request against the failed-auth limiter', async () => {
      const token = signToken({ roles: ['SUPER_ADMIN'] });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(checkLimit).not.toHaveBeenCalled();
      expect(publishTokenRejected).not.toHaveBeenCalled();
    });

    it('does NOT count an insufficient-role (403) request as a failed auth', async () => {
      const token = signToken({ roles: ['TENANT_ADMIN'] });
      const context = createMockExecutionContext({ authHeader: `Bearer ${token}` });
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      expect(checkLimit).not.toHaveBeenCalled();
      expect(publishTokenRejected).not.toHaveBeenCalled();
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

  describe('hybrid-app RPC scoping (APA-030)', () => {
    // admin-api-service is a hybrid app (HTTP + NATS microservice). The global
    // APP_GUARD must authenticate the HTTP boundary only and let NATS (rpc)
    // message handlers through — their identity is the broker-verified mTLS cert
    // CN (ADR-015), not a Bearer JWT. Before the fix the guard called
    // switchToHttp().getRequest() unconditionally and would have rejected every
    // inbound event, keeping TenantOnboardingAckHandler dead.
    function makeRpcContext(): ExecutionContext {
      // Fully-typed double: every method is a jest.fn() (assignable to the
      // framework interface, including generic getType), so no cast is needed.
      const context: ExecutionContext = {
        getType: jest.fn(),
        getClass: jest.fn(),
        getHandler: jest.fn(),
        getArgs: jest.fn(),
        getArgByIndex: jest.fn(),
        switchToRpc: jest.fn(),
        switchToWs: jest.fn(),
        switchToHttp: jest.fn(),
      };
      (context.getType as jest.Mock).mockReturnValue('rpc');
      (context.switchToHttp as jest.Mock).mockImplementation(() => {
        throw new Error('switchToHttp() must not be called for an rpc context');
      });
      return context;
    }

    it('returns true for a NATS (rpc) context without inspecting a JWT or the request', async () => {
      const spy = jest.spyOn(reflector, 'getAllAndOverride');
      await expect(guard.canActivate(makeRpcContext())).resolves.toBe(true);
      // Short-circuits before any reflector/JWT/request access.
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
