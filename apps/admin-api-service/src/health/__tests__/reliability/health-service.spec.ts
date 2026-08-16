import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';

import { GracefulShutdownService } from '../../../lifecycle/graceful-shutdown.service';
import { HealthService } from '../../health.service';

describe('HealthService', () => {
  let service: HealthService;

  const mockDataSource = {
    query: jest.fn(),
  };

  const mockShutdownService = {
    isDraining: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: GracefulShutdownService, useValue: mockShutdownService },
      ],
    }).compile();

    service = module.get<HealthService>(HealthService);
  });

  describe('startup tracking', () => {
    it('should start with startup incomplete', () => {
      expect(service.isStartupComplete()).toBe(false);
    });

    it('should mark startup as complete', () => {
      service.markStartupComplete();
      expect(service.isStartupComplete()).toBe(true);
    });

    it('should remain complete after multiple calls', () => {
      service.markStartupComplete();
      service.markStartupComplete();
      expect(service.isStartupComplete()).toBe(true);
    });
  });

  describe('isDraining', () => {
    it('should delegate to GracefulShutdownService', () => {
      mockShutdownService.isDraining.mockReturnValue(true);
      expect(service.isDraining()).toBe(true);

      mockShutdownService.isDraining.mockReturnValue(false);
      expect(service.isDraining()).toBe(false);
    });

    it('should return false when shutdown service is not injected', async () => {
      // Recreate without GracefulShutdownService (it's @Optional)
      const module: TestingModule = await Test.createTestingModule({
        providers: [HealthService, { provide: getDataSourceToken(), useValue: mockDataSource }],
      }).compile();

      const serviceWithoutShutdown = module.get<HealthService>(HealthService);
      expect(serviceWithoutShutdown.isDraining()).toBe(false);
    });
  });

  describe('checkDatabase', () => {
    it('should return true when SELECT 1 succeeds', async () => {
      mockDataSource.query.mockResolvedValue([{ '?column?': 1 }]);

      const result = await service.checkDatabase();

      expect(result).toBe(true);
      expect(mockDataSource.query).toHaveBeenCalledWith('SELECT 1');
    });

    it('should return false when database query fails', async () => {
      mockDataSource.query.mockRejectedValue(new Error('Connection refused'));

      const result = await service.checkDatabase();

      expect(result).toBe(false);
    });

    it('should return false on timeout', async () => {
      mockDataSource.query.mockRejectedValue(new Error('Query timeout'));

      const result = await service.checkDatabase();

      expect(result).toBe(false);
    });
  });

  describe('getMetrics', () => {
    it('should return process metrics without owning downstream health', () => {
      const metrics = service.getMetrics();

      expect(metrics.uptime).toBeGreaterThan(0);
      expect(metrics.memory).toBeDefined();
      expect(metrics.memory.heapUsed).toBeGreaterThan(0);
      expect(metrics.memory.heapTotal).toBeGreaterThan(0);
      expect(metrics.memory.rss).toBeGreaterThan(0);
      expect(metrics.memory.external).toBeDefined();
      expect(metrics.timestamp).toBeDefined();
    });
  });
});
