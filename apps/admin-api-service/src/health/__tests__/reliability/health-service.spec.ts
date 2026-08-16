import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { NatsEventBus } from '@platform/event-bus';

import { GracefulShutdownService } from '../../../lifecycle/graceful-shutdown.service';
import { EmailSenderService } from '../../../settings/services/email-sender.service';
import { HealthService } from '../../health.service';

describe('HealthService', () => {
  let service: HealthService;

  const mockDataSource = {
    query: jest.fn(),
  };

  const mockEmailSenderService = {
    getCircuitStatus: jest.fn(),
  };

  const mockShutdownService = {
    isDraining: jest.fn(),
  };

  const mockEventBus = {
    getHealth: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: EmailSenderService, useValue: mockEmailSenderService },
        { provide: NatsEventBus, useValue: mockEventBus },
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
        providers: [
          HealthService,
          { provide: getDataSourceToken(), useValue: mockDataSource },
          { provide: EmailSenderService, useValue: mockEmailSenderService },
          { provide: NatsEventBus, useValue: mockEventBus },
        ],
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

  describe('checkNats', () => {
    it('returns true only for a healthy connected event bus', async () => {
      mockEventBus.getHealth.mockResolvedValue({
        isHealthy: true,
        connectionState: 'connected',
      });

      await expect(service.checkNats()).resolves.toBe(true);
    });

    it.each([
      { isHealthy: false, connectionState: 'connected' },
      { isHealthy: true, connectionState: 'reconnecting' },
      { isHealthy: true, connectionState: 'disconnected' },
    ])('returns false for non-ready health $connectionState', async (health) => {
      mockEventBus.getHealth.mockResolvedValue(health);

      await expect(service.checkNats()).resolves.toBe(false);
    });

    it('returns false when the health query throws', async () => {
      mockEventBus.getHealth.mockRejectedValue(new Error('broker unavailable'));

      await expect(service.checkNats()).resolves.toBe(false);
    });
  });

  describe('getSmtpStatus', () => {
    it('should return circuit breaker status from email service', () => {
      mockEmailSenderService.getCircuitStatus.mockReturnValue({
        state: 'closed',
        consecutiveFailures: 0,
        lastFailureTime: 0,
      });

      const status = service.getSmtpStatus();

      expect(status.state).toBe('closed');
      expect(status.consecutiveFailures).toBe(0);
    });

    it('should reflect open circuit state', () => {
      mockEmailSenderService.getCircuitStatus.mockReturnValue({
        state: 'open',
        consecutiveFailures: 5,
        lastFailureTime: Date.now(),
      });

      const status = service.getSmtpStatus();

      expect(status.state).toBe('open');
      expect(status.consecutiveFailures).toBe(5);
    });
  });

  describe('getMetrics', () => {
    it('should return process metrics with SMTP status', async () => {
      mockEmailSenderService.getCircuitStatus.mockReturnValue({
        state: 'closed',
        consecutiveFailures: 0,
        lastFailureTime: 0,
      });

      const metrics = await service.getMetrics();

      expect(metrics.uptime).toBeGreaterThan(0);
      expect(metrics.memory).toBeDefined();
      expect(metrics.memory.heapUsed).toBeGreaterThan(0);
      expect(metrics.memory.heapTotal).toBeGreaterThan(0);
      expect(metrics.memory.rss).toBeGreaterThan(0);
      expect(metrics.memory.external).toBeDefined();
      expect(metrics.smtp.state).toBe('closed');
      expect(metrics.timestamp).toBeDefined();
    });
  });
});
