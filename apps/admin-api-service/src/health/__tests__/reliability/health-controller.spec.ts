import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { HealthController } from '../../health.controller';
import { HealthService } from '../../health.service';

// Mock response object
const createMockResponse = () => {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    getHeader: jest.fn().mockReturnValue('health-test-request'),
    setHeader: jest.fn().mockReturnThis(),
  };
  return res;
};

describe('HealthController', () => {
  let controller: HealthController;

  const mockHealthService = {
    isDraining: jest.fn(),
    checkDatabase: jest.fn(),
    checkNats: jest.fn(),
    getSmtpStatus: jest.fn(),
    isStartupComplete: jest.fn(),
    getMetrics: jest.fn(),
    getCircuitBreakers: jest.fn(),
    resetCircuitBreaker: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockHealthService.checkNats.mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: HealthService, useValue: mockHealthService }],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  describe('GET /health/live (liveness)', () => {
    it('should return 200 with ok status', () => {
      const result = controller.liveness();

      expect(result).toEqual({ status: 'ok' });
    });
  });

  describe('GET /health (general health)', () => {
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
      expect(result).not.toHaveProperty('database');
      expect(result).not.toHaveProperty('smtp');
    });
  });

  describe('GET /health/ready (readiness)', () => {
    it('should return 200 when database is healthy and not draining', async () => {
      const res = createMockResponse();
      mockHealthService.isDraining.mockReturnValue(false);
      mockHealthService.checkDatabase.mockResolvedValue(true);
      mockHealthService.getSmtpStatus.mockReturnValue({
        state: 'closed',
        consecutiveFailures: 0,
      });

      await controller.readiness(res);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ok',
          checks: expect.objectContaining({
            database: 'ok',
            nats: 'ok',
            smtp: 'ok',
          }),
        }),
      );
    });

    it('should return 503 when NATS is unavailable', async () => {
      const res = createMockResponse();
      mockHealthService.isDraining.mockReturnValue(false);
      mockHealthService.checkDatabase.mockResolvedValue(true);
      mockHealthService.checkNats.mockResolvedValue(false);
      mockHealthService.getSmtpStatus.mockReturnValue({
        state: 'closed',
        consecutiveFailures: 0,
      });

      await controller.readiness(res);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'not_ready',
          checks: expect.objectContaining({ nats: 'error' }),
        }),
      );
    });

    it('should return 503 when database is down', async () => {
      const res = createMockResponse();
      mockHealthService.isDraining.mockReturnValue(false);
      mockHealthService.checkDatabase.mockResolvedValue(false);
      mockHealthService.getSmtpStatus.mockReturnValue({
        state: 'closed',
        consecutiveFailures: 0,
      });

      await controller.readiness(res);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'not_ready',
          checks: expect.objectContaining({ database: 'error' }),
        }),
      );
    });

    it('should return 503 when service is draining', async () => {
      const res = createMockResponse();
      mockHealthService.isDraining.mockReturnValue(true);
      mockHealthService.getSmtpStatus.mockReturnValue({
        state: 'closed',
        consecutiveFailures: 0,
      });

      await controller.readiness(res);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'not_ready',
          checks: expect.objectContaining({ draining: 'error' }),
        }),
      );
    });

    it('should skip database check when draining', async () => {
      const res = createMockResponse();
      mockHealthService.isDraining.mockReturnValue(true);
      mockHealthService.getSmtpStatus.mockReturnValue({
        state: 'closed',
        consecutiveFailures: 0,
      });

      await controller.readiness(res);

      expect(mockHealthService.checkDatabase).not.toHaveBeenCalled();
      expect(mockHealthService.checkNats).not.toHaveBeenCalled();
    });

    it('should report SMTP error when circuit is open', async () => {
      const res = createMockResponse();
      mockHealthService.isDraining.mockReturnValue(false);
      mockHealthService.checkDatabase.mockResolvedValue(true);
      mockHealthService.getSmtpStatus.mockReturnValue({
        state: 'open',
        consecutiveFailures: 5,
      });

      await controller.readiness(res);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          checks: expect.objectContaining({ smtp: 'error' }),
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
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }));
    });

    it('should return 503 when startup is not complete', () => {
      const res = createMockResponse();
      mockHealthService.isStartupComplete.mockReturnValue(false);

      controller.startup(res);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'not_ready' }));
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
