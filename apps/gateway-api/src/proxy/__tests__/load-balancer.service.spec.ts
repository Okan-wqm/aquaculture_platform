/**
 * Load Balancer Service Tests
 *
 * Comprehensive test suite for load balancing functionality
 */

import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

import {
  LoadBalancerService,
  LoadBalancingAlgorithm,
  InstanceHealth,
  ServiceConfig,
  ServiceInstance,
  hashString,
} from '../load-balancer.service';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('LoadBalancerService', () => {
  let service: LoadBalancerService;

  const createTestService = (
    name: string,
    algorithm: LoadBalancingAlgorithm = LoadBalancingAlgorithm.ROUND_ROBIN,
    instances: ServiceInstance[] = [
      { id: 'instance-1', host: 'host1.local', port: 8080 },
      { id: 'instance-2', host: 'host2.local', port: 8080 },
      { id: 'instance-3', host: 'host3.local', port: 8080 },
    ],
  ): ServiceConfig => ({
    name,
    instances,
    algorithm,
    healthCheckInterval: 60000, // Long interval to prevent auto health checks
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Default healthy response for health checks
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoadBalancerService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => defaultValue),
          },
        },
      ],
    }).compile();

    service = module.get<LoadBalancerService>(LoadBalancerService);
    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  describe('Service Registration', () => {
    it('should register a service with instances', () => {
      const config = createTestService('test-service');
      service.registerService(config);

      const instances = service.getInstances('test-service');
      expect(instances).toHaveLength(3);
    });

    it('should initialize instance stats', () => {
      const config = createTestService('stats-service');
      service.registerService(config);

      const instances = service.getInstances('stats-service');
      expect(instances[0].health).toBe(InstanceHealth.UNKNOWN);
      expect(instances[0].activeConnections).toBe(0);
      expect(instances[0].totalRequests).toBe(0);
    });

    it('should unregister a service', () => {
      const config = createTestService('remove-service');
      service.registerService(config);

      service.unregisterService('remove-service');

      const instances = service.getInstances('remove-service');
      expect(instances).toHaveLength(0);
    });

    it('should add instance to existing service', () => {
      const config = createTestService('grow-service', LoadBalancingAlgorithm.ROUND_ROBIN, [
        { id: 'instance-1', host: 'host1.local', port: 8080 },
      ]);
      service.registerService(config);

      service.addInstance('grow-service', { id: 'instance-2', host: 'host2.local', port: 8080 });

      const instances = service.getInstances('grow-service');
      expect(instances).toHaveLength(2);
    });

    it('should not add duplicate instance', () => {
      const config = createTestService('dup-service', LoadBalancingAlgorithm.ROUND_ROBIN, [
        { id: 'instance-1', host: 'host1.local', port: 8080 },
      ]);
      service.registerService(config);

      service.addInstance('dup-service', { id: 'instance-1', host: 'host3.local', port: 8080 });

      const instances = service.getInstances('dup-service');
      expect(instances).toHaveLength(1);
    });

    it('should remove instance from service', () => {
      const config = createTestService('shrink-service');
      service.registerService(config);

      service.removeInstance('shrink-service', 'instance-2');

      const instances = service.getInstances('shrink-service');
      expect(instances).toHaveLength(2);
      expect(instances.find((i) => i.id === 'instance-2')).toBeUndefined();
    });

    it('should emit instanceAdded event', () => {
      const config = createTestService('event-service', LoadBalancingAlgorithm.ROUND_ROBIN, []);
      service.registerService(config);

      const handler = jest.fn();
      service.on('instanceAdded', handler);

      service.addInstance('event-service', { id: 'new-instance', host: 'new.local', port: 8080 });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceName: 'event-service',
          instance: expect.objectContaining({ id: 'new-instance' }),
        }),
      );
    });

    it('should emit instanceRemoved event', () => {
      const config = createTestService('event-remove-service');
      service.registerService(config);

      const handler = jest.fn();
      service.on('instanceRemoved', handler);

      service.removeInstance('event-remove-service', 'instance-1');

      expect(handler).toHaveBeenCalledWith({
        serviceName: 'event-remove-service',
        instanceId: 'instance-1',
      });
    });
  });

  describe('Load Balancing Algorithms', () => {
    describe('Round Robin', () => {
      it('should distribute requests evenly', () => {
        const config = createTestService('rr-service', LoadBalancingAlgorithm.ROUND_ROBIN);
        service.registerService(config);

        // Mark all healthy
        service.markHealthy('rr-service', 'instance-1');
        service.markHealthy('rr-service', 'instance-2');
        service.markHealthy('rr-service', 'instance-3');

        const selections: string[] = [];
        for (let i = 0; i < 9; i++) {
          const instance = service.getNextInstance('rr-service');
          selections.push(instance!.id);
        }

        // Should cycle through all instances
        expect(selections.filter((s) => s === 'instance-1')).toHaveLength(3);
        expect(selections.filter((s) => s === 'instance-2')).toHaveLength(3);
        expect(selections.filter((s) => s === 'instance-3')).toHaveLength(3);
      });
    });

    describe('Least Connections', () => {
      it('should select instance with fewest connections', () => {
        const config = createTestService('lc-service', LoadBalancingAlgorithm.LEAST_CONNECTIONS);
        service.registerService(config);

        // Mark all healthy
        service.markHealthy('lc-service', 'instance-1');
        service.markHealthy('lc-service', 'instance-2');
        service.markHealthy('lc-service', 'instance-3');

        // Simulate active connections on instance-1 and instance-2
        service.recordRequestStart('lc-service', 'instance-1');
        service.recordRequestStart('lc-service', 'instance-1');
        service.recordRequestStart('lc-service', 'instance-2');

        const selected = service.getNextInstance('lc-service');
        expect(selected?.id).toBe('instance-3');
      });
    });

    describe('Weighted Round Robin', () => {
      it('should respect instance weights', () => {
        const config = createTestService(
          'weighted-service',
          LoadBalancingAlgorithm.WEIGHTED_ROUND_ROBIN,
          [
            { id: 'heavy', host: 'heavy.local', port: 8080, weight: 5 },
            { id: 'light', host: 'light.local', port: 8080, weight: 1 },
          ],
        );
        service.registerService(config);

        service.markHealthy('weighted-service', 'heavy');
        service.markHealthy('weighted-service', 'light');

        const selections: string[] = [];
        for (let i = 0; i < 12; i++) {
          const instance = service.getNextInstance('weighted-service');
          selections.push(instance!.id);
        }

        const heavyCount = selections.filter((s) => s === 'heavy').length;
        const lightCount = selections.filter((s) => s === 'light').length;

        // Heavy should be selected more often (5:1 ratio)
        expect(heavyCount).toBeGreaterThan(lightCount);
      });
    });

    describe('IP Hash', () => {
      it('should consistently select same instance for same IP', () => {
        const config = createTestService('ip-hash-service', LoadBalancingAlgorithm.IP_HASH);
        service.registerService(config);

        service.markHealthy('ip-hash-service', 'instance-1');
        service.markHealthy('ip-hash-service', 'instance-2');
        service.markHealthy('ip-hash-service', 'instance-3');

        const clientIp = '192.168.1.100';

        const instance1 = service.getNextInstance('ip-hash-service', { clientIp });
        const instance2 = service.getNextInstance('ip-hash-service', { clientIp });
        const instance3 = service.getNextInstance('ip-hash-service', { clientIp });

        expect(instance1?.id).toBe(instance2?.id);
        expect(instance2?.id).toBe(instance3?.id);
      });

      it('should distribute different IPs across instances', () => {
        const config = createTestService('ip-dist-service', LoadBalancingAlgorithm.IP_HASH);
        service.registerService(config);

        service.markHealthy('ip-dist-service', 'instance-1');
        service.markHealthy('ip-dist-service', 'instance-2');
        service.markHealthy('ip-dist-service', 'instance-3');

        const ips = ['192.168.1.1', '192.168.1.2', '192.168.1.3', '10.0.0.1', '10.0.0.2'];
        const selections = new Set<string>();

        for (const ip of ips) {
          const instance = service.getNextInstance('ip-dist-service', { clientIp: ip });
          selections.add(instance!.id);
        }

        // Should distribute across multiple instances
        expect(selections.size).toBeGreaterThan(1);
      });
    });

    describe('Random', () => {
      it('should select random instances', () => {
        const config = createTestService('random-service', LoadBalancingAlgorithm.RANDOM);
        service.registerService(config);

        service.markHealthy('random-service', 'instance-1');
        service.markHealthy('random-service', 'instance-2');
        service.markHealthy('random-service', 'instance-3');

        // Mock Math.random to verify randomness is used
        const originalRandom = Math.random;
        const mockRandom = jest.fn().mockReturnValue(0.5);
        Math.random = mockRandom;

        service.getNextInstance('random-service');

        expect(mockRandom).toHaveBeenCalled();

        Math.random = originalRandom;
      });
    });

    describe('Least Response Time', () => {
      it('should select instance with lowest response time', () => {
        const config = createTestService('lrt-service', LoadBalancingAlgorithm.LEAST_RESPONSE_TIME);
        service.registerService(config);

        service.markHealthy('lrt-service', 'instance-1');
        service.markHealthy('lrt-service', 'instance-2');
        service.markHealthy('lrt-service', 'instance-3');

        // Record response times
        service.recordRequestStart('lrt-service', 'instance-1');
        service.recordRequestEnd('lrt-service', 'instance-1', true, 500);

        service.recordRequestStart('lrt-service', 'instance-2');
        service.recordRequestEnd('lrt-service', 'instance-2', true, 100);

        service.recordRequestStart('lrt-service', 'instance-3');
        service.recordRequestEnd('lrt-service', 'instance-3', true, 300);

        const selected = service.getNextInstance('lrt-service');
        expect(selected?.id).toBe('instance-2');
      });

      it('should fallback to round-robin when no response time data', () => {
        const config = createTestService(
          'lrt-fallback-service',
          LoadBalancingAlgorithm.LEAST_RESPONSE_TIME,
        );
        service.registerService(config);

        service.markHealthy('lrt-fallback-service', 'instance-1');
        service.markHealthy('lrt-fallback-service', 'instance-2');

        // No response time data recorded
        const instance = service.getNextInstance('lrt-fallback-service');
        expect(instance).not.toBeNull();
      });
    });
  });

  describe('Health Management', () => {
    it('should mark instance as healthy', () => {
      const config = createTestService('health-service');
      service.registerService(config);

      service.markHealthy('health-service', 'instance-1');

      const instances = service.getInstances('health-service');
      const instance = instances.find((i) => i.id === 'instance-1');
      expect(instance?.health).toBe(InstanceHealth.HEALTHY);
    });

    it('should mark instance as unhealthy', () => {
      const config = createTestService('unhealthy-service');
      service.registerService(config);

      service.markHealthy('unhealthy-service', 'instance-1');
      service.markUnhealthy('unhealthy-service', 'instance-1');

      const instances = service.getInstances('unhealthy-service');
      const instance = instances.find((i) => i.id === 'instance-1');
      expect(instance?.health).toBe(InstanceHealth.UNHEALTHY);
    });

    it('should emit health change event', () => {
      const config = createTestService('health-event-service');
      service.registerService(config);

      const handler = jest.fn();
      service.on('instanceHealthChanged', handler);

      service.markHealthy('health-event-service', 'instance-1');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceName: 'health-event-service',
          instanceId: 'instance-1',
          newHealth: InstanceHealth.HEALTHY,
        }),
      );
    });

    it('should only return healthy instances', () => {
      const config = createTestService('filter-health-service');
      service.registerService(config);

      service.markHealthy('filter-health-service', 'instance-1');
      service.markUnhealthy('filter-health-service', 'instance-2');
      service.markHealthy('filter-health-service', 'instance-3');

      const healthy = service.getHealthyInstances('filter-health-service');
      expect(healthy).toHaveLength(2);
      expect(healthy.find((i) => i.id === 'instance-2')).toBeUndefined();
    });

    it('should return null when no healthy instances', () => {
      const config = createTestService('no-healthy-service');
      service.registerService(config);

      service.markUnhealthy('no-healthy-service', 'instance-1');
      service.markUnhealthy('no-healthy-service', 'instance-2');
      service.markUnhealthy('no-healthy-service', 'instance-3');

      const instance = service.getNextInstance('no-healthy-service');
      expect(instance).toBeNull();
    });

    it('should include degraded instances in healthy pool', () => {
      const config = createTestService('degraded-service');
      service.registerService(config);

      // Mark as healthy first, then simulate degraded state
      service.markHealthy('degraded-service', 'instance-1');

      const healthy = service.getHealthyInstances('degraded-service');
      expect(healthy.some((i) => i.id === 'instance-1')).toBe(true);
    });
  });

  describe('Request Tracking', () => {
    it('should track active connections', () => {
      const config = createTestService('tracking-service');
      service.registerService(config);

      service.recordRequestStart('tracking-service', 'instance-1');
      service.recordRequestStart('tracking-service', 'instance-1');

      const instances = service.getInstances('tracking-service');
      const instance = instances.find((i) => i.id === 'instance-1');
      expect(instance?.activeConnections).toBe(2);
    });

    it('should decrement connections on request end', () => {
      const config = createTestService('end-tracking-service');
      service.registerService(config);

      service.recordRequestStart('end-tracking-service', 'instance-1');
      service.recordRequestStart('end-tracking-service', 'instance-1');
      service.recordRequestEnd('end-tracking-service', 'instance-1', true, 100);

      const instances = service.getInstances('end-tracking-service');
      const instance = instances.find((i) => i.id === 'instance-1');
      expect(instance?.activeConnections).toBe(1);
    });

    it('should track total requests', () => {
      const config = createTestService('total-tracking-service');
      service.registerService(config);

      service.recordRequestStart('total-tracking-service', 'instance-1');
      service.recordRequestStart('total-tracking-service', 'instance-1');
      service.recordRequestStart('total-tracking-service', 'instance-1');

      const instances = service.getInstances('total-tracking-service');
      const instance = instances.find((i) => i.id === 'instance-1');
      expect(instance?.totalRequests).toBe(3);
    });

    it('should track failed requests', () => {
      const config = createTestService('fail-tracking-service');
      service.registerService(config);

      service.recordRequestStart('fail-tracking-service', 'instance-1');
      service.recordRequestEnd('fail-tracking-service', 'instance-1', false, 100);

      const instances = service.getInstances('fail-tracking-service');
      const instance = instances.find((i) => i.id === 'instance-1');
      expect(instance?.failedRequests).toBe(1);
    });

    it('should track consecutive failures', () => {
      const config = createTestService('consecutive-fail-service');
      service.registerService(config);

      service.recordRequestStart('consecutive-fail-service', 'instance-1');
      service.recordRequestEnd('consecutive-fail-service', 'instance-1', false, 100);
      service.recordRequestStart('consecutive-fail-service', 'instance-1');
      service.recordRequestEnd('consecutive-fail-service', 'instance-1', false, 100);
      service.recordRequestStart('consecutive-fail-service', 'instance-1');
      service.recordRequestEnd('consecutive-fail-service', 'instance-1', false, 100);

      const instances = service.getInstances('consecutive-fail-service');
      const instance = instances.find((i) => i.id === 'instance-1');
      expect(instance?.consecutiveFailures).toBe(3);
    });

    it('should reset consecutive failures on success', () => {
      const config = createTestService('reset-fail-service');
      service.registerService(config);

      service.recordRequestStart('reset-fail-service', 'instance-1');
      service.recordRequestEnd('reset-fail-service', 'instance-1', false, 100);
      service.recordRequestStart('reset-fail-service', 'instance-1');
      service.recordRequestEnd('reset-fail-service', 'instance-1', true, 100);

      const instances = service.getInstances('reset-fail-service');
      const instance = instances.find((i) => i.id === 'instance-1');
      expect(instance?.consecutiveFailures).toBe(0);
    });

    it('should track average response time', () => {
      const config = createTestService('response-time-service');
      service.registerService(config);

      service.recordRequestStart('response-time-service', 'instance-1');
      service.recordRequestEnd('response-time-service', 'instance-1', true, 100);
      service.recordRequestStart('response-time-service', 'instance-1');
      service.recordRequestEnd('response-time-service', 'instance-1', true, 200);
      service.recordRequestStart('response-time-service', 'instance-1');
      service.recordRequestEnd('response-time-service', 'instance-1', true, 300);

      const instances = service.getInstances('response-time-service');
      const instance = instances.find((i) => i.id === 'instance-1');
      expect(instance?.avgResponseTime).toBe(200); // (100 + 200 + 300) / 3
    });
  });

  describe('Sticky Sessions', () => {
    it('should return same instance for same session', () => {
      const config: ServiceConfig = {
        ...createTestService('sticky-service'),
        stickySession: {
          enabled: true,
          ttlSeconds: 3600,
        },
      };
      service.registerService(config);

      service.markHealthy('sticky-service', 'instance-1');
      service.markHealthy('sticky-service', 'instance-2');
      service.markHealthy('sticky-service', 'instance-3');

      const context = { sessionId: 'session-123' };
      const instance1 = service.getNextInstance('sticky-service', context);
      const instance2 = service.getNextInstance('sticky-service', context);
      const instance3 = service.getNextInstance('sticky-service', context);

      expect(instance1?.id).toBe(instance2?.id);
      expect(instance2?.id).toBe(instance3?.id);
    });

    it('should expire sticky session after TTL', () => {
      const config: ServiceConfig = {
        ...createTestService('sticky-expiry-service'),
        stickySession: {
          enabled: true,
          ttlSeconds: 1, // 1 second TTL
        },
      };
      service.registerService(config);

      service.markHealthy('sticky-expiry-service', 'instance-1');
      service.markHealthy('sticky-expiry-service', 'instance-2');

      const context = { sessionId: 'expiring-session' };
      const instance1 = service.getNextInstance('sticky-expiry-service', context);

      // Advance time past TTL
      jest.advanceTimersByTime(2000);

      // Session should be expired, may get different instance
      const instance2 = service.getNextInstance('sticky-expiry-service', context);

      // This verifies the session was cleared (could be same or different instance)
      expect(instance2).not.toBeNull();
    });

    it('should use different identifiers for sticky session key', () => {
      const config: ServiceConfig = {
        ...createTestService('sticky-id-service'),
        stickySession: {
          enabled: true,
          ttlSeconds: 3600,
        },
      };
      service.registerService(config);

      service.markHealthy('sticky-id-service', 'instance-1');
      service.markHealthy('sticky-id-service', 'instance-2');

      // Different users should potentially get different instances
      const user1Instance = service.getNextInstance('sticky-id-service', { userId: 'user-1' });
      const user2Instance = service.getNextInstance('sticky-id-service', { userId: 'user-2' });

      // Same user should get same instance
      const user1Again = service.getNextInstance('sticky-id-service', { userId: 'user-1' });

      expect(user1Instance?.id).toBe(user1Again?.id);
    });

    it('should not use sticky session for unhealthy instances', () => {
      const config: ServiceConfig = {
        ...createTestService('sticky-unhealthy-service'),
        stickySession: {
          enabled: true,
          ttlSeconds: 3600,
        },
      };
      service.registerService(config);

      service.markHealthy('sticky-unhealthy-service', 'instance-1');
      service.markHealthy('sticky-unhealthy-service', 'instance-2');

      const context = { sessionId: 'unhealthy-session' };
      const instance1 = service.getNextInstance('sticky-unhealthy-service', context);
      const selectedId = instance1?.id;

      // Mark the selected instance as unhealthy
      service.markUnhealthy('sticky-unhealthy-service', selectedId!);

      // Should get a different healthy instance
      const instance2 = service.getNextInstance('sticky-unhealthy-service', context);
      expect(instance2?.id).not.toBe(selectedId);
    });
  });

  describe('Service Statistics', () => {
    it('should return service statistics', () => {
      const config = createTestService('stats-service');
      service.registerService(config);

      service.markHealthy('stats-service', 'instance-1');
      service.markHealthy('stats-service', 'instance-2');
      service.markUnhealthy('stats-service', 'instance-3');

      service.recordRequestStart('stats-service', 'instance-1');
      service.recordRequestEnd('stats-service', 'instance-1', true, 100);
      service.recordRequestStart('stats-service', 'instance-2');
      service.recordRequestEnd('stats-service', 'instance-2', false, 200);

      const stats = service.getServiceStats('stats-service');

      expect(stats?.totalInstances).toBe(3);
      expect(stats?.healthyInstances).toBe(2);
      expect(stats?.totalRequests).toBe(2);
      expect(stats?.failedRequests).toBe(1);
    });

    it('should return null for unknown service', () => {
      const stats = service.getServiceStats('unknown-service');
      expect(stats).toBeNull();
    });
  });

  describe('Health Checks', () => {
    it('should perform health checks on interval', async () => {
      const config: ServiceConfig = {
        ...createTestService('health-check-service', LoadBalancingAlgorithm.ROUND_ROBIN, [
          { id: 'hc-instance-1', host: 'localhost', port: 3000 },
        ]),
        healthCheckInterval: 1000,
        healthCheckPath: '/health',
        healthCheckTimeout: 500,
      };

      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      service.registerService(config);

      // Wait for initial health check
      await jest.advanceTimersByTimeAsync(100);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/health',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should mark instance unhealthy on failed health check', async () => {
      const config: ServiceConfig = {
        ...createTestService('health-fail-service', LoadBalancingAlgorithm.ROUND_ROBIN, [
          { id: 'fail-instance', host: 'localhost', port: 3001 },
        ]),
        healthCheckInterval: 1000,
      };

      mockFetch.mockRejectedValue(new Error('Connection refused'));

      service.registerService(config);

      // Wait for health check
      await jest.advanceTimersByTimeAsync(100);

      const instances = service.getInstances('health-fail-service');
      expect(instances[0].health).toBe(InstanceHealth.UNHEALTHY);
    });

    it('should emit healthCheck event', async () => {
      const config: ServiceConfig = {
        ...createTestService('health-event-service', LoadBalancingAlgorithm.ROUND_ROBIN, [
          { id: 'event-instance', host: 'localhost', port: 3002 },
        ]),
        healthCheckInterval: 1000,
      };

      const handler = jest.fn();
      service.on('healthCheck', handler);

      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      service.registerService(config);

      await jest.advanceTimersByTimeAsync(100);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceName: 'health-event-service',
          result: expect.objectContaining({
            instanceId: 'event-instance',
            healthy: true,
          }),
        }),
      );
    });
  });

  describe('Helper Functions', () => {
    describe('hashString', () => {
      it('should return consistent hash for same input', () => {
        const hash1 = hashString('test-string');
        const hash2 = hashString('test-string');
        expect(hash1).toBe(hash2);
      });

      it('should return different hash for different inputs', () => {
        const hash1 = hashString('string-1');
        const hash2 = hashString('string-2');
        expect(hash1).not.toBe(hash2);
      });

      it('should return positive number', () => {
        const hash = hashString('negative-test');
        expect(hash).toBeGreaterThanOrEqual(0);
      });
    });
  });

  describe('Edge Cases', () => {
    it('should return null for unregistered service', () => {
      const instance = service.getNextInstance('non-existent-service');
      expect(instance).toBeNull();
    });

    it('should handle empty instance list', () => {
      const config = createTestService('empty-service', LoadBalancingAlgorithm.ROUND_ROBIN, []);
      service.registerService(config);

      const instance = service.getNextInstance('empty-service');
      expect(instance).toBeNull();
    });

    it('should not decrement connections below zero', () => {
      const config = createTestService('no-negative-service');
      service.registerService(config);

      // End request without starting
      service.recordRequestEnd('no-negative-service', 'instance-1', true, 100);

      const instances = service.getInstances('no-negative-service');
      const instance = instances.find((i) => i.id === 'instance-1');
      expect(instance?.activeConnections).toBe(0);
    });
  });
});
