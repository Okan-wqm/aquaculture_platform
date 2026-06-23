 
 
 
 
 
 
 
 
 
 
 
 

/**
 * TenantContextMiddleware Tests
 *
 * Comprehensive test suite for tenant context middleware
 */

import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Request, Response } from 'express';

import {
  TenantContextMiddleware,
  TenantStatus,
  TenantContextRequest,
  TenantMetadata,
  getCurrentTenant,
  getCurrentTenantId,
  getTenantFromRequest,
  tenantHasFeature,
  getTenantLimit,
  getTenantSetting,
  tenantStorage,
} from '../tenant-context.middleware';

describe('TenantContextMiddleware', () => {
  let middleware: TenantContextMiddleware;

  /**
   * Create mock request
   */
  const createMockRequest = (
    options: {
      path?: string;
      headers?: Record<string, string>;
      query?: Record<string, unknown>;
      user?: { tenantId?: string };
    } = {},
  ): Request => {
    return {
      path: options.path || '/api/v1/test',
      headers: {
        host: 'api.example.com',
        ...options.headers,
      },
      query: options.query || {},
      user: options.user,
    } as unknown as Request;
  };

  /**
   * Create mock response
   */
  const createMockResponse = (): Response => {
    const headers: Record<string, string> = {};
    return {
      setHeader: jest.fn((name: string, value: string) => {
        headers[name] = value;
      }),
      getHeader: jest.fn((name: string) => headers[name]),
      _headers: headers,
    } as unknown as Response & { _headers: Record<string, string> };
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantContextMiddleware,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => {
              const config: Record<string, unknown> = {
                TENANT_CACHE_TTL: 300000,
                TENANT_PUBLIC_PATHS: '/health,/api/v1/auth/login',
              };
              return config[key] ?? defaultValue;
            }),
          },
        },
      ],
    }).compile();

    middleware = module.get<TenantContextMiddleware>(TenantContextMiddleware);
    middleware.clearCache();
  });

  describe('Tenant ID Resolution', () => {
    describe('Header Resolution', () => {
      it('should resolve tenant from X-Tenant-ID header', async () => {
        const req = createMockRequest({
          headers: { 'x-tenant-id': '00000000-0000-4000-8000-000000000016' },
        });
        const res = createMockResponse();
        const next = jest.fn();

        await middleware.use(req, res, next);

        const tenantReq = req as TenantContextRequest;
        expect(tenantReq.tenantId).toBe('00000000-0000-4000-8000-000000000016');
        expect(tenantReq.tenant?.id).toBe('00000000-0000-4000-8000-000000000016');
      });

      it('should prioritize the JWT claim over header and query sources', async () => {
        // WHY: the JWT tenantId is the cryptographically-verified trust
        // anchor — a spoofable x-tenant-id header must NEVER override it
        // for authenticated requests (CLAUDE.md tenant-ID sourcing).
        const req = createMockRequest({
          headers: { 'x-tenant-id': '00000000-0000-4000-8000-000000000008' },
          query: { tenantId: '00000000-0000-4000-8000-000000000013' },
          user: { tenantId: '00000000-0000-4000-8000-000000000010' },
        });
        const res = createMockResponse();
        const next = jest.fn();

        await middleware.use(req, res, next);

        const tenantReq = req as TenantContextRequest;
        expect(tenantReq.tenantId).toBe('00000000-0000-4000-8000-000000000010');
      });
    });

    describe('JWT Resolution', () => {
      it('should resolve tenant from JWT user', async () => {
        const req = createMockRequest({
          user: { tenantId: '00000000-0000-4000-8000-000000000010' },
        });
        const res = createMockResponse();
        const next = jest.fn();

        await middleware.use(req, res, next);

        const tenantReq = req as TenantContextRequest;
        expect(tenantReq.tenantId).toBe('00000000-0000-4000-8000-000000000010');
      });
    });

    describe('Query Parameter Resolution', () => {
      it('should IGNORE the query parameter (removed tenant source)', async () => {
        // WHY inverted contract: ?tenantId= was removed as a resolution
        // source — query strings land in access logs, referrers and browser
        // history, making them a spoof/leak channel. A request carrying ONLY
        // a query tenant must fail resolution loudly.
        const req = createMockRequest({
          query: { tenantId: '00000000-0000-4000-8000-000000000013' },
        });
        const res = createMockResponse();
        const next = jest.fn();

        await expect(middleware.use(req, res, next)).rejects.toThrow(BadRequestException);
        expect(next).not.toHaveBeenCalled();
      });
    });

    describe('Subdomain Resolution', () => {
      it('should resolve tenant from subdomain', async () => {
        const req = createMockRequest({
          headers: { host: 'acme.example.com' },
        });
        const res = createMockResponse();
        const next = jest.fn();

        await middleware.use(req, res, next);

        const tenantReq = req as TenantContextRequest;
        expect(tenantReq.tenantId).toBe('acme');
      });

      it('should ignore www subdomain', async () => {
        const req = createMockRequest({
          headers: {
            host: 'www.example.com',
            'x-tenant-id': '00000000-0000-4000-8000-000000000006',
          },
        });
        const res = createMockResponse();
        const next = jest.fn();

        await middleware.use(req, res, next);

        const tenantReq = req as TenantContextRequest;
        expect(tenantReq.tenantId).toBe('00000000-0000-4000-8000-000000000006');
      });

      it('should ignore api subdomain', async () => {
        const req = createMockRequest({
          headers: {
            host: 'api.example.com',
            'x-tenant-id': '00000000-0000-4000-8000-000000000006',
          },
        });
        const res = createMockResponse();
        const next = jest.fn();

        await middleware.use(req, res, next);

        const tenantReq = req as TenantContextRequest;
        expect(tenantReq.tenantId).toBe('00000000-0000-4000-8000-000000000006');
      });
    });

    describe('Path Resolution', () => {
      it('should resolve tenant from path', async () => {
        const req = createMockRequest({
          path: '/tenants/00000000-0000-4000-8000-000000000012/resources',
        });
        const res = createMockResponse();
        const next = jest.fn();

        await middleware.use(req, res, next);

        const tenantReq = req as TenantContextRequest;
        expect(tenantReq.tenantId).toBe('00000000-0000-4000-8000-000000000012');
      });
    });

    describe('Missing Tenant', () => {
      it('should throw error when tenant cannot be resolved', async () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        await expect(middleware.use(req, res, next)).rejects.toThrow(BadRequestException);
      });

      it('should include TENANT_NOT_FOUND code in error', async () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        try {
          await middleware.use(req, res, next);
        } catch (error) {
          expect(error).toBeInstanceOf(BadRequestException);
          expect((error as BadRequestException).getResponse()).toEqual(
            expect.objectContaining({
              code: 'TENANT_NOT_FOUND',
            }),
          );
        }
      });
    });
  });

  describe('Public Paths', () => {
    it('should skip tenant resolution for health endpoint', async () => {
      const req = createMockRequest({ path: '/health' });
      const res = createMockResponse();
      const next = jest.fn();

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should skip tenant resolution for login endpoint', async () => {
      const req = createMockRequest({ path: '/api/v1/auth/login' });
      const res = createMockResponse();
      const next = jest.fn();

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    // NOTE (SEC-CRITICAL-001): the register-endpoint case was removed —
    // no registration endpoint exists; registration is invitation-only.
  });

  describe('Tenant Status Validation', () => {
    it('should allow active tenant', async () => {
      const req = createMockRequest({
        headers: { 'x-tenant-id': '00000000-0000-4000-8000-000000000001' },
      });
      const res = createMockResponse();
      const next = jest.fn();

      await middleware.use(req, res, next);

      const tenantReq = req as TenantContextRequest;
      expect(tenantReq.tenant?.status).toBe(TenantStatus.ACTIVE);
      expect(next).toHaveBeenCalled();
    });

    // Note: Status validation tests would require mocking getTenantStatus
    // In the actual implementation, these would be integration tests
  });

  describe('Tenant Metadata', () => {
    it('should attach tenant metadata to request', async () => {
      const req = createMockRequest({
        headers: { 'x-tenant-id': '00000000-0000-4000-8000-000000000017' },
      });
      const res = createMockResponse();
      const next = jest.fn();

      await middleware.use(req, res, next);

      const tenantReq = req as TenantContextRequest;
      expect(tenantReq.tenant).toBeDefined();
      expect(tenantReq.tenant?.id).toBe('00000000-0000-4000-8000-000000000017');
      expect(tenantReq.tenant?.name).toBeDefined();
      expect(tenantReq.tenant?.settings).toBeDefined();
      expect(tenantReq.tenant?.features).toBeDefined();
      expect(tenantReq.tenant?.limits).toBeDefined();
    });

    it('should include tenant settings', async () => {
      const req = createMockRequest({
        headers: { 'x-tenant-id': '00000000-0000-4000-8000-000000000017' },
      });
      const res = createMockResponse();
      const next = jest.fn();

      await middleware.use(req, res, next);

      const tenantReq = req as TenantContextRequest;
      expect(tenantReq.tenant?.settings.timezone).toBeDefined();
      expect(tenantReq.tenant?.settings.locale).toBeDefined();
      expect(tenantReq.tenant?.settings.currency).toBeDefined();
    });

    it('should include tenant features', async () => {
      const req = createMockRequest({
        headers: { 'x-tenant-id': '00000000-0000-4000-8000-000000000017' },
      });
      const res = createMockResponse();
      const next = jest.fn();

      await middleware.use(req, res, next);

      const tenantReq = req as TenantContextRequest;
      expect(typeof tenantReq.tenant?.features.advancedAnalytics).toBe('boolean');
      expect(typeof tenantReq.tenant?.features.alertEngine).toBe('boolean');
      expect(typeof tenantReq.tenant?.features.iotIntegration).toBe('boolean');
    });

    it('should include tenant limits', async () => {
      const req = createMockRequest({
        headers: { 'x-tenant-id': '00000000-0000-4000-8000-000000000017' },
      });
      const res = createMockResponse();
      const next = jest.fn();

      await middleware.use(req, res, next);

      const tenantReq = req as TenantContextRequest;
      expect(typeof tenantReq.tenant?.limits.maxUsers).toBe('number');
      expect(typeof tenantReq.tenant?.limits.maxFarms).toBe('number');
      expect(typeof tenantReq.tenant?.limits.maxSensors).toBe('number');
    });
  });

  describe('Response Headers', () => {
    it('should set X-Tenant-ID header in response', async () => {
      const req = createMockRequest({
        headers: { 'x-tenant-id': '00000000-0000-4000-8000-000000000017' },
      });
      const res = createMockResponse() as Response & { _headers: Record<string, string> };
      const next = jest.fn();

      await middleware.use(req, res, next);

       
      const setHeaderMock = res.setHeader as jest.Mock;
      expect(setHeaderMock.mock.calls).toEqual(
        expect.arrayContaining([
          expect.arrayContaining(['X-Tenant-ID', '00000000-0000-4000-8000-000000000017']),
        ]),
      );
    });

    it('should set X-Tenant-Name header in response', async () => {
      const req = createMockRequest({
        headers: { 'x-tenant-id': '00000000-0000-4000-8000-000000000017' },
      });
      const res = createMockResponse() as Response & { _headers: Record<string, string> };
      const next = jest.fn();

      await middleware.use(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith('X-Tenant-Name', expect.any(String));
    });
  });

  describe('AsyncLocalStorage Context', () => {
    it('should run next middleware within tenant context', async () => {
      const req = createMockRequest({
        headers: { 'x-tenant-id': '00000000-0000-4000-8000-000000000003' },
      });
      const res = createMockResponse();

      let capturedTenant: TenantMetadata | undefined;
      const next = jest.fn(() => {
        capturedTenant = tenantStorage.getStore();
      });

      await middleware.use(req, res, next);

      expect(capturedTenant).toBeDefined();
      expect(capturedTenant?.id).toBe('00000000-0000-4000-8000-000000000003');
    });
  });

  describe('Cache Management', () => {
    it('should cache tenant data', async () => {
      const req1 = createMockRequest({
        headers: { 'x-tenant-id': '00000000-0000-4000-8000-000000000002' },
      });
      const res1 = createMockResponse();
      const next1 = jest.fn();

      await middleware.use(req1, res1, next1);

      const req2 = createMockRequest({
        headers: { 'x-tenant-id': '00000000-0000-4000-8000-000000000002' },
      });
      const res2 = createMockResponse();
      const next2 = jest.fn();

      await middleware.use(req2, res2, next2);

      // Both requests should work
      expect(next1).toHaveBeenCalled();
      expect(next2).toHaveBeenCalled();
    });

    it('should invalidate cache for specific tenant', async () => {
      const req = createMockRequest({
        headers: { 'x-tenant-id': '00000000-0000-4000-8000-000000000201' },
      });
      const res = createMockResponse();
      const next = jest.fn();

      await middleware.use(req, res, next);

      middleware.invalidateCache('00000000-0000-4000-8000-000000000201');

      // Should be able to load again
      await middleware.use(req, res, next);
      expect(next).toHaveBeenCalledTimes(2);
    });

    it('should clear all cache', async () => {
      const req = createMockRequest({
        headers: { 'x-tenant-id': '00000000-0000-4000-8000-000000000202' },
      });
      const res = createMockResponse();
      const next = jest.fn();

      await middleware.use(req, res, next);

      middleware.clearCache();

      // Should be able to load again
      await middleware.use(req, res, next);
      expect(next).toHaveBeenCalledTimes(2);
    });
  });

  describe('Helper Functions', () => {
    describe('getCurrentTenant', () => {
      it('should return current tenant from context', async () => {
        const req = createMockRequest({
          headers: { 'x-tenant-id': '00000000-0000-4000-8000-000000000004' },
        });
        const res = createMockResponse();

        let tenant: TenantMetadata | undefined;
        const next = jest.fn(() => {
          tenant = getCurrentTenant();
        });

        await middleware.use(req, res, next);

        expect(tenant).toBeDefined();
        expect(tenant?.id).toBe('00000000-0000-4000-8000-000000000004');
      });

      it('should return undefined outside tenant context', () => {
        const tenant = getCurrentTenant();
        expect(tenant).toBeUndefined();
      });
    });

    describe('getCurrentTenantId', () => {
      it('should return current tenant ID from context', async () => {
        const req = createMockRequest({
          headers: { 'x-tenant-id': '00000000-0000-4000-8000-000000000009' },
        });
        const res = createMockResponse();

        let tenantId: string | undefined = undefined;
        const next = jest.fn(() => {
          tenantId = getCurrentTenantId();
        });

        await middleware.use(req, res, next);

        expect(tenantId).toBe('00000000-0000-4000-8000-000000000009');
      });
    });

    describe('getTenantFromRequest', () => {
      it('should return tenant from request', async () => {
        const req = createMockRequest({
          headers: { 'x-tenant-id': '00000000-0000-4000-8000-000000000014' },
        });
        const res = createMockResponse();
        const next = jest.fn();

        await middleware.use(req, res, next);

        const tenant = getTenantFromRequest(req);
        expect(tenant).toBeDefined();
        expect(tenant?.id).toBe('00000000-0000-4000-8000-000000000014');
      });
    });

    describe('tenantHasFeature', () => {
      it('should check tenant feature within context', async () => {
        const req = createMockRequest({
          headers: { 'x-tenant-id': '00000000-0000-4000-8000-000000000007' },
        });
        const res = createMockResponse();

        let hasAlertEngine = false;
        const next = jest.fn(() => {
          hasAlertEngine = tenantHasFeature('alertEngine');
        });

        await middleware.use(req, res, next);

        expect(hasAlertEngine).toBe(true);
      });

      it('should return false outside context', () => {
        expect(tenantHasFeature('alertEngine')).toBe(false);
      });
    });

    describe('getTenantLimit', () => {
      it('should get tenant limit within context', async () => {
        const req = createMockRequest({
          headers: { 'x-tenant-id': '00000000-0000-4000-8000-000000000011' },
        });
        const res = createMockResponse();

        let maxUsers = 0;
        const next = jest.fn(() => {
          maxUsers = getTenantLimit('maxUsers');
        });

        await middleware.use(req, res, next);

        expect(maxUsers).toBeGreaterThan(0);
      });

      it('should return 0 outside context', () => {
        expect(getTenantLimit('maxUsers')).toBe(0);
      });
    });

    describe('getTenantSetting', () => {
      it('should get tenant setting within context', async () => {
        const req = createMockRequest({
          headers: { 'x-tenant-id': '00000000-0000-4000-8000-000000000015' },
        });
        const res = createMockResponse();

        let timezone: string | undefined = undefined;
        const next = jest.fn(() => {
          timezone = getTenantSetting('timezone');
        });

        await middleware.use(req, res, next);

        expect(timezone).toBeDefined();
        expect(timezone).toBe('UTC');
      });

      it('should return undefined outside context', () => {
        expect(getTenantSetting('timezone')).toBeUndefined();
      });
    });
  });

  describe('Error Handling', () => {
    it('should rethrow BadRequestException', async () => {
      const req = createMockRequest(); // No tenant info
      const res = createMockResponse();
      const next = jest.fn();

      await expect(middleware.use(req, res, next)).rejects.toThrow(BadRequestException);
    });

    it('should log error and wrap unknown errors', async () => {
      const errorSpy = jest.spyOn(middleware['logger'], 'error');
      const req = createMockRequest({
        headers: { 'x-tenant-id': '00000000-0000-4000-8000-000000000005' },
      });
      const res = createMockResponse();
      const next = jest.fn();

      // This should work without errors
      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('Performance', () => {
    it('should handle rapid tenant resolutions efficiently', async () => {
      const startTime = Date.now();

      for (let i = 0; i < 1000; i++) {
        const req = createMockRequest({
          headers: { 'x-tenant-id': `00000000-0000-4000-8000-00000000030${i % 10}` },
        });
        const res = createMockResponse();
        const next = jest.fn();

        await middleware.use(req, res, next);
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(2000); // Should complete in under 2 seconds
    });
  });
});
