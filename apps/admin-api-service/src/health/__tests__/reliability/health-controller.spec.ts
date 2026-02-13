import { HttpStatus } from '@nestjs/common';
import {
  HealthCheckService,
  TypeOrmHealthIndicator,
  MemoryHealthIndicator,
  HealthCheckResult,
} from '@nestjs/terminus';
import { Test, TestingModule } from '@nestjs/testing';

import { HealthController } from '../../health.controller';
import { HealthService } from '../../health.service';

// Mock response object
const createMockResponse = () => {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
};

describe('HealthController', () => {
  let controller: HealthController;
  let healthCheckService: HealthCheckService;
  let healthService: HealthService;

  const mockHealthCheckService = {
    check: jest.fn(),
  };

  const mockDbIndicator = {
    pingCheck: jest.fn(),
  };

  const mockMemoryIndicator = {
    checkHeap: jest.fn(),
    checkRSS: jest.fn(),
  };

  const mockHealthService = {
    isDraining: jest.fn(),
    checkDatabase: jest.fn(),
    getSmtpStatus: jest.fn(),
    isStartupComplete: jest.fn(),
    getMetrics: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: HealthCheckService, useValue: mockHealthCheckService },
        { provide: TypeOrmHealthIndicator, useValue: mockDbIndicator },
        { provide: MemoryHealthIndicator, useValue: mockMemoryIndicator },
        { provide: HealthService, useValue: mockHealthService },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
    healthCheckService = module.get<HealthCheckService>(HealthCheckService);
    healthService = module.get<HealthService>(HealthService);
  });

  describe('GET /health (check)', () => {
    it('should return healthy status when all checks pass', async () => {
      const healthyResult: HealthCheckResult = {
        status: 'ok',
        info: {
          database: { status: 'up' },
          memory_heap: { status: 'up' },
          memory_rss: { status: 'up' },
        },
        error: {},
        details: {
          database: { status: 'up' },
          memory_heap: { status: 'up' },
          memory_rss: { status: 'up' },
        },
      };
      mockHealthCheckService.check.mockResolvedValue(healthyResult);

      const result = await controller.check();

      expect(result.status).toBe('ok');
      expect(mockHealthCheckService.check).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.any(Function),
          expect.any(Function),
          expect.any(Function),
        ]),
      );
    });

    it('should propagate terminus error when DB is down', async () => {
      mockHealthCheckService.check.mockRejectedValue(
        new Error('Health Check has failed'),
      );

      await expect(controller.check()).rejects.toThrow(
        'Health Check has failed',
      );
    });
  });

  describe('GET /health/live (liveness)', () => {
    it('should return 200 with ok status', () => {
      const result = controller.liveness();

      expect(result.status).toBe('ok');
      expect(result.timestamp).toBeDefined();
      expect(new Date(result.timestamp).getTime()).not.toBeNaN();
    });
  });

  describe('GET /health/ready (readiness)', () => {
    it('should return 200 when database is healthy and not draining', async () => {
      const res = createMockResponse();
      mockHealthService.isDraining.mockReturnValue(false);
      mockHealthService.checkDatabase.mockResolvedValue(true);
      mockHealthService.getSmtpStatus.mockReturnValue({ state: 'closed', consecutiveFailures: 0 });

      await controller.readiness(res);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ok',
          checks: expect.objectContaining({
            database: true,
            smtp: 'closed',
          }),
        }),
      );
    });

    it('should return 503 when database is down', async () => {
      const res = createMockResponse();
      mockHealthService.isDraining.mockReturnValue(false);
      mockHealthService.checkDatabase.mockResolvedValue(false);
      mockHealthService.getSmtpStatus.mockReturnValue({ state: 'closed', consecutiveFailures: 0 });

      await controller.readiness(res);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'not_ready',
          checks: expect.objectContaining({ database: false }),
        }),
      );
    });

    it('should return 503 when service is draining', async () => {
      const res = createMockResponse();
      mockHealthService.isDraining.mockReturnValue(true);
      mockHealthService.getSmtpStatus.mockReturnValue({ state: 'closed', consecutiveFailures: 0 });

      await controller.readiness(res);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'not_ready',
          checks: expect.objectContaining({ draining: true }),
        }),
      );
    });

    it('should skip database check when draining', async () => {
      const res = createMockResponse();
      mockHealthService.isDraining.mockReturnValue(true);
      mockHealthService.getSmtpStatus.mockReturnValue({ state: 'closed', consecutiveFailures: 0 });

      await controller.readiness(res);

      expect(mockHealthService.checkDatabase).not.toHaveBeenCalled();
    });

    it('should include SMTP circuit breaker state in readiness', async () => {
      const res = createMockResponse();
      mockHealthService.isDraining.mockReturnValue(false);
      mockHealthService.checkDatabase.mockResolvedValue(true);
      mockHealthService.getSmtpStatus.mockReturnValue({ state: 'open', consecutiveFailures: 5 });

      await controller.readiness(res);

      // Service is still ready even if SMTP is open — SMTP is not a hard dependency
      expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          checks: expect.objectContaining({ smtp: 'open' }),
        }),
      );
    });
  });

  describe('GET /health/startup (startup probe)', () => {
    it('should return 200 when startup is complete', () => {
      const res = createMockResponse();
      mockHealthService.isStartupComplete.mockReturnValue(true);

      controller.startup(res);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'started' }),
      );
    });

    it('should return 503 when startup is not complete', () => {
      const res = createMockResponse();
      mockHealthService.isStartupComplete.mockReturnValue(false);

      controller.startup(res);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'starting' }),
      );
    });
  });

  describe('GET /health/metrics', () => {
    it('should return system metrics', async () => {
      const mockMetrics = {
        uptime: 12345,
        memory: {
          heapUsed: 50000000,
          heapTotal: 100000000,
          external: 1000000,
          rss: 150000000,
        },
        smtp: { state: 'closed', consecutiveFailures: 0 },
        timestamp: new Date().toISOString(),
      };
      mockHealthService.getMetrics.mockResolvedValue(mockMetrics);

      const result = await controller.metrics();

      expect(result).toEqual(mockMetrics);
      expect(result.uptime).toBe(12345);
      expect(result.memory.heapUsed).toBeDefined();
    });
  });
});
