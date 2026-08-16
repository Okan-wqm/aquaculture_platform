import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { Response } from 'express';

import { HealthController } from '../../health.controller';
import { HealthService } from '../../health.service';

// Mock response object
const createMockResponse = (): Response => {
  const res = Object.create(null) as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('HealthController', () => {
  let controller: HealthController;

  const mockHealthService = {
    isDraining: jest.fn(),
    checkDatabase: jest.fn(),
    isStartupComplete: jest.fn(),
    getMetrics: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

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
      const result = controller.health();
      expect('memory' in result).toBe(false);
      expect('database' in result).toBe(false);
      expect('smtp' in result).toBe(false);
    });
  });

  describe('GET /health/ready (readiness)', () => {
    it('should return 200 when database is healthy and not draining', async () => {
      const res = createMockResponse();
      mockHealthService.isDraining.mockReturnValue(false);
      mockHealthService.checkDatabase.mockResolvedValue(true);

      await controller.readiness(res);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ok',
          checks: expect.objectContaining({
            database: 'ok',
          }),
        }),
      );
    });

    it('should return 503 when database is down', async () => {
      const res = createMockResponse();
      mockHealthService.isDraining.mockReturnValue(false);
      mockHealthService.checkDatabase.mockResolvedValue(false);

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

      await controller.readiness(res);

      expect(mockHealthService.checkDatabase).not.toHaveBeenCalled();
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
    it('should return system metrics', () => {
      const mockMetrics = {
        uptime: 12345,
        memory: {
          heapUsed: 50000000,
          heapTotal: 100000000,
          external: 1000000,
          rss: 150000000,
        },
        timestamp: new Date().toISOString(),
      };
      mockHealthService.getMetrics.mockReturnValue(mockMetrics);

      const result = controller.metrics();

      expect(result).toEqual(mockMetrics);
      expect(result.uptime).toBe(12345);
      expect(result.memory.heapUsed).toBeDefined();
    });
  });
});
