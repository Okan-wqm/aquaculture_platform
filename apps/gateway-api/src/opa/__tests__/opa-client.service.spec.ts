/**
 * OPA Client Service Tests
 *
 * Comprehensive test suite for OPA (Open Policy Agent) client service
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  OpaClientService,
  OpaResult,
  OpaHealthStatus,
} from '../opa-client.service';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('OpaClientService', () => {
  let service: OpaClientService;
  let configService: ConfigService;

  const defaultConfig = {
    OPA_URL: 'http://localhost:8181',
    OPA_TIMEOUT: 5000,
    OPA_RETRY_ATTEMPTS: 3,
    OPA_RETRY_DELAY: 100,
    OPA_CIRCUIT_THRESHOLD: 5,
    OPA_CIRCUIT_RESET: 30000,
    OPA_ENABLE_METRICS: true,
    OPA_ENABLE_DECISION_LOGS: false,
    OPA_CACHE_TTL: 60000,
  };

  const createMockResponse = (data: unknown, status = 200): Response => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: jest.fn().mockResolvedValue(data),
    headers: new Headers(),
    redirected: false,
    type: 'basic',
    url: '',
    clone: jest.fn(),
    body: null,
    bodyUsed: false,
    arrayBuffer: jest.fn(),
    blob: jest.fn(),
    formData: jest.fn(),
    text: jest.fn(),
  } as Response);

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Default successful health check response
    mockFetch.mockResolvedValue(createMockResponse({ result: true }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpaClientService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => {
              return defaultConfig[key as keyof typeof defaultConfig] ?? defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<OpaClientService>(OpaClientService);
    configService = module.get<ConfigService>(ConfigService);

    // Initialize the service
    await service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  describe('Module Lifecycle', () => {
    it('should initialize and check health on module init', async () => {
      expect(mockFetch).toHaveBeenCalled();
    });

    it('should cleanup interval on module destroy', () => {
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
      service.onModuleDestroy();
      expect(clearIntervalSpy).toHaveBeenCalled();
    });
  });

  describe('Policy Evaluation', () => {
    it('should evaluate a policy successfully', async () => {
      const mockResult: OpaResult = {
        result: { allow: true },
        decision_id: 'decision-123',
      };

      mockFetch.mockResolvedValueOnce(createMockResponse(mockResult));

      const result = await service.evaluatePolicy('authz/allow', {
        user: 'test-user',
        action: 'read',
      });

      expect(result.result).toEqual({ allow: true });
      expect(result.decision_id).toBe('decision-123');
    });

    it('should include input in request body', async () => {
      const mockResult: OpaResult = { result: true };
      mockFetch.mockResolvedValueOnce(createMockResponse(mockResult));

      const input = { user: 'test-user', resource: 'farms' };
      await service.evaluatePolicy('authz/allow', input);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8181/v1/data/authz/allow',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ input }),
        }),
      );
    });

    it('should cache policy decisions', async () => {
      const mockResult: OpaResult = { result: true };
      mockFetch.mockResolvedValueOnce(createMockResponse(mockResult));

      const input = { user: 'cached-user', action: 'read' };

      // First call - should fetch
      await service.evaluatePolicy('authz/cache-test', input);
      const fetchCallCount = mockFetch.mock.calls.length;

      // Second call with same input - should use cache
      await service.evaluatePolicy('authz/cache-test', input);
      expect(mockFetch).toHaveBeenCalledTimes(fetchCallCount);
    });

    it('should bypass cache when useCache is false', async () => {
      const mockResult: OpaResult = { result: true };
      mockFetch.mockResolvedValue(createMockResponse(mockResult));

      const input = { user: 'no-cache-user' };

      await service.evaluatePolicy('authz/no-cache', input);
      const callCount1 = mockFetch.mock.calls.length;

      await service.evaluatePolicy('authz/no-cache', input, { useCache: false });
      expect(mockFetch.mock.calls.length).toBeGreaterThan(callCount1);
    });

    it('should use custom cache key when provided', async () => {
      const mockResult: OpaResult = { result: true };
      mockFetch.mockResolvedValue(createMockResponse(mockResult));

      await service.evaluatePolicy(
        'authz/custom-key',
        { user: 'test' },
        { cacheKey: 'custom-key-1' },
      );
      const callCount = mockFetch.mock.calls.length;

      // Same custom key should use cache
      await service.evaluatePolicy(
        'authz/custom-key',
        { user: 'different' },
        { cacheKey: 'custom-key-1' },
      );
      expect(mockFetch).toHaveBeenCalledTimes(callCount);
    });

    it('should emit decision event when decision logs enabled', async () => {
      // Create service with decision logs enabled
      const moduleWithLogs = await Test.createTestingModule({
        providers: [
          OpaClientService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: unknown) => {
                if (key === 'OPA_ENABLE_DECISION_LOGS') return true;
                return defaultConfig[key as keyof typeof defaultConfig] ?? defaultValue;
              }),
            },
          },
        ],
      }).compile();

      const serviceWithLogs = moduleWithLogs.get<OpaClientService>(OpaClientService);
      await serviceWithLogs.onModuleInit();

      const decisionHandler = jest.fn();
      serviceWithLogs.on('decision', decisionHandler);

      const mockResult: OpaResult = { result: true };
      mockFetch.mockResolvedValueOnce(createMockResponse(mockResult));

      await serviceWithLogs.evaluatePolicy('authz/logged', { user: 'test' });

      expect(decisionHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          policyPath: 'authz/logged',
          input: { user: 'test' },
        }),
      );

      serviceWithLogs.onModuleDestroy();
    });
  });

  describe('Batch Evaluation', () => {
    it('should evaluate multiple policies', async () => {
      const mockResults = [
        { result: true },
        { result: false },
        { result: { allow: true, reason: 'admin' } },
      ];

      mockFetch
        .mockResolvedValueOnce(createMockResponse(mockResults[0]))
        .mockResolvedValueOnce(createMockResponse(mockResults[1]))
        .mockResolvedValueOnce(createMockResponse(mockResults[2]));

      const results = await service.evaluatePolicies([
        { policyPath: 'authz/policy1', input: { user: 'user1' } },
        { policyPath: 'authz/policy2', input: { user: 'user2' } },
        { policyPath: 'authz/policy3', input: { user: 'user3' } },
      ]);

      expect(results).toHaveLength(3);
      expect(results[0].result).toBe(true);
      expect(results[1].result).toBe(false);
      expect((results[2].result as { allow: boolean }).allow).toBe(true);
    });
  });

  describe('Policy Management', () => {
    it('should get a policy by ID', async () => {
      const mockPolicy = {
        result: {
          id: 'test-policy',
          raw: 'package test\ndefault allow = false',
        },
      };

      mockFetch.mockResolvedValueOnce(createMockResponse(mockPolicy));

      const policy = await service.getPolicy('test-policy');

      expect(policy).toEqual(mockPolicy.result);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8181/v1/policies/test-policy',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should return null for non-existent policy', async () => {
      const error = new Error('HTTP 404: Not Found');
      (error as Error & { status: number }).status = 404;
      mockFetch.mockRejectedValueOnce(error);

      const policy = await service.getPolicy('non-existent');

      expect(policy).toBeNull();
    });

    it('should upsert a policy', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({}));

      const policyContent = 'package test\ndefault allow = false';
      await service.upsertPolicy('new-policy', policyContent);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8181/v1/policies/new-policy',
        expect.objectContaining({
          method: 'PUT',
          body: policyContent,
          headers: expect.objectContaining({
            'Content-Type': 'text/plain',
          }),
        }),
      );
    });

    it('should delete a policy', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({}));

      await service.deletePolicy('old-policy');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8181/v1/policies/old-policy',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('Data Management', () => {
    it('should get data document', async () => {
      const mockData = { result: { users: ['admin', 'user1'] } };
      mockFetch.mockResolvedValueOnce(createMockResponse(mockData));

      const data = await service.getData('users/admins');

      expect(data).toEqual(mockData.result);
    });

    it('should upsert data document', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({}));

      const newData = { roles: ['admin', 'user'] };
      await service.upsertData('config/roles', newData);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8181/v1/data/config/roles',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(newData),
        }),
      );
    });

    it('should delete data document', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({}));

      await service.deleteData('config/old');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8181/v1/data/config/old',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('Health Check', () => {
    it('should return healthy status when OPA responds', async () => {
      mockFetch
        .mockResolvedValueOnce(
          createMockResponse({
            plugins: {
              bundle: { state: 'OK' },
              decision_logs: { state: 'OK' },
            },
          }),
        )
        .mockResolvedValueOnce(createMockResponse({ version: '0.45.0' }));

      const health = await service.checkHealth();

      expect(health.status).toBe('healthy');
      expect(health.bundlesLoaded).toBe(true);
    });

    it('should return unhealthy status when OPA fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const health = await service.checkHealth();

      expect(health.status).toBe('unhealthy');
    });

    it('should include response time in health status', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ result: true }));

      const health = await service.checkHealth();

      expect(health.responseTime).toBeDefined();
      expect(typeof health.responseTime).toBe('number');
    });

    it('should emit healthChange event', async () => {
      const healthHandler = jest.fn();
      service.on('healthChange', healthHandler);

      mockFetch.mockResolvedValueOnce(createMockResponse({ result: true }));

      await service.checkHealth();

      expect(healthHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'healthy',
        }),
      );
    });

    it('should return current health status', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ result: true }));

      await service.checkHealth();
      const status = service.getHealthStatus();

      expect(status.status).toBe('healthy');
      expect(status.lastCheck).toBeInstanceOf(Date);
    });
  });

  describe('Circuit Breaker', () => {
    it('should start in closed state', () => {
      expect(service.getCircuitState()).toBe('closed');
    });

    it('should open circuit after threshold failures', async () => {
      const error = new Error('Server error');
      (error as Error & { status: number }).status = 500;

      // Simulate failures up to threshold
      for (let i = 0; i < 5; i++) {
        mockFetch.mockRejectedValueOnce(error);
        try {
          await service.evaluatePolicy('authz/fail', { test: i });
        } catch {
          // Expected
        }
      }

      expect(service.getCircuitState()).toBe('open');
    });

    it('should reject requests when circuit is open', async () => {
      // Force circuit open
      const error = new Error('Server error');
      (error as Error & { status: number }).status = 500;

      for (let i = 0; i < 5; i++) {
        mockFetch.mockRejectedValueOnce(error);
        try {
          await service.evaluatePolicy('authz/fail', { test: i });
        } catch {
          // Expected
        }
      }

      // Circuit should be open now
      await expect(
        service.evaluatePolicy('authz/blocked', { user: 'test' }),
      ).rejects.toThrow('OPA circuit breaker is open');
    });

    it('should transition to half-open after reset timeout', async () => {
      // Force circuit open
      const error = new Error('Server error');
      (error as Error & { status: number }).status = 500;

      for (let i = 0; i < 5; i++) {
        mockFetch.mockRejectedValueOnce(error);
        try {
          await service.evaluatePolicy('authz/fail', { test: i });
        } catch {
          // Expected
        }
      }

      expect(service.getCircuitState()).toBe('open');

      // Advance time past reset timeout
      jest.advanceTimersByTime(31000);

      // Next request should be allowed (circuit half-open)
      mockFetch.mockResolvedValueOnce(createMockResponse({ result: true }));
      await service.evaluatePolicy('authz/retry', { user: 'test' });

      expect(service.getCircuitState()).toBe('half_open');
    });

    it('should close circuit after successful requests in half-open state', async () => {
      // Force circuit open
      const error = new Error('Server error');
      (error as Error & { status: number }).status = 500;

      for (let i = 0; i < 5; i++) {
        mockFetch.mockRejectedValueOnce(error);
        try {
          await service.evaluatePolicy('authz/fail', { test: i });
        } catch {
          // Expected
        }
      }

      // Advance time to half-open
      jest.advanceTimersByTime(31000);

      // Make 3 successful requests to close circuit
      for (let i = 0; i < 3; i++) {
        mockFetch.mockResolvedValueOnce(createMockResponse({ result: true }));
        await service.evaluatePolicy(`authz/success${i}`, { test: i });
      }

      expect(service.getCircuitState()).toBe('closed');
    });

    it('should emit circuitStateChange event', async () => {
      const stateHandler = jest.fn();
      service.on('circuitStateChange', stateHandler);

      // Force circuit open
      const error = new Error('Server error');
      (error as Error & { status: number }).status = 500;

      for (let i = 0; i < 5; i++) {
        mockFetch.mockRejectedValueOnce(error);
        try {
          await service.evaluatePolicy('authz/fail', { test: i });
        } catch {
          // Expected
        }
      }

      expect(stateHandler).toHaveBeenCalledWith('open');
    });
  });

  describe('Retry Logic', () => {
    it('should retry on server errors', async () => {
      const error = new Error('Server error');
      (error as Error & { status: number }).status = 500;

      mockFetch
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(createMockResponse({ result: true }));

      // Need to advance timers for retry delays
      const promise = service.evaluatePolicy('authz/retry', { user: 'test' });

      // Advance through retry delays
      await jest.advanceTimersByTimeAsync(100);
      await jest.advanceTimersByTimeAsync(200);

      const result = await promise;
      expect(result.result).toBe(true);
    });

    it('should not retry on 4xx errors', async () => {
      const error = new Error('Bad request');
      (error as Error & { status: number }).status = 400;

      mockFetch.mockRejectedValueOnce(error);

      await expect(
        service.evaluatePolicy('authz/bad', { invalid: true }),
      ).rejects.toThrow('Bad request');

      // Should only have called once (no retry)
      const policyCalls = mockFetch.mock.calls.filter((call) =>
        call[0].includes('/v1/data/authz/bad'),
      );
      expect(policyCalls).toHaveLength(1);
    });

    it('should throw after max retries exceeded', async () => {
      const error = new Error('Server error');
      (error as Error & { status: number }).status = 500;

      mockFetch.mockRejectedValue(error);

      const promise = service.evaluatePolicy('authz/always-fail', { user: 'test' });

      // Advance through all retry delays
      await jest.advanceTimersByTimeAsync(100);
      await jest.advanceTimersByTimeAsync(200);
      await jest.advanceTimersByTimeAsync(400);

      await expect(promise).rejects.toThrow('Server error');
    });
  });

  describe('Cache Management', () => {
    it('should clear all cache', async () => {
      const mockResult: OpaResult = { result: true };
      mockFetch.mockResolvedValue(createMockResponse(mockResult));

      // Populate cache
      await service.evaluatePolicy('authz/cache1', { user: 'test' });
      const callCount = mockFetch.mock.calls.length;

      // Clear cache
      service.clearCache();

      // Next call should fetch again
      await service.evaluatePolicy('authz/cache1', { user: 'test' });
      expect(mockFetch.mock.calls.length).toBeGreaterThan(callCount);
    });

    it('should invalidate cache by prefix', async () => {
      const mockResult: OpaResult = { result: true };
      mockFetch.mockResolvedValue(createMockResponse(mockResult));

      // Populate cache with multiple entries
      await service.evaluatePolicy('authz/users/list', { page: 1 });
      await service.evaluatePolicy('authz/users/get', { id: 1 });
      await service.evaluatePolicy('authz/farms/list', { page: 1 });
      const callCount = mockFetch.mock.calls.length;

      // Invalidate only users policies
      service.invalidateCache('authz/users');

      // Users policies should fetch again
      await service.evaluatePolicy('authz/users/list', { page: 1 });
      expect(mockFetch.mock.calls.length).toBeGreaterThan(callCount);

      // Farms policy should still be cached (this checks the farms call wasn't repeated)
      const farmsCallsBefore = mockFetch.mock.calls.filter((call) =>
        call[0].includes('authz/farms'),
      ).length;
      await service.evaluatePolicy('authz/farms/list', { page: 1 });
      const farmsCallsAfter = mockFetch.mock.calls.filter((call) =>
        call[0].includes('authz/farms'),
      ).length;
      expect(farmsCallsAfter).toBe(farmsCallsBefore);
    });
  });

  describe('Timeout Handling', () => {
    it('should abort request on timeout', async () => {
      // Mock a slow response
      mockFetch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () => resolve(createMockResponse({ result: true })),
              10000,
            );
          }),
      );

      const promise = service.evaluatePolicy('authz/slow', { user: 'test' });

      // Advance past timeout
      jest.advanceTimersByTime(6000);

      await expect(promise).rejects.toThrow();
    });
  });

  describe('Error Handling', () => {
    it('should handle non-OK responses', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({}, 500));

      await expect(
        service.evaluatePolicy('authz/error', { user: 'test' }),
      ).rejects.toThrow();
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('Network error'));

      const promise = service.evaluatePolicy('authz/network', { user: 'test' });

      // Advance through retries
      await jest.advanceTimersByTimeAsync(100);
      await jest.advanceTimersByTimeAsync(200);
      await jest.advanceTimersByTimeAsync(400);

      await expect(promise).rejects.toThrow('Network error');
    });

    it('should handle malformed JSON responses', async () => {
      const badResponse = {
        ...createMockResponse({}),
        json: jest.fn().mockRejectedValue(new Error('Invalid JSON')),
      };
      mockFetch.mockResolvedValueOnce(badResponse);

      await expect(
        service.evaluatePolicy('authz/bad-json', { user: 'test' }),
      ).rejects.toThrow();
    });
  });

  describe('Configuration', () => {
    it('should use configured base URL', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ result: true }));

      await service.evaluatePolicy('test/policy', {});

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('http://localhost:8181'),
        expect.any(Object),
      );
    });

    it('should respect custom timeout', async () => {
      // This is implicitly tested through the abort controller timeout
      expect(configService.get).toHaveBeenCalledWith('OPA_TIMEOUT', expect.any(Number));
    });
  });
});
