 
 
 
 
 
 
 
 
 
 
 

/**
 * TenantContextInterceptor Tests
 *
 * Comprehensive test suite for tenant context management interceptor
 */

import { CallHandler, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Request, Response } from 'express';
import { of } from 'rxjs';

import {
  TenantContextInterceptor,
  TenantContext,
  TenantAwareRequest,
  tenantContextStorage,
  getCurrentTenantContext,
  getCurrentTenantId,
  hasTenantFeature,
  getTenantLimit,
  getTenantContextFromRequest,
  getTenantIdFromRequest,
  runWithTenantContext,
} from '../tenant-context.interceptor';


describe('TenantContextInterceptor', () => {
  let interceptor: TenantContextInterceptor;

  /**
   * Create mock HTTP execution context
   */
  const createMockExecutionContext = (
    options: {
      headers?: Record<string, string>;
      path?: string;
      method?: string;
      query?: Record<string, string>;
      params?: Record<string, string>;
      user?: Record<string, unknown>;
    } = {},
  ): ExecutionContext => {
    // The interceptor reads `request.user` via an explicit
    // intersection cast at tenant-context.interceptor.ts:190 — the
    // `user` field is intentionally NOT on `TenantAwareRequest` to
    // keep the auth concern separate from the tenant concern. The
    // test fixture mirrors that intersection so the `user` property
    // is recognised at the type level without polluting the
    // production interface.
    const mockRequest: Partial<TenantAwareRequest> & { user?: Record<string, unknown> } = {
      headers: {
        host: 'api.example.com',
        ...options.headers,
      },
      path: options.path || '/api/v1/test',
      method: options.method || 'GET',
      url: options.path || '/api/v1/test',
      query: options.query || {},
      params: options.params || {},
      user: options.user,
    };

    const mockResponse: Partial<Response> = {
      setHeader: jest.fn(),
    };

    return {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
        getResponse: () => mockResponse,
      }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
      getType: () => 'http',
    } as unknown as ExecutionContext;
  };

  /**
   * Create mock GraphQL execution context
   * Note: Reserved for future GraphQL tests
   */
  const _createMockGraphQLContext = (
    options: {
      headers?: Record<string, string>;
      path?: string;
      user?: Record<string, unknown>;
    } = {},
  ): ExecutionContext => {
    // The interceptor reads `request.user` via an explicit
    // intersection cast at tenant-context.interceptor.ts:190 — the
    // `user` field is intentionally NOT on `TenantAwareRequest` to
    // keep the auth concern separate from the tenant concern. The
    // test fixture mirrors that intersection so the `user` property
    // is recognised at the type level without polluting the
    // production interface.
    const mockRequest: Partial<TenantAwareRequest> & { user?: Record<string, unknown> } = {
      headers: {
        host: 'api.example.com',
        ...options.headers,
      },
      path: options.path || '/graphql',
      method: 'POST',
      url: options.path || '/graphql',
      query: {},
      params: {},
      user: options.user,
    };

    const mockResponse: Partial<Response> = {
      setHeader: jest.fn(),
    };

    return {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
        getResponse: () => mockResponse,
      }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
      getType: () => 'graphql',
      getArgs: () => [{}, {}, { req: mockRequest, res: mockResponse }, {}],
    } as unknown as ExecutionContext;
  };

  /**
   * Create mock call handler
   */
  const createMockCallHandler = (response: unknown = {}): CallHandler => ({
    handle: () => of(response),
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TenantContextInterceptor],
    }).compile();

    interceptor = module.get<TenantContextInterceptor>(TenantContextInterceptor);
  });

  afterEach(() => {
    // Clear any cached tenant contexts
    interceptor.clearCache();
  });

  describe('Tenant ID Extraction', () => {
    it('should extract tenant ID from x-tenant-id header', (done) => {
      const context = createMockExecutionContext({
        headers: { 'x-tenant-id': 'tenant-123' },
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          const request = context.switchToHttp().getRequest();
          expect(request.tenantId).toBe('tenant-123');
          done();
        },
        error: done.fail,
      });
    });

    it('should extract tenant ID from JWT user payload (tenantId)', (done) => {
      const context = createMockExecutionContext({
        user: { sub: 'user-1', tenantId: 'jwt-tenant-456' },
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          const request = context.switchToHttp().getRequest();
          expect(request.tenantId).toBe('jwt-tenant-456');
          done();
        },
        error: done.fail,
      });
    });

    it('should extract tenant ID from JWT user payload (tenant_id)', (done) => {
      const context = createMockExecutionContext({
        user: { sub: 'user-1', tenant_id: 'jwt-tenant-789' },
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          const request = context.switchToHttp().getRequest();
          expect(request.tenantId).toBe('jwt-tenant-789');
          done();
        },
        error: done.fail,
      });
    });

    it('should extract tenant ID from JWT user payload (organizationId)', (done) => {
      const context = createMockExecutionContext({
        user: { sub: 'user-1', organizationId: 'org-123' },
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          const request = context.switchToHttp().getRequest();
          expect(request.tenantId).toBe('org-123');
          done();
        },
        error: done.fail,
      });
    });

    it('should IGNORE the query parameter (removed tenant source)', () => {
      // WHY inverted contract: ?tenantId= was removed as a resolution source
      // (query strings leak via logs/referrers and are trivially spoofable).
      // A request carrying ONLY a query tenant must fail tenant resolution.
      const context = createMockExecutionContext({
        query: { tenantId: 'query-tenant-111' },
      });
      const handler = createMockCallHandler();

      expect(() => interceptor.intercept(context, handler)).toThrow(UnauthorizedException);
    });

    it('should extract tenant ID from path parameter', (done) => {
      const context = createMockExecutionContext({
        params: { tenantId: 'path-tenant-222' },
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          const request = context.switchToHttp().getRequest();
          expect(request.tenantId).toBe('path-tenant-222');
          done();
        },
        error: done.fail,
      });
    });

    it('should extract tenant ID from subdomain', (done) => {
      const context = createMockExecutionContext({
        headers: { host: 'acme.example.com' },
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          const request = context.switchToHttp().getRequest();
          expect(request.tenantId).toBe('acme');
          done();
        },
        error: done.fail,
      });
    });

    it('should not extract www as tenant from subdomain', (done) => {
      const context = createMockExecutionContext({
        headers: { host: 'www.example.com' },
        path: '/health',
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          done();
        },
        error: done.fail,
      });
    });

    it('should not extract api as tenant from subdomain', (done) => {
      const context = createMockExecutionContext({
        headers: { host: 'api.example.com' },
        path: '/health',
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          done();
        },
        error: done.fail,
      });
    });

    it('should prioritize the JWT claim over header and query sources', (done) => {
      // WHY: the JWT tenantId is the cryptographically-verified trust anchor —
      // a spoofable x-tenant-id header must NEVER override it for
      // authenticated requests (CLAUDE.md tenant-ID sourcing).
      const context = createMockExecutionContext({
        headers: { 'x-tenant-id': 'header-tenant' },
        user: { sub: 'user-1', tenantId: 'jwt-tenant' },
        query: { tenantId: 'query-tenant' },
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          const request = context.switchToHttp().getRequest();
          expect(request.tenantId).toBe('jwt-tenant');
          done();
        },
        error: done.fail,
      });
    });
  });

  describe('Public Endpoints', () => {
    it.each([
      '/health',
      '/ready',
      '/live',
      '/metrics',
      '/api/v1/auth/login',
      '/api/v1/auth/forgot-password',
      '/api/v1/auth/reset-password',
      '/api/v1/public',
      '/api/v1/public/docs',
    ])('should allow public endpoint %s without tenant', (path, done) => {
      const context = createMockExecutionContext({
        path,
        headers: { host: 'api.example.com' },
      });
      const handler = createMockCallHandler({ status: 'ok' });

      interceptor.intercept(context, handler).subscribe({
        next: (result) => {
          expect(result).toEqual({ status: 'ok' });
          (done)();
        },
        error: (done).fail,
      });
    });
  });

  describe('Tenant Required', () => {
    it('should throw UnauthorizedException when tenant is required but not found', (done) => {
      const context = createMockExecutionContext({
        path: '/api/v1/farms',
        headers: { host: 'api.example.com' },
      });
      const handler = createMockCallHandler();

      // WHY sync throw: the interceptor rejects BEFORE building the
      // observable pipeline — missing tenant context never reaches the
      // handler, so the contract is a synchronous UnauthorizedException.
      expect(() => interceptor.intercept(context, handler)).toThrow(UnauthorizedException);
      expect(() => interceptor.intercept(context, handler)).toThrow('Tenant context is required');
      done();
    });
  });

  describe('Tenant Context Creation', () => {
    it('should create tenant context with default features', (done) => {
      const context = createMockExecutionContext({
        headers: { 'x-tenant-id': 'tenant-features' },
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          const request = context.switchToHttp().getRequest();
          expect(request.tenantContext).toBeDefined();
          expect(request.tenantContext?.features?.alertsEnabled).toBe(true);
          expect(request.tenantContext?.features?.reportsEnabled).toBe(true);
          expect(request.tenantContext?.features?.apiAccessEnabled).toBe(true);
          done();
        },
        error: done.fail,
      });
    });

    it('should default to the conservative FREE plan limits when no subscription tier is present', (done) => {
      // No JWT → no subscriptionTier → the interceptor resolves the FREE tier
      // from the canonical PLAN_CATALOG SSoT (ADR-037). Previously this object
      // was a hardcoded "professional-ish" default (500 sensors) that never
      // tracked the tenant's actual plan — a latent over-grant.
      const context = createMockExecutionContext({
        headers: { 'x-tenant-id': 'tenant-limits' },
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          const request = context.switchToHttp().getRequest();
          expect(request.tenantContext?.limits?.maxFarms).toBe(1);
          expect(request.tenantContext?.limits?.maxPonds).toBe(5);
          expect(request.tenantContext?.limits?.maxSensors).toBe(10);
          expect(request.tenantContext?.limits?.maxUsers).toBe(3);
          done();
        },
        error: done.fail,
      });
    });

    it('should derive limits from the JWT subscription tier (PLAN_CATALOG SSoT)', (done) => {
      // A professional tenant gets the professional limits from the SSoT —
      // the limits now follow the plan instead of a fixed default.
      const context = createMockExecutionContext({
        headers: { 'x-tenant-id': 'tenant-pro' },
        user: { sub: 'user-1', subscription_tier: 'professional' },
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          const request = context.switchToHttp().getRequest();
          expect(request.tenantContext?.limits?.maxFarms).toBe(10);
          expect(request.tenantContext?.limits?.maxPonds).toBe(100);
          expect(request.tenantContext?.limits?.maxSensors).toBe(100);
          expect(request.tenantContext?.limits?.maxUsers).toBe(25);
          done();
        },
        error: done.fail,
      });
    });

    it('should override features from JWT claims', (done) => {
      const context = createMockExecutionContext({
        headers: { 'x-tenant-id': 'tenant-jwt' },
        user: {
          sub: 'user-1',
          tenant_name: 'Acme Corp',
          subscription_tier: 'enterprise',
          features: {
            advancedAnalyticsEnabled: true,
            multiSiteEnabled: true,
          },
        },
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          const request = context.switchToHttp().getRequest();
          expect(request.tenantContext?.tenantName).toBe('Acme Corp');
          expect(request.tenantContext?.subscriptionTier).toBe('enterprise');
          expect(request.tenantContext?.features?.advancedAnalyticsEnabled).toBe(true);
          expect(request.tenantContext?.features?.multiSiteEnabled).toBe(true);
          done();
        },
        error: done.fail,
      });
    });

    it('should override limits from JWT claims', (done) => {
      const context = createMockExecutionContext({
        headers: { 'x-tenant-id': 'tenant-custom-limits' },
        user: {
          sub: 'user-1',
          limits: {
            maxFarms: 100,
            maxApiRequestsPerHour: 100000,
          },
        },
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          const request = context.switchToHttp().getRequest();
          expect(request.tenantContext?.limits?.maxFarms).toBe(100);
          expect(request.tenantContext?.limits?.maxApiRequestsPerHour).toBe(100000);
          done();
        },
        error: done.fail,
      });
    });

    it('should set tenant context as active', (done) => {
      const context = createMockExecutionContext({
        headers: { 'x-tenant-id': 'active-tenant' },
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          const request = context.switchToHttp().getRequest();
          expect(request.tenantContext?.isActive).toBe(true);
          done();
        },
        error: done.fail,
      });
    });
  });

  describe('Response Headers', () => {
    it('should set X-Tenant-ID response header', (done) => {
      const context = createMockExecutionContext({
        headers: { 'x-tenant-id': 'response-header-tenant' },
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          const response = context.switchToHttp().getResponse();
          expect(response.setHeader).toHaveBeenCalledWith('X-Tenant-ID', 'response-header-tenant');
          done();
        },
        error: done.fail,
      });
    });
  });

  describe('Cache Behavior', () => {
    it('should cache tenant context', (done) => {
      const context1 = createMockExecutionContext({
        headers: { 'x-tenant-id': 'cached-tenant' },
      });
      const context2 = createMockExecutionContext({
        headers: { 'x-tenant-id': 'cached-tenant' },
      });
      const handler = createMockCallHandler();

      let firstContext: TenantContext | undefined;

      interceptor.intercept(context1, handler).subscribe({
        next: () => {
          const request1 = context1.switchToHttp().getRequest();
          firstContext = request1.tenantContext;

          interceptor.intercept(context2, handler).subscribe({
            next: () => {
              const request2 = context2.switchToHttp().getRequest();
              expect(request2.tenantContext).toBe(firstContext);
              done();
            },
            error: done.fail,
          });
        },
        error: done.fail,
      });
    });

    it('should invalidate tenant cache', (done) => {
      const context = createMockExecutionContext({
        headers: { 'x-tenant-id': 'invalidate-tenant' },
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          const request1 = context.switchToHttp().getRequest();
          const firstContext = request1.tenantContext;

          // Invalidate cache
          interceptor.invalidateTenantCache('invalidate-tenant');

          // Create new context
          const context2 = createMockExecutionContext({
            headers: { 'x-tenant-id': 'invalidate-tenant' },
          });

          interceptor.intercept(context2, handler).subscribe({
            next: () => {
              const request2 = context2.switchToHttp().getRequest();
              // Should be a new context object (not the same reference)
              expect(request2.tenantContext).not.toBe(firstContext);
              done();
            },
            error: done.fail,
          });
        },
        error: done.fail,
      });
    });

    it('should clear all cache', (done) => {
      const context1 = createMockExecutionContext({
        headers: { 'x-tenant-id': 'clear-tenant-1' },
      });
      const context2 = createMockExecutionContext({
        headers: { 'x-tenant-id': 'clear-tenant-2' },
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context1, handler).subscribe({
        next: () => {
          interceptor.intercept(context2, handler).subscribe({
            next: () => {
              // Clear all cache
              interceptor.clearCache();

              // Should create new contexts after clear
              const context3 = createMockExecutionContext({
                headers: { 'x-tenant-id': 'clear-tenant-1' },
              });

              interceptor.intercept(context3, handler).subscribe({
                next: () => {
                  const request1 = context1.switchToHttp().getRequest();
                  const request3 = context3.switchToHttp().getRequest();
                  // Should be different objects
                  expect(request3.tenantContext).not.toBe(request1.tenantContext);
                  done();
                },
                error: done.fail,
              });
            },
            error: done.fail,
          });
        },
        error: done.fail,
      });
    });
  });

  describe('AsyncLocalStorage Context', () => {
    it('should provide tenant context via AsyncLocalStorage', (done) => {
      const context = createMockExecutionContext({
        headers: { 'x-tenant-id': 'async-tenant-123' },
      });

      const handler: CallHandler = {
        handle: () => {
          // Inside the handler, we should have access to the tenant context
          const tenantContext = tenantContextStorage.getStore();
          expect(tenantContext).toBeDefined();
          expect(tenantContext?.tenantId).toBe('async-tenant-123');
          return of({ checked: true });
        },
      };

      interceptor.intercept(context, handler).subscribe({
        next: (result) => {
          expect(result).toEqual({ checked: true });
          done();
        },
        error: done.fail,
      });
    });
  });

  describe('Helper Functions', () => {
    describe('getCurrentTenantContext', () => {
      it('should return undefined outside of tenant context', () => {
        const context = getCurrentTenantContext();
        expect(context).toBeUndefined();
      });

      it('should return context inside runWithTenantContext', () => {
        const testContext: TenantContext = {
          tenantId: 'helper-test',
          isActive: true,
        };

        runWithTenantContext(testContext, () => {
          const context = getCurrentTenantContext();
          expect(context).toBe(testContext);
        });
      });
    });

    describe('getCurrentTenantId', () => {
      it('should return undefined outside of tenant context', () => {
        const id = getCurrentTenantId();
        expect(id).toBeUndefined();
      });

      it('should return tenant ID inside runWithTenantContext', () => {
        const testContext: TenantContext = {
          tenantId: 'id-test-tenant',
          isActive: true,
        };

        runWithTenantContext(testContext, () => {
          const id = getCurrentTenantId();
          expect(id).toBe('id-test-tenant');
        });
      });
    });

    describe('hasTenantFeature', () => {
      it('should return false outside of tenant context', () => {
        const hasFeature = hasTenantFeature('alertsEnabled');
        expect(hasFeature).toBe(false);
      });

      it('should return correct feature status', () => {
        const testContext: TenantContext = {
          tenantId: 'feature-test',
          isActive: true,
          features: {
            alertsEnabled: true,
            advancedAnalyticsEnabled: false,
          },
        };

        runWithTenantContext(testContext, () => {
          expect(hasTenantFeature('alertsEnabled')).toBe(true);
          expect(hasTenantFeature('advancedAnalyticsEnabled')).toBe(false);
          expect(hasTenantFeature('multiSiteEnabled')).toBe(false);
        });
      });
    });

    describe('getTenantLimit', () => {
      it('should return undefined outside of tenant context', () => {
        const limit = getTenantLimit('maxFarms');
        expect(limit).toBeUndefined();
      });

      it('should return correct limit value', () => {
        const testContext: TenantContext = {
          tenantId: 'limit-test',
          isActive: true,
          limits: {
            maxFarms: 50,
            maxUsers: 100,
          },
        };

        runWithTenantContext(testContext, () => {
          expect(getTenantLimit('maxFarms')).toBe(50);
          expect(getTenantLimit('maxUsers')).toBe(100);
          expect(getTenantLimit('maxSensors')).toBeUndefined();
        });
      });
    });

    describe('getTenantContextFromRequest', () => {
      it('should return tenant context from request', () => {
        const testContext: TenantContext = {
          tenantId: 'request-test',
          isActive: true,
        };

        const mockRequest = {
          tenantContext: testContext,
        } as unknown as Request;

        const context = getTenantContextFromRequest(mockRequest);
        expect(context).toBe(testContext);
      });

      it('should return undefined when no context attached', () => {
        const mockRequest = {} as Request;
        const context = getTenantContextFromRequest(mockRequest);
        expect(context).toBeUndefined();
      });
    });

    describe('getTenantIdFromRequest', () => {
      it('should return tenant ID from request', () => {
        const mockRequest = {
          tenantId: 'request-id-test',
        } as unknown as Request;

        const id = getTenantIdFromRequest(mockRequest);
        expect(id).toBe('request-id-test');
      });

      it('should return undefined when no tenant ID attached', () => {
        const mockRequest = {} as Request;
        const id = getTenantIdFromRequest(mockRequest);
        expect(id).toBeUndefined();
      });
    });

    describe('runWithTenantContext', () => {
      it('should execute function within tenant context', () => {
        const testContext: TenantContext = {
          tenantId: 'run-context-test',
          isActive: true,
        };

        const result = runWithTenantContext(testContext, () => {
          const current = getCurrentTenantContext();
          return current?.tenantId;
        });

        expect(result).toBe('run-context-test');
      });

      it('should isolate nested contexts', () => {
        const outerContext: TenantContext = {
          tenantId: 'outer-tenant',
          isActive: true,
        };

        const innerContext: TenantContext = {
          tenantId: 'inner-tenant',
          isActive: true,
        };

        runWithTenantContext(outerContext, () => {
          expect(getCurrentTenantId()).toBe('outer-tenant');

          runWithTenantContext(innerContext, () => {
            expect(getCurrentTenantId()).toBe('inner-tenant');
          });

          // After inner context ends, should restore outer
          expect(getCurrentTenantId()).toBe('outer-tenant');
        });
      });
    });
  });

  describe('GraphQL Support', () => {
    it('should handle GraphQL context type', (done) => {
      // Note: GraphQL context handling requires GqlExecutionContext which we can't fully mock
      // This test verifies the context type detection
      const context = createMockExecutionContext({
        headers: { 'x-tenant-id': 'graphql-tenant' },
        path: '/graphql',
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          const request = context.switchToHttp().getRequest();
          expect(request.tenantId).toBe('graphql-tenant');
          done();
        },
        error: done.fail,
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty headers', (done) => {
      const context = createMockExecutionContext({
        path: '/health',
        headers: {},
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          done();
        },
        error: done.fail,
      });
    });

    it('should handle missing host header', (done) => {
      // The interceptor reads `request.user` via an explicit
    // intersection cast at tenant-context.interceptor.ts:190 — the
    // `user` field is intentionally NOT on `TenantAwareRequest` to
    // keep the auth concern separate from the tenant concern. The
    // test fixture mirrors that intersection so the `user` property
    // is recognised at the type level without polluting the
    // production interface.
    const mockRequest: Partial<TenantAwareRequest> & { user?: Record<string, unknown> } = {
        headers: { 'x-tenant-id': 'no-host-tenant' },
        path: '/api/v1/test',
        method: 'GET',
        url: '/api/v1/test',
        query: {},
        params: {},
      };

      const mockResponse: Partial<Response> = {
        setHeader: jest.fn(),
      };

      const context = {
        switchToHttp: () => ({
          getRequest: () => mockRequest,
          getResponse: () => mockResponse,
        }),
        getHandler: () => jest.fn(),
        getClass: () => jest.fn(),
        getType: () => 'http',
      } as unknown as ExecutionContext;

      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          expect((mockRequest as TenantAwareRequest).tenantId).toBe('no-host-tenant');
          done();
        },
        error: done.fail,
      });
    });

    it('should handle response without setHeader method', (done) => {
      // The interceptor reads `request.user` via an explicit
    // intersection cast at tenant-context.interceptor.ts:190 — the
    // `user` field is intentionally NOT on `TenantAwareRequest` to
    // keep the auth concern separate from the tenant concern. The
    // test fixture mirrors that intersection so the `user` property
    // is recognised at the type level without polluting the
    // production interface.
    const mockRequest: Partial<TenantAwareRequest> & { user?: Record<string, unknown> } = {
        headers: { 'x-tenant-id': 'no-setheader-tenant' },
        path: '/api/v1/test',
        method: 'GET',
        url: '/api/v1/test',
        query: {},
        params: {},
      };

      const mockResponse = {};

      const context = {
        switchToHttp: () => ({
          getRequest: () => mockRequest,
          getResponse: () => mockResponse,
        }),
        getHandler: () => jest.fn(),
        getClass: () => jest.fn(),
        getType: () => 'http',
      } as unknown as ExecutionContext;

      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          // Should not throw even without setHeader
          expect((mockRequest as TenantAwareRequest).tenantId).toBe('no-setheader-tenant');
          done();
        },
        error: done.fail,
      });
    });

    it('should handle subdomain with only two parts', (done) => {
      const context = createMockExecutionContext({
        headers: { host: 'example.com', 'x-tenant-id': 'two-part-host' },
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          const request = context.switchToHttp().getRequest();
          expect(request.tenantId).toBe('two-part-host');
          done();
        },
        error: done.fail,
      });
    });
  });
});
