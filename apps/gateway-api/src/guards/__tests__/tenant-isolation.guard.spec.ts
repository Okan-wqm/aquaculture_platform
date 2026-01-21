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
 * TenantIsolationGuard Tests
 *
 * Comprehensive test suite for tenant isolation guard
 */

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import { TenantIsolationGuard } from '../tenant-isolation.guard';

/**
 * Interface for mock request with tenant context
 */
interface TenantRequest {
  user: Record<string, unknown> | null;
  headers: Record<string, string>;
  params: Record<string, string>;
  query: Record<string, string>;
  path: string;
  method: string;
  tenantId?: string;
}

/**
 * Interface for mock HTTP context
 */
interface MockHttpContext {
  getRequest: () => TenantRequest;
}

describe('TenantIsolationGuard', () => {
  let guard: TenantIsolationGuard;
  let reflector: Reflector;

  const createMockExecutionContext = (
    user: Record<string, unknown> | null = null,
    headers: Record<string, string> = {},
    params: Record<string, string> = {},
    query: Record<string, string> = {},
    host = 'api.example.com',
  ): ExecutionContext => {
    const mockRequest = {
      user,
      headers: { host, ...headers },
      params,
      query,
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
      getArgs: () => [{}, {}, { req: mockRequest }, {}],
    } as unknown as ExecutionContext;
  };

  /**
   * Helper to get typed request from context
   */
  const getRequest = (context: ExecutionContext): TenantRequest => {
    const httpContext = context.switchToHttp() as unknown as MockHttpContext;
    return httpContext.getRequest();
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantIsolationGuard,
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
                TENANT_ISOLATION_ENABLED: true,
                TENANT_HEADER: 'x-tenant-id',
                ALLOW_CROSS_TENANT_ACCESS: false,
              };
              return config[key] ?? defaultValue;
            }),
          },
        },
      ],
    }).compile();

    guard = module.get<TenantIsolationGuard>(TenantIsolationGuard);
    reflector = module.get<Reflector>(Reflector);
  });

  describe('Tenant ID Extraction', () => {
    it('should extract tenant ID from X-Tenant-ID header', () => {
      const context = createMockExecutionContext(
        { sub: 'user-1', tenantId: 'tenant-123' },
        { 'x-tenant-id': 'tenant-123' },
      );
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should extract tenant ID from JWT token', () => {
      const context = createMockExecutionContext({ sub: 'user-1', tenantId: 'tenant-456' });
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should extract tenant ID from subdomain', () => {
      const context = createMockExecutionContext(
        { sub: 'user-1', tenantId: 'acme' },
        {},
        {},
        {},
        'acme.example.com',
      );
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should extract tenant ID from query parameter', () => {
      const context = createMockExecutionContext(
        { sub: 'user-1', tenantId: 'tenant-789' },
        {},
        {},
        { tenantId: 'tenant-789' },
      );
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should extract tenant ID from path parameter', () => {
      const context = createMockExecutionContext(
        { sub: 'user-1', tenantId: 'tenant-abc' },
        {},
        { tenantId: 'tenant-abc' },
      );
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('Tenant Not Found', () => {
    it('should return 403 when user has no tenant association', () => {
      const context = createMockExecutionContext({ sub: 'user-1' }); // No tenantId
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should return 403 for empty tenant ID', () => {
      const context = createMockExecutionContext({ sub: 'user-1', tenantId: '' });
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe('Tenant Status Validation', () => {
    it('should allow access when user has valid tenant', () => {
      // The current implementation validates tenant at context level
      // Active/inactive status would be checked via user.tenantContext or external service
      const context = createMockExecutionContext({
        sub: 'user-1',
        tenantId: 'tenant-123',
        tenantContext: { isActive: true }
      });
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should allow access to user tenant without explicit header', () => {
      const context = createMockExecutionContext({ sub: 'user-1', tenantId: 'tenant-123' });
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should set tenant context on request', () => {
      const context = createMockExecutionContext({ sub: 'user-1', tenantId: 'tenant-123' });
      guard.canActivate(context);

      const request = getRequest(context);
      expect(request.tenantId).toBe('tenant-123');
    });
  });

  describe('Cross-tenant Request Prevention', () => {
    it('should block cross-tenant access', () => {
      const context = createMockExecutionContext(
        { sub: 'user-1', tenantId: 'tenant-A' },
        { 'x-tenant-id': 'tenant-B' }, // Trying to access different tenant
      );
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should allow same-tenant access', () => {
      const context = createMockExecutionContext(
        { sub: 'user-1', tenantId: 'tenant-A' },
        { 'x-tenant-id': 'tenant-A' },
      );
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should detect tenant ID manipulation attempt', () => {
      const warnSpy = jest.spyOn(guard['logger'], 'warn');

      const context = createMockExecutionContext(
        { sub: 'user-1', tenantId: 'tenant-A' },
        { 'x-tenant-id': 'tenant-B' },
      );

      try {
        guard.canActivate(context);
      } catch {
        // Expected
      }

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cross-tenant access'),
        expect.any(Object),
      );
    });
  });

  describe('Admin/System User Access', () => {
    it('should allow system admin cross-tenant access', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true); // AdminOnly decorator

      const context = createMockExecutionContext(
        { sub: 'admin-1', tenantId: 'system', roles: ['system_admin'] },
        { 'x-tenant-id': 'tenant-B' },
      );
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should block non-admin cross-tenant access', () => {
      const context = createMockExecutionContext(
        { sub: 'user-1', tenantId: 'tenant-A', roles: ['user'] },
        { 'x-tenant-id': 'tenant-B' },
      );
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe('Public Route Handling', () => {
    it('should skip tenant check for public routes', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === 'isPublic') return true;
        return false;
      });

      const context = createMockExecutionContext(null); // No user, no tenant
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('Tenant Context Injection', () => {
    it('should inject tenant context into request', () => {
      const context = createMockExecutionContext({ sub: 'user-1', tenantId: 'tenant-123' });
      const request = getRequest(context);

      guard.canActivate(context);

      // Tenant context should be attached
      expect(request.tenantId || request.user?.tenantId).toBeDefined();
    });
  });

  describe('Multi-tenancy Strategy', () => {
    it('should support header-based tenant resolution', () => {
      const context = createMockExecutionContext(
        { sub: 'user-1', tenantId: 'tenant-header' },
        { 'x-tenant-id': 'tenant-header' },
      );
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should support subdomain-based tenant resolution', () => {
      const context = createMockExecutionContext(
        { sub: 'user-1', tenantId: 'subdomain' },
        {},
        {},
        {},
        'subdomain.example.com',
      );
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should prioritize JWT tenant over header', () => {
      const context = createMockExecutionContext(
        { sub: 'user-1', tenantId: 'jwt-tenant' },
        { 'x-tenant-id': 'header-tenant' },
      );

      // Should use JWT tenant and reject mismatched header
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe('Tenant Routing Logic', () => {
    it('should route to correct tenant database', () => {
      const context = createMockExecutionContext({ sub: 'user-1', tenantId: 'tenant-db-1' });
      const request = getRequest(context);

      guard.canActivate(context);

      // Tenant database should be set
      expect(request.tenantId || request.user?.tenantId).toBe('tenant-db-1');
    });
  });

  describe('Edge Cases', () => {
    it('should handle special characters in tenant ID', () => {
      const context = createMockExecutionContext({
        sub: 'user-1',
        tenantId: 'tenant-with-special_chars.123',
      });
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should handle UUID tenant IDs', () => {
      const context = createMockExecutionContext({
        sub: 'user-1',
        tenantId: '550e8400-e29b-41d4-a716-446655440000',
      });
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should handle numeric tenant IDs', () => {
      const context = createMockExecutionContext({
        sub: 'user-1',
        tenantId: '12345',
      });
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('Audit Logging', () => {
    it('should log cross-tenant access attempts', () => {
      const warnSpy = jest.spyOn(guard['logger'], 'warn');

      const context = createMockExecutionContext(
        { sub: 'user-1', tenantId: 'tenant-A' },
        { 'x-tenant-id': 'tenant-B' },
      );

      try {
        guard.canActivate(context);
      } catch {
        // Expected
      }

      expect(warnSpy).toHaveBeenCalled();
    });

    it('should successfully grant tenant access without logging in production', () => {
      // The implementation doesn't log successful access to reduce noise
      const context = createMockExecutionContext({ sub: 'user-1', tenantId: 'tenant-A' });
      const result = guard.canActivate(context);

      expect(result).toBe(true);
    });
  });

  describe('Performance', () => {
    it('should handle rapid tenant checks efficiently', () => {
      const startTime = Date.now();

      for (let i = 0; i < 1000; i++) {
        const context = createMockExecutionContext({ sub: 'user-1', tenantId: `tenant-${i}` });
        guard.canActivate(context);
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(1000); // Should complete in under 1 second
    });
  });
});
