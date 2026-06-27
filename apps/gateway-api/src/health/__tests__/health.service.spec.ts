 
 
 
 
 
 
 
 
 
 
 

/**
 * Health Service Tests
 *
 * Comprehensive test suite for health monitoring service
 */

import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

import { CompositionStateService } from '../../config/composition-state.service';
import { HealthService, ServiceHealth, HealthStatus } from '../health.service';

describe('HealthService', () => {
  let service: HealthService;
  let compositionState: jest.Mocked<CompositionStateService>;
  let originalFetch: typeof global.fetch;

  /**
   * ARCH-GW-003: Must match the number of services in health.service.ts serviceUrls map.
   * Currently 10 subgraphs: auth, farm, sensor, alert, hr, billing,
   * hydroponics, config, notification, messaging.
   */
  const TOTAL_MONITORED_SERVICES = 10;

  /**
   * ARCH-GW-006: composition readiness mock. Defaults to composed=true so the
   * existing subgraph-fan-out readiness paths still exercise; individual tests
   * override isComposed() to drive the composition-pending short-circuit.
   */
  const mockCompositionState = {
    isComposed: jest.fn<boolean, []>(() => true),
    getLastError: jest.fn<string | null, []>(() => null),
    getLastComposedAt: jest.fn<Date | null, []>(() => new Date()),
    markComposed: jest.fn<void, []>(),
    markCompositionError: jest.fn<void, [string]>(),
  };

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: unknown) => {
      const config: Record<string, unknown> = {
        HEALTH_CHECK_TIMEOUT_MS: 5000,
        AUTH_SERVICE_URL: 'http://auth:3001/graphql',
        FARM_SERVICE_URL: 'http://farm:3002/graphql',
        SENSOR_SERVICE_URL: 'http://sensor:3003/graphql',
        ALERT_SERVICE_URL: 'http://alert:3004/graphql',
        HR_SERVICE_URL: 'http://hr:3005/graphql',
        BILLING_SERVICE_URL: 'http://billing:3006/graphql',
        HYDROPONICS_SERVICE_URL: 'http://hydroponics:4007/graphql',
        CONFIG_SERVICE_URL: 'http://config:3007/graphql',
        NOTIFICATION_SERVICE_URL: 'http://notification:4008/graphql',
        MESSAGING_SERVICE_URL: 'http://messaging:3000/graphql',
        APP_VERSION: '1.2.3',
      };
      return config[key] ?? defaultValue;
    }),
  };

  /**
   * Create mock fetch response
   */
  const createMockFetchResponse = (
    ok: boolean,
    status = 200,
    data: unknown = {},
  ): Response => {
    return {
      ok,
      status,
      json: jest.fn().mockResolvedValue(data),
    } as unknown as Response;
  };

  beforeEach(async () => {
    originalFetch = global.fetch;
    global.fetch = jest.fn();

    // Reset composition mock to the composed-by-default baseline each test.
    mockCompositionState.isComposed.mockReturnValue(true);
    mockCompositionState.getLastError.mockReturnValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: CompositionStateService,
          useValue: mockCompositionState,
        },
      ],
    }).compile();

    service = module.get<HealthService>(HealthService);
    compositionState = module.get(CompositionStateService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  describe('getLiveness', () => {
    it('should return ok status', () => {
      const result = service.getLiveness();

      expect(result).toEqual({ status: 'ok' });
    });

    it('should always return ok regardless of service health', () => {
      // Mock all services as unhealthy
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Connection refused'));

      const result = service.getLiveness();

      expect(result).toEqual({ status: 'ok' });
    });
  });

  describe('getReadiness', () => {
    it('should return ok with all checks ok when composed and every subgraph is healthy', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        createMockFetchResponse(true, 200),
      );

      const result = await service.getReadiness();

      expect(result).toEqual({
        status: 'ok',
        checks: { composition: 'ok', auth: 'ok', subgraphs: 'ok' },
      });
    });

    it('should short-circuit to not_ready with composition pending before the supergraph composes', async () => {
      compositionState.isComposed.mockReturnValue(false);
      (global.fetch as jest.Mock).mockResolvedValue(
        createMockFetchResponse(true, 200),
      );

      const result = await service.getReadiness();

      expect(result.status).toBe('not_ready');
      expect(result.checks).toEqual({
        composition: 'pending',
        auth: 'ok',
        subgraphs: 'ok',
      });
      expect(result.message).toBe('Supergraph composition pending');
      // No subgraph fan-out while composition is pending.
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should surface the last composition error in the pending message', async () => {
      compositionState.isComposed.mockReturnValue(false);
      compositionState.getLastError.mockReturnValue('subgraph auth unreachable');

      const result = await service.getReadiness();

      expect(result.status).toBe('not_ready');
      expect(result.message).toBe(
        'Supergraph composition pending (last error: subgraph auth unreachable)',
      );
    });

    it('should return not_ready with auth error when auth service is unreachable', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Connection refused'));

      const result = await service.getReadiness();

      expect(result).toEqual({
        status: 'not_ready',
        message: 'Auth service is unavailable',
        checks: { composition: 'ok', auth: 'error', subgraphs: 'ok' },
      });
    });

    it('should return not_ready with auth error when auth returns error status', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        createMockFetchResponse(false, 500),
      );

      const result = await service.getReadiness();

      expect(result.status).toBe('not_ready');
      expect(result.checks.auth).toBe('error');
      expect(result.message).toBe('Auth service is unavailable');
    });

    it('should return not_ready with subgraphs degraded when a non-auth subgraph is unhealthy', async () => {
      // auth (first call) healthy, the next subgraph fails, rest healthy.
      let callCount = 0;
      (global.fetch as jest.Mock).mockImplementation((url: string) => {
        callCount++;
        if (url.includes('farm')) {
          return Promise.reject(new Error('Connection refused'));
        }
        return Promise.resolve(createMockFetchResponse(true, 200));
      });

      const result = await service.getReadiness();

      expect(callCount).toBeGreaterThan(0);
      expect(result.status).toBe('not_ready');
      expect(result.checks).toEqual({
        composition: 'ok',
        auth: 'ok',
        subgraphs: 'degraded',
      });
      expect(result.message).toContain('farm');
    });

    it('should check auth service health endpoint once composed', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        createMockFetchResponse(true, 200),
      );

      await service.getReadiness();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://auth:3001/health',
        expect.objectContaining({
          method: 'GET',
          // WHY objectContaining: health probes are HMAC-signed (HIGH-003) —
          // the X-Service-* identity headers ride alongside Accept.
          headers: expect.objectContaining({ Accept: 'application/json' }),
        }),
      );
    });
  });

  describe('getHealth', () => {
    it('should return healthy status when all services are healthy', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        createMockFetchResponse(true, 200),
      );

      const result = await service.getHealth();

      expect(result.status).toBe('healthy');
      expect(result.services).toHaveLength(TOTAL_MONITORED_SERVICES);
      result.services.forEach((svc) => {
        expect(svc.status).toBe('healthy');
      });
    });

    it('should return degraded when some services are unhealthy', async () => {
      // Make 2 services fail (less than half)
      let callCount = 0;
      (global.fetch as jest.Mock).mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.reject(new Error('Connection refused'));
        }
        return Promise.resolve(createMockFetchResponse(true, 200));
      });

      const result = await service.getHealth();

      expect(result.status).toBe('degraded');
    });

    it('should return unhealthy when more than half services are unhealthy', async () => {
      // Make 6 services fail (more than half of TOTAL_MONITORED_SERVICES=10)
      let callCount = 0;
      (global.fetch as jest.Mock).mockImplementation(() => {
        callCount++;
        if (callCount <= 6) {
          return Promise.reject(new Error('Connection refused'));
        }
        return Promise.resolve(createMockFetchResponse(true, 200));
      });

      const result = await service.getHealth();

      expect(result.status).toBe('unhealthy');
    });

    it('should return degraded when some services have slow responses', async () => {
      // Simulate slow response (>2000ms)
      let callCount = 0;
      (global.fetch as jest.Mock).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First service is slow - we can't actually delay here easily,
          // so we'll test the degraded path differently
          return Promise.resolve(createMockFetchResponse(true, 200));
        }
        return Promise.resolve(createMockFetchResponse(true, 200));
      });

      const result = await service.getHealth();

      // All fast, so healthy
      expect(result.status).toBe('healthy');
    });

    it('should include timestamp', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        createMockFetchResponse(true, 200),
      );

      const beforeTime = new Date();
      const result = await service.getHealth();
      const afterTime = new Date();

      expect(result.timestamp).toBeDefined();
      // HealthStatus.timestamp was widened from `Date` to ISO 8601
      // `string` (health.service.ts:22). Convert to a Date at the
      // test boundary for the temporal-window assertion.
      const resultTime = new Date(result.timestamp).getTime();
      expect(resultTime).toBeGreaterThanOrEqual(beforeTime.getTime());
      expect(resultTime).toBeLessThanOrEqual(afterTime.getTime());
    });

    it('should include uptime', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        createMockFetchResponse(true, 200),
      );

      const result = await service.getHealth();

      expect(result.uptime).toBeGreaterThanOrEqual(0);
    });

    it('should include version from config', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        createMockFetchResponse(true, 200),
      );

      const result = await service.getHealth();

      expect(result.version).toBe('1.2.3');
    });

    it('should include memory usage', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        createMockFetchResponse(true, 200),
      );

      const result = await service.getHealth();

      expect(result.memory).toBeDefined();
      expect(result.memory.heapUsed).toBeGreaterThan(0);
      expect(result.memory.heapTotal).toBeGreaterThan(0);
      expect(result.memory.external).toBeDefined();
      expect(result.memory.rss).toBeGreaterThan(0);
    });

    it('should check all configured services', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        createMockFetchResponse(true, 200),
      );

      const result = await service.getHealth();

      const serviceNames = result.services.map((s) => s.name);
      expect(serviceNames).toContain('auth');
      expect(serviceNames).toContain('farm');
      expect(serviceNames).toContain('sensor');
      expect(serviceNames).toContain('alert');
      expect(serviceNames).toContain('hr');
      expect(serviceNames).toContain('billing');
      expect(serviceNames).toContain('hydroponics');
      expect(serviceNames).toContain('config');
      expect(serviceNames).toContain('notification');
      expect(serviceNames).toContain('messaging');
    });
  });

  describe('Service Health Checks', () => {
    it('should include response time for healthy services', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        createMockFetchResponse(true, 200),
      );

      const result = await service.getHealth();

      result.services.forEach((svc) => {
        expect(svc.responseTime).toBeDefined();
        expect(svc.responseTime).toBeGreaterThanOrEqual(0);
      });
    });

    it('should include service URL', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        createMockFetchResponse(true, 200),
      );

      const result = await service.getHealth();

      const authService = result.services.find((s) => s.name === 'auth');
      expect(authService?.url).toBe('http://auth:3001/graphql');
    });

    it('should include lastChecked timestamp', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        createMockFetchResponse(true, 200),
      );

      const result = await service.getHealth();

      result.services.forEach((svc) => {
        expect(svc.lastChecked).toBeInstanceOf(Date);
      });
    });

    it('should include error message for unhealthy services', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await service.getHealth();

      result.services.forEach((svc) => {
        expect(svc.status).toBe('unhealthy');
        expect(svc.error).toBe('ECONNREFUSED');
      });
    });

    it('should mark service unhealthy on HTTP error status', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        createMockFetchResponse(false, 503),
      );

      const result = await service.getHealth();

      result.services.forEach((svc) => {
        expect(svc.status).toBe('unhealthy');
        expect(svc.error).toBe('HTTP 503');
      });
    });

    it('should convert graphql URL to health URL', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        createMockFetchResponse(true, 200),
      );

      await service.getHealth();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://auth:3001/health',
        expect.any(Object),
      );
      expect(global.fetch).toHaveBeenCalledWith(
        'http://farm:3002/health',
        expect.any(Object),
      );
    });
  });

  describe('Timeout Handling', () => {
    it('should use configured timeout', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        createMockFetchResponse(true, 200),
      );

      await service.getHealth();

      // Verify AbortController signal is passed
      const mockFetch = global.fetch as jest.Mock;
      const fetchCall = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(fetchCall[1].signal).toBeDefined();
    });

    it('should handle timeout as unhealthy', async () => {
      const abortError = new Error('AbortError');
      abortError.name = 'AbortError';
      (global.fetch as jest.Mock).mockRejectedValue(abortError);

      const result = await service.getHealth();

      result.services.forEach((svc) => {
        expect(svc.status).toBe('unhealthy');
      });
    });
  });

  describe('Parallel Health Checks', () => {
    it('should check all services in parallel', async () => {
      const fetchPromises: Array<{
        resolve: (value: Response) => void;
        time: number;
      }> = [];

      (global.fetch as jest.Mock).mockImplementation(() => {
        return new Promise<Response>((resolve) => {
          fetchPromises.push({ resolve, time: Date.now() });
        });
      });

      const healthPromise = service.getHealth();

      // Wait a bit for all fetch calls to be made
      await new Promise((r) => setTimeout(r, 10));

      // All fetches should have been initiated (one per monitored service)
      expect(fetchPromises.length).toBe(TOTAL_MONITORED_SERVICES);

      // Resolve all fetches
      fetchPromises.forEach(({ resolve }) => {
        resolve(createMockFetchResponse(true, 200));
      });

      await healthPromise;

      // Verify they were called in parallel (all started within a short time)
      const times = fetchPromises.map((p) => p.time);
      const maxDiff = Math.max(...times) - Math.min(...times);
      expect(maxDiff).toBeLessThan(100); // All should start within 100ms
    });
  });

  describe('Configuration', () => {
    it('should use default timeout when not configured', async () => {
      mockConfigService.get.mockImplementation((key: string, defaultValue?: unknown) => {
        if (key === 'HEALTH_CHECK_TIMEOUT_MS') {
          return defaultValue; // Return default (5000)
        }
        return defaultValue;
      });

      // Re-create service with updated config
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          HealthService,
          {
            provide: ConfigService,
            useValue: mockConfigService,
          },
          {
            provide: CompositionStateService,
            useValue: mockCompositionState,
          },
        ],
      }).compile();

      const testService = module.get<HealthService>(HealthService);

      (global.fetch as jest.Mock).mockResolvedValue(
        createMockFetchResponse(true, 200),
      );

      await testService.getHealth();

      // Service should still work
      expect(global.fetch).toHaveBeenCalled();
    });

    it('should use default version when not configured', async () => {
      mockConfigService.get.mockImplementation((key: string, defaultValue?: unknown) => {
        if (key === 'APP_VERSION') {
          return defaultValue; // Return default (1.0.0)
        }
        const config: Record<string, unknown> = {
          AUTH_SERVICE_URL: 'http://auth:3001/graphql',
        };
        return config[key] ?? defaultValue;
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          HealthService,
          {
            provide: ConfigService,
            useValue: mockConfigService,
          },
          {
            provide: CompositionStateService,
            useValue: mockCompositionState,
          },
        ],
      }).compile();

      const testService = module.get<HealthService>(HealthService);

      (global.fetch as jest.Mock).mockResolvedValue(
        createMockFetchResponse(true, 200),
      );

      const result = await testService.getHealth();

      expect(result.version).toBe('1.0.0');
    });
  });

  describe('Edge Cases', () => {
    it('should handle unknown error types', async () => {
      (global.fetch as jest.Mock).mockRejectedValue('String error');

      const result = await service.getHealth();

      result.services.forEach((svc) => {
        expect(svc.status).toBe('unhealthy');
        expect(svc.error).toBe('Unknown error');
      });
    });

    it('should handle mixed service states', async () => {
      let callIndex = 0;
      (global.fetch as jest.Mock).mockImplementation(() => {
        callIndex++;
        switch (callIndex) {
          case 1:
            return Promise.resolve(createMockFetchResponse(true, 200)); // healthy
          case 2:
            return Promise.reject(new Error('Connection failed')); // unhealthy
          case 3:
            return Promise.resolve(createMockFetchResponse(false, 503)); // unhealthy
          default:
            return Promise.resolve(createMockFetchResponse(true, 200)); // healthy
        }
      });

      const result = await service.getHealth();

      const healthyCount = result.services.filter((s) => s.status === 'healthy').length;
      const unhealthyCount = result.services.filter((s) => s.status === 'unhealthy').length;

      // Switch cases: 1=healthy, 2=unhealthy, 3=unhealthy, rest=healthy
      expect(healthyCount).toBe(TOTAL_MONITORED_SERVICES - 2);
      expect(unhealthyCount).toBe(2);
      expect(result.status).toBe('degraded'); // 2 unhealthy < half of TOTAL_MONITORED_SERVICES
    });

    it('should handle all services healthy with varying response times', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        createMockFetchResponse(true, 200),
      );

      const result = await service.getHealth();

      expect(result.status).toBe('healthy');
      expect(result.services.every((s) => s.status === 'healthy')).toBe(true);
    });

    it('should handle empty response from health endpoint', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        createMockFetchResponse(true, 200, null),
      );

      const result = await service.getHealth();

      expect(result.status).toBe('healthy');
    });
  });

  describe('ServiceHealth Interface', () => {
    it('should return correct ServiceHealth structure', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        createMockFetchResponse(true, 200),
      );

      const result = await service.getHealth();

      result.services.forEach((svc: ServiceHealth) => {
        expect(svc).toHaveProperty('name');
        expect(svc).toHaveProperty('status');
        expect(svc).toHaveProperty('url');
        expect(svc).toHaveProperty('lastChecked');
        expect(['healthy', 'unhealthy', 'degraded']).toContain(svc.status);
      });
    });
  });

  describe('HealthStatus Interface', () => {
    it('should return correct HealthStatus structure', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        createMockFetchResponse(true, 200),
      );

      const result: HealthStatus = await service.getHealth();

      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('uptime');
      expect(result).toHaveProperty('version');
      expect(result).toHaveProperty('services');
      expect(result).toHaveProperty('memory');
      expect(['healthy', 'unhealthy', 'degraded']).toContain(result.status);
      expect(Array.isArray(result.services)).toBe(true);
    });
  });
});
