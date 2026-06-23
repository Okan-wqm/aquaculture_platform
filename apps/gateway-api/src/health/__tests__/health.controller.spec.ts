 
 
 
 
 
 
 
 
 
 

/**
 * Gateway Health Controller Tests
 *
 * Tests the standardized health check format:
 *   GET /health/live   -> { status: 'ok' }
 *   GET /health/ready  -> { status, checks: { downstream } } via @Res()
 *   GET /health        -> { status, timestamp, uptime, version }
 *   GET /health/detail -> Full HealthStatus (auth required)
 *   GET /health/ping   -> { message: 'pong', timestamp }
 */

import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { HealthController } from '../health.controller';
import { HealthService, HealthStatus, ServiceHealth } from '../health.service';

// Mock response object
const createMockResponse = () => {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
};

/**
 * Create mock health status
 */
const createMockHealthStatus = (
  overrides: Partial<HealthStatus> = {},
): HealthStatus => ({
  status: 'healthy',
  // HealthStatus.timestamp was widened to ISO 8601 string (see
  // health.service.ts:22). ServiceHealth.lastChecked stays Date.
  timestamp: new Date().toISOString(),
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

describe('HealthController', () => {
  let controller: HealthController;
  let healthService: jest.Mocked<HealthService>;

  beforeEach(async () => {
    const mockHealthService = {
      getLiveness: jest.fn(),
      getReadiness: jest.fn(),
      getHealth: jest.fn(),
      getPublicHealth: jest.fn(),
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
    it('should return ok status', () => {
      const result = controller.liveness();
      expect(result).toEqual({ status: 'ok' });
    });

    it('should always succeed regardless of downstream services', () => {
      const result = controller.liveness();
      expect(result.status).toBe('ok');
    });
  });

  describe('readiness', () => {
    it('should return 200 with ok when services are ready', async () => {
      healthService.getReadiness.mockResolvedValue({ status: 'ok' });
      const res = createMockResponse();

      await controller.readiness(res);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
      expect(res.json).toHaveBeenCalledWith({
        status: 'ok',
        checks: { downstream: 'ok' },
      });
    });

    it('should return 503 when not ready', async () => {
      healthService.getReadiness.mockResolvedValue({
        status: 'not_ready',
        message: 'Auth service is unavailable',
      });
      const res = createMockResponse();

      await controller.readiness(res);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(res.json).toHaveBeenCalledWith({
        status: 'not_ready',
        checks: { downstream: 'error' },
      });
    });
  });

  describe('health', () => {
    it('should return standardized health response', () => {
      const result = controller.health();

      expect(result.status).toBe('ok');
      expect(result.timestamp).toBeDefined();
      expect(typeof result.uptime).toBe('number');
      expect(result.version).toBeDefined();
    });

    it('should include valid ISO timestamp', () => {
      const result = controller.health();
      const timestamp = new Date(result.timestamp);
      expect(timestamp.toISOString()).toBe(result.timestamp);
    });

    it('should not expose sensitive data', () => {
      const result = controller.health() as unknown as Record<string, unknown>;
      expect(result).not.toHaveProperty('memory');
      expect(result).not.toHaveProperty('services');
    });
  });

  describe('healthDetail', () => {
    it('should return comprehensive health status', async () => {
      const mockStatus = createMockHealthStatus();
      healthService.getHealth.mockResolvedValue(mockStatus);

      const result = await controller.healthDetail();

      expect(result).toEqual(mockStatus);
      expect(result).toHaveProperty('services');
      expect(result).toHaveProperty('memory');
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
  });

  describe('Controller Decorators', () => {
    it('should be decorated with @Controller("health")', () => {
      const controllerPath = Reflect.getMetadata('path', HealthController) as string;
      expect(controllerPath).toBe('health');
    });
  });
});
