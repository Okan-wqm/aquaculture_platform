 
 
 
 
 
 
 
 
 
 
 

/**
 * OpaPolicyGuard Tests
 *
 * Comprehensive test suite for OPA policy evaluation guard
 */

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import { OpaPolicyGuard, OPA_POLICY_KEY, BYPASS_OPA_KEY } from '../opa-policy.guard';

describe('OpaPolicyGuard', () => {
  let guard: OpaPolicyGuard;
  let reflector: Reflector;

  const createMockExecutionContext = (
    user: Record<string, unknown> = {},
    path = '/api/v1/test',
    method = 'GET',
    headers: Record<string, string> = {},
  ): ExecutionContext => {
    const mockRequest = {
      user,
      path,
      // WHY url too: buildOpaInput reads request.url for context.path.
      url: path,
      method,
      headers,
      params: {},
      query: {},
      body: {},
    };

    return {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
      }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
      getType: () => 'http',
      // WHY: the guard routes through GqlExecutionContext.create(), which
      // reads context.getArgs() even for http-typed contexts.
      getArgs: () => [mockRequest, {}, {}, {}],
    } as unknown as ExecutionContext;
  };

  /**
   * Interface for OPA input
   */
  interface OpaInput {
    input: {
      context: {
        path: string;
        method: string;
      };
      user?: Record<string, unknown>;
    };
  }

  /**
   * Interface for fetch request options
   */
  interface FetchRequestOptions {
    method: string;
    body: string;
    headers?: Record<string, string>;
  }

  const mockOpaResponse = (allow: boolean, reason?: string): { result: { allow: boolean; reason?: string } } => ({
    result: {
      allow,
      reason,
    },
  });

  /**
   * Helper to get the fetch request body as parsed JSON
   */
  const getFetchRequestBody = (): OpaInput => {
    const mockFetch = global.fetch as jest.Mock;
    const calls = mockFetch.mock.calls as [string, FetchRequestOptions][];
    const bodyString = calls[0]?.[1]?.body ?? '{}';
    return JSON.parse(bodyString) as OpaInput;
  };

  beforeEach(async () => {
    // Mock global fetch
    global.fetch = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpaPolicyGuard,
        {
          provide: Reflector,
          useValue: {
            // WHY keyed default: the guard only evaluates OPA when the
            // handler carries an @OpaPolicy() config — without it,
            // non-production short-circuits to allow. Every evaluation test
            // therefore needs a policy on the handler; bypass/no-policy
            // tests override this mock explicitly.
            getAllAndOverride: jest.fn((key: unknown) =>
              key === OPA_POLICY_KEY ? { policy: 'aquaculture/authz/api' } : null,
            ),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => {
              const config: Record<string, unknown> = {
                OPA_URL: 'http://localhost:8181',
                OPA_ENABLED: true,
                OPA_TIMEOUT: 5000,
                OPA_FAIL_OPEN: false,
                OPA_CACHE_TTL: 60000,
              };
              return config[key] ?? defaultValue;
            }),
          },
        },
      ],
    }).compile();

    guard = module.get<OpaPolicyGuard>(OpaPolicyGuard);
    reflector = module.get<Reflector>(Reflector);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('OPA Policy Evaluation', () => {
    it('should allow when policy returns allow: true', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOpaResponse(true)),
      });

      const context = createMockExecutionContext({ sub: 'user-1', tenantId: 'tenant-1' });
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should deny when policy returns allow: false', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOpaResponse(false, 'Access denied by policy')),
      });

      const context = createMockExecutionContext({ sub: 'user-1', tenantId: 'tenant-1' });
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should return 403 on policy deny', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOpaResponse(false)),
      });

      const context = createMockExecutionContext({ sub: 'user-1' });
      try {
        await guard.canActivate(context);
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenException);
      }
    });
  });

  describe('OPA Connection Failure', () => {
    it('should handle OPA connection failure with fail-close', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Connection refused'));

      const context = createMockExecutionContext({ sub: 'user-1' });
      await expect(guard.canActivate(context)).rejects.toThrow();
    });

    it('should handle OPA timeout', async () => {
      (global.fetch as jest.Mock).mockImplementation(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 100)),
      );

      const context = createMockExecutionContext({ sub: 'user-1' });
      await expect(guard.canActivate(context)).rejects.toThrow();
    });

    it('should handle OPA HTTP error', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const context = createMockExecutionContext({ sub: 'user-1' });
      await expect(guard.canActivate(context)).rejects.toThrow();
    });
  });

  describe('Policy Decision Caching', () => {
    it('should cache policy decisions', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOpaResponse(true)),
      });

      const context = createMockExecutionContext({ sub: 'user-1', tenantId: 'tenant-1' });

      // First call
      await guard.canActivate(context);
      // Second call
      await guard.canActivate(context);

      // Should only call OPA once due to caching
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should respect cache TTL', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOpaResponse(true)),
      });

      const context = createMockExecutionContext({ sub: 'user-1' });
      await guard.canActivate(context);

      // Simulate cache expiry by clearing
      guard['decisionCache']?.clear();

      await guard.canActivate(context);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('Policy Input Context', () => {
    it('should send correct input context to OPA', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOpaResponse(true)),
      });

      const user = { sub: 'user-123', tenantId: 'tenant-456', roles: ['admin'] };
      const context = createMockExecutionContext(user, '/api/v1/users', 'POST');
      await guard.canActivate(context);

      const mockFetch = global.fetch as jest.Mock;
      expect(mockFetch).toHaveBeenCalled();
      const [url, options] = mockFetch.mock.calls[0] as [string, FetchRequestOptions];
      expect(url).toContain('http://localhost:8181');
      expect(options.method).toBe('POST');
      expect(options.body).toContain('user-123');
    });

    it('should include request path in input', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOpaResponse(true)),
      });

      const context = createMockExecutionContext({}, '/api/v1/sensitive');
      await guard.canActivate(context);

      const callBody = getFetchRequestBody();
      expect(callBody.input.context.path).toBe('/api/v1/sensitive');
    });

    it('should include request method in input', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOpaResponse(true)),
      });

      const context = createMockExecutionContext({}, '/api', 'DELETE');
      await guard.canActivate(context);

      const callBody = getFetchRequestBody();
      expect(callBody.input.context.method).toBe('DELETE');
    });
  });

  describe('Multiple Policy Evaluation', () => {
    it('should evaluate multiple policies with AND logic', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['policy1', 'policy2']);

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockOpaResponse(true)),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockOpaResponse(true)),
        });

      const context = createMockExecutionContext({ sub: 'user-1' });
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should deny if any policy denies (AND logic)', async () => {
      // WHY keyed mock: a blanket mockReturnValue answers the BYPASS key
      // with a truthy array too — short-circuiting the guard to allow
      // before any policy evaluates.
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) =>
        key === OPA_POLICY_KEY ? ['policy1', 'policy2'] : null,
      );

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockOpaResponse(true)),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockOpaResponse(false)),
        });

      const context = createMockExecutionContext({ sub: 'user-1' });
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('Policy Timeout Handling', () => {
    it('should timeout after configured duration', async () => {
      jest.useFakeTimers();
      // WHY signal-respecting mock: the guard enforces its timeout via
      // AbortController — a mock that ignores opts.signal can never observe
      // the abort, so the test would hang on real timers instead.
      (global.fetch as jest.Mock).mockImplementation(
        (_url: string, opts: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal?.addEventListener('abort', () =>
              reject(new Error('This operation was aborted')),
            );
          }),
      );

      const context = createMockExecutionContext({ sub: 'user-1' });

      // Should timeout at the configured 5s budget
      const promise = guard.canActivate(context);
      const assertion = expect(promise).rejects.toThrow();
      await jest.advanceTimersByTimeAsync(6000);
      await assertion;

      jest.useRealTimers();
    });
  });

  describe('Skip OPA Decorator', () => {
    it('should skip OPA check when @SkipOpa decorator is present', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === BYPASS_OPA_KEY) return true;
        return null;
      });

      const context = createMockExecutionContext({});
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('Policy Decision Audit Logging', () => {
    it('should stay QUIET on allowed decisions (log-noise control)', async () => {
      // WHY inverted contract: allowed decisions are the steady state — the
      // guard logs denials (warn) and cache events only; per-request allow
      // logging would flood production logs.
      const warnSpy = jest.spyOn(guard['logger'], 'warn');

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOpaResponse(true)),
      });

      const context = createMockExecutionContext({ sub: 'user-1' });
      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should log policy denials as warnings', async () => {
      const warnSpy = jest.spyOn(guard['logger'], 'warn');

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOpaResponse(false, 'Denied')),
      });

      const context = createMockExecutionContext({ sub: 'user-1' });
      try {
        await guard.canActivate(context);
      } catch {
        // Expected
      }

      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('Complex Policy Evaluation', () => {
    it('should handle nested condition results', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            result: {
              allow: true,
              conditions: {
                role_check: true,
                tenant_check: true,
                resource_check: true,
              },
            },
          }),
      });

      const context = createMockExecutionContext({ sub: 'user-1', roles: ['admin'] });
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should handle policy with obligations', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            result: {
              allow: true,
              obligations: [{ type: 'log', action: 'audit_access' }],
            },
          }),
      });

      const context = createMockExecutionContext({ sub: 'user-1' });
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('Data-driven Policy Evaluation', () => {
    it('should evaluate policy with external data', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOpaResponse(true)),
      });

      const context = createMockExecutionContext({
        sub: 'user-1',
        attributes: { department: 'engineering' },
      });
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed OPA response with policy configured', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === OPA_POLICY_KEY) {
          return { policy: 'authz/allow', rule: 'allow' };
        }
        return null;
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ invalid: 'response' }),
      });

      const context = createMockExecutionContext({ sub: 'user-1' });
      await expect(guard.canActivate(context)).rejects.toThrow();
    });

    it('should handle OPA response without result field with policy configured', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === OPA_POLICY_KEY) {
          return { policy: 'authz/allow', rule: 'allow' };
        }
        return null;
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const context = createMockExecutionContext({ sub: 'user-1' });
      await expect(guard.canActivate(context)).rejects.toThrow();
    });
  });

  describe('Performance', () => {
    it('should handle concurrent policy evaluations', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOpaResponse(true)),
      });

      const contexts = Array.from({ length: 100 }, (_, i) =>
        createMockExecutionContext({ sub: `user-${i}` }),
      );

      const results = await Promise.all(contexts.map((ctx) => guard.canActivate(ctx)));
      expect(results.every((r) => r === true)).toBe(true);
    });
  });
});
