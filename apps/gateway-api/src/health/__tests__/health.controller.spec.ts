/**
 * Health Controller Tests
 *
 * Comprehensive test suite for health check endpoints
 */

import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { HealthController } from '../health.controller';
import { HealthService, HealthStatus, ServiceHealth } from '../health.service';

describe('HealthController', () => {
  let controller: HealthController;
  let healthService: jest.Mocked<HealthService>;

  /**
   * Create mock health status
   */
  const createMockHealthStatus = (
    overrides: Partial<HealthStatus> = {},
  ): HealthStatus => ({
    status: 'healthy',
    timestamp: new Date(),
    uptime: 123456,
    version: '1.0.0',
    services: [
      {
        name: 'auth',
        status: 'healthy',
        url: 'http://auth:3001/graphql',
        responseTime: 50,
        lastChecked: new Date(),
      },
      {
        name: 'farm',
        status: 'healthy',
        url: 'http://farm:3002/graphql',
        responseTime: 45,
        lastChecked: new Date(),
      },
    ],
    memory: {
      heapUsed: 50000000,
      heapTotal: 100000000,
      external: 5000000,
      rss: 120000000,
    },
    ...overrides,
  });

  /**
   * Create mock service health
   */
  const createMockServiceHealth = (
    overrides: Partial<ServiceHealth> = {},
  ): ServiceHealth => ({
    name: 'auth',
    status: 'healthy',
    url: 'http://auth:3001/graphql',
    responseTime: 50,
    lastChecked: new Date(),
    ...overrides,
  });

  beforeEach(async () => {
    const mockHealthService = {
      getLiveness: jest.fn(),
      getReadiness: jest.fn(),
      getHealth: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthService,
          useValue: mockHealthService,
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
    healthService = module.get(HealthService);
  });

  describe('liveness', () => {
    it('should return ok status', async () => {
      healthService.getLiveness.mockResolvedValue({ status: 'ok' });

      const result = await controller.liveness();

      expect(result).toEqual({ status: 'ok' });
    });

    it('should call healthService.getLiveness', async () => {
      healthService.getLiveness.mockResolvedValue({ status: 'ok' });

      await controller.liveness();

      expect(healthService.getLiveness).toHaveBeenCalledTimes(1);
    });

    it('should always succeed regardless of downstream services', async () => {
      healthService.getLiveness.mockResolvedValue({ status: 'ok' });

      const result = await controller.liveness();

      expect(result.status).toBe('ok');
    });
  });

  describe('readiness', () => {
    it('should return ok when ready', async () => {
      healthService.getReadiness.mockResolvedValue({ status: 'ok' });

      const result = await controller.readiness();

      expect(result).toEqual({ status: 'ok' });
    });

    it('should throw ServiceUnavailableException when not ready', async () => {
      healthService.getReadiness.mockResolvedValue({
        status: 'not_ready',
        message: 'Auth service is unavailable',
      });

      await expect(controller.readiness()).rejects.toThrow();
    });

    it('should include error message when not ready', async () => {
      healthService.getReadiness.mockResolvedValue({
        status: 'not_ready',
        message: 'Auth service is unavailable',
      });

      try {
        await controller.readiness();
        fail('Expected exception to be thrown');
      } catch (error: any) {
        expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        expect(error.getResponse().message).toBe('Auth service is unavailable');
      }
    });

    it('should return 503 when not ready', async () => {
      healthService.getReadiness.mockResolvedValue({
        status: 'not_ready',
        message: 'Database connection failed',
      });

      try {
        await controller.readiness();
        fail('Expected exception to be thrown');
      } catch (error: any) {
        expect(error.getStatus()).toBe(503);
      }
    });

    it('should call healthService.getReadiness', async () => {
      healthService.getReadiness.mockResolvedValue({ status: 'ok' });

      await controller.readiness();

      expect(healthService.getReadiness).toHaveBeenCalledTimes(1);
    });
  });

  describe('health', () => {
    it('should return comprehensive health status', async () => {
      const mockStatus = createMockHealthStatus();
      healthService.getHealth.mockResolvedValue(mockStatus);

      const result = await controller.health();

      expect(result).toEqual(mockStatus);
    });

    it('should include all service statuses', async () => {
      const mockStatus = createMockHealthStatus({
        services: [
          createMockServiceHealth({ name: 'auth', status: 'healthy' }),
          createMockServiceHealth({ name: 'farm', status: 'degraded' }),
          createMockServiceHealth({ name: 'sensor', status: 'unhealthy' }),
        ],
      });
      healthService.getHealth.mockResolvedValue(mockStatus);

      const result = await controller.health();

      expect(result.services).toHaveLength(3);
      expect(result.services.map((s) => s.name)).toEqual(['auth', 'farm', 'sensor']);
    });

    it('should include memory information', async () => {
      const mockStatus = createMockHealthStatus();
      healthService.getHealth.mockResolvedValue(mockStatus);

      const result = await controller.health();

      expect(result.memory).toBeDefined();
      expect(result.memory.heapUsed).toBeGreaterThan(0);
      expect(result.memory.heapTotal).toBeGreaterThan(0);
      expect(result.memory.rss).toBeGreaterThan(0);
    });

    it('should include uptime', async () => {
      const mockStatus = createMockHealthStatus({ uptime: 3600000 });
      healthService.getHealth.mockResolvedValue(mockStatus);

      const result = await controller.health();

      expect(result.uptime).toBe(3600000);
    });

    it('should include version', async () => {
      const mockStatus = createMockHealthStatus({ version: '2.0.0' });
      healthService.getHealth.mockResolvedValue(mockStatus);

      const result = await controller.health();

      expect(result.version).toBe('2.0.0');
    });

    it('should call healthService.getHealth', async () => {
      healthService.getHealth.mockResolvedValue(createMockHealthStatus());

      await controller.health();

      expect(healthService.getHealth).toHaveBeenCalledTimes(1);
    });

    it('should return healthy status when all services healthy', async () => {
      const mockStatus = createMockHealthStatus({ status: 'healthy' });
      healthService.getHealth.mockResolvedValue(mockStatus);

      const result = await controller.health();

      expect(result.status).toBe('healthy');
    });

    it('should return degraded status when some services degraded', async () => {
      const mockStatus = createMockHealthStatus({ status: 'degraded' });
      healthService.getHealth.mockResolvedValue(mockStatus);

      const result = await controller.health();

      expect(result.status).toBe('degraded');
    });

    it('should return unhealthy status when most services unhealthy', async () => {
      const mockStatus = createMockHealthStatus({ status: 'unhealthy' });
      healthService.getHealth.mockResolvedValue(mockStatus);

      const result = await controller.health();

      expect(result.status).toBe('unhealthy');
    });
  });

  describe('ping', () => {
    it('should return pong message', () => {
      const result = controller.ping();

      expect(result.message).toBe('pong');
    });

    it('should include timestamp in ISO format', () => {
      const beforeTime = new Date().toISOString();
      const result = controller.ping();
      const afterTime = new Date().toISOString();

      expect(result.timestamp).toBeDefined();
      expect(result.timestamp >= beforeTime).toBe(true);
      expect(result.timestamp <= afterTime).toBe(true);
    });

    it('should not call health service', () => {
      controller.ping();

      expect(healthService.getLiveness).not.toHaveBeenCalled();
      expect(healthService.getReadiness).not.toHaveBeenCalled();
      expect(healthService.getHealth).not.toHaveBeenCalled();
    });

    it('should return consistent structure', () => {
      const result = controller.ping();

      expect(result).toHaveProperty('message');
      expect(result).toHaveProperty('timestamp');
      expect(typeof result.message).toBe('string');
      expect(typeof result.timestamp).toBe('string');
    });
  });

  describe('Controller Decorators', () => {
    it('should be decorated with @Controller("health")', () => {
      const controllerPath = Reflect.getMetadata('path', HealthController);
      expect(controllerPath).toBe('health');
    });

    it('should have liveness endpoint at GET /health/live', () => {
      const path = Reflect.getMetadata('path', HealthController.prototype.liveness);
      const method = Reflect.getMetadata('method', HealthController.prototype.liveness);
      expect(path).toBe('live');
    });

    it('should have readiness endpoint at GET /health/ready', () => {
      const path = Reflect.getMetadata('path', HealthController.prototype.readiness);
      expect(path).toBe('ready');
    });

    it('should have health endpoint at GET /health', () => {
      const path = Reflect.getMetadata('path', HealthController.prototype.health);
      expect(path).toBe('/');
    });

    it('should have ping endpoint at GET /health/ping', () => {
      const path = Reflect.getMetadata('path', HealthController.prototype.ping);
      expect(path).toBe('ping');
    });
  });

  describe('Response Format', () => {
    it('liveness should return minimal response', async () => {
      healthService.getLiveness.mockResolvedValue({ status: 'ok' });

      const result = await controller.liveness();

      expect(Object.keys(result)).toEqual(['status']);
    });

    it('readiness should return status and optional message', async () => {
      healthService.getReadiness.mockResolvedValue({ status: 'ok' });

      const result = await controller.readiness();

      expect(result).toHaveProperty('status');
    });

    it('health should return complete health status object', async () => {
      healthService.getHealth.mockResolvedValue(createMockHealthStatus());

      const result = await controller.health();

      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('uptime');
      expect(result).toHaveProperty('version');
      expect(result).toHaveProperty('services');
      expect(result).toHaveProperty('memory');
    });

    it('ping should return message and timestamp', () => {
      const result = controller.ping();

      expect(Object.keys(result).sort()).toEqual(['message', 'timestamp']);
    });
  });

  describe('Error Handling', () => {
    it('should propagate errors from getLiveness', async () => {
      healthService.getLiveness.mockRejectedValue(new Error('Internal error'));

      await expect(controller.liveness()).rejects.toThrow('Internal error');
    });

    it('should propagate errors from getReadiness', async () => {
      healthService.getReadiness.mockRejectedValue(new Error('Internal error'));

      await expect(controller.readiness()).rejects.toThrow('Internal error');
    });

    it('should propagate errors from getHealth', async () => {
      healthService.getHealth.mockRejectedValue(new Error('Internal error'));

      await expect(controller.health()).rejects.toThrow('Internal error');
    });
  });

  describe('Kubernetes Integration', () => {
    it('liveness should be suitable for livenessProbe', async () => {
      healthService.getLiveness.mockResolvedValue({ status: 'ok' });

      const result = await controller.liveness();

      // Should return quickly and simply
      expect(result).toEqual({ status: 'ok' });
    });

    it('readiness should be suitable for readinessProbe', async () => {
      healthService.getReadiness.mockResolvedValue({ status: 'ok' });

      const result = await controller.readiness();

      // Should indicate if service is ready for traffic
      expect(result.status).toBe('ok');
    });

    it('readiness should return 503 when dependencies unavailable', async () => {
      healthService.getReadiness.mockResolvedValue({
        status: 'not_ready',
        message: 'Dependencies unavailable',
      });

      try {
        await controller.readiness();
        fail('Should have thrown');
      } catch (error: any) {
        expect(error.getStatus()).toBe(503);
      }
    });
  });

  describe('Service Health Details', () => {
    it('should include response times for services', async () => {
      const mockStatus = createMockHealthStatus({
        services: [
          createMockServiceHealth({ name: 'auth', responseTime: 50 }),
          createMockServiceHealth({ name: 'farm', responseTime: 100 }),
        ],
      });
      healthService.getHealth.mockResolvedValue(mockStatus);

      const result = await controller.health();

      expect(result.services[0]?.responseTime).toBe(50);
      expect(result.services[1]?.responseTime).toBe(100);
    });

    it('should include error messages for unhealthy services', async () => {
      const mockStatus = createMockHealthStatus({
        services: [
          createMockServiceHealth({
            name: 'auth',
            status: 'unhealthy',
            error: 'Connection refused',
          }),
        ],
      });
      healthService.getHealth.mockResolvedValue(mockStatus);

      const result = await controller.health();

      expect(result.services[0]?.error).toBe('Connection refused');
    });

    it('should include lastChecked for services', async () => {
      const checkTime = new Date();
      const mockStatus = createMockHealthStatus({
        services: [
          createMockServiceHealth({ name: 'auth', lastChecked: checkTime }),
        ],
      });
      healthService.getHealth.mockResolvedValue(mockStatus);

      const result = await controller.health();

      expect(result.services[0]?.lastChecked).toEqual(checkTime);
    });
  });

  describe('Memory Stats', () => {
    it('should include all memory metrics', async () => {
      const mockStatus = createMockHealthStatus({
        memory: {
          heapUsed: 50000000,
          heapTotal: 100000000,
          external: 5000000,
          rss: 150000000,
        },
      });
      healthService.getHealth.mockResolvedValue(mockStatus);

      const result = await controller.health();

      expect(result.memory.heapUsed).toBe(50000000);
      expect(result.memory.heapTotal).toBe(100000000);
      expect(result.memory.external).toBe(5000000);
      expect(result.memory.rss).toBe(150000000);
    });
  });

  describe('Concurrent Requests', () => {
    it('should handle multiple concurrent liveness checks', async () => {
      healthService.getLiveness.mockResolvedValue({ status: 'ok' });

      const promises = Array(10)
        .fill(null)
        .map(() => controller.liveness());

      const results = await Promise.all(promises);

      results.forEach((result) => {
        expect(result).toEqual({ status: 'ok' });
      });
    });

    it('should handle multiple concurrent health checks', async () => {
      healthService.getHealth.mockResolvedValue(createMockHealthStatus());

      const promises = Array(5)
        .fill(null)
        .map(() => controller.health());

      const results = await Promise.all(promises);

      results.forEach((result) => {
        expect(result.status).toBe('healthy');
      });
    });
  });
});
