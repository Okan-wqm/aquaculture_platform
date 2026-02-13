import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';

import { GracefulShutdownService } from '../../graceful-shutdown.service';

describe('GracefulShutdownService', () => {
  let service: GracefulShutdownService;

  const mockDataSource = {
    isInitialized: true,
    destroy: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GracefulShutdownService,
        { provide: getDataSourceToken(), useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<GracefulShutdownService>(GracefulShutdownService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('isDraining', () => {
    it('should return false initially', () => {
      expect(service.isDraining()).toBe(false);
    });

    it('should return true after beforeApplicationShutdown is called', async () => {
      // Start the shutdown (non-blocking, will wait on timer)
      const shutdownPromise = service.beforeApplicationShutdown('SIGTERM');

      // Should immediately be draining
      expect(service.isDraining()).toBe(true);

      // Advance timers to complete drain period
      jest.advanceTimersByTime(10_000);
      await shutdownPromise;
    });
  });

  describe('beforeApplicationShutdown', () => {
    it('should set draining flag on SIGTERM', async () => {
      const promise = service.beforeApplicationShutdown('SIGTERM');
      expect(service.isDraining()).toBe(true);

      jest.advanceTimersByTime(10_000);
      await promise;
    });

    it('should set draining flag on SIGINT', async () => {
      const promise = service.beforeApplicationShutdown('SIGINT');
      expect(service.isDraining()).toBe(true);

      jest.advanceTimersByTime(10_000);
      await promise;
    });

    it('should handle undefined signal', async () => {
      const promise = service.beforeApplicationShutdown(undefined);
      expect(service.isDraining()).toBe(true);

      jest.advanceTimersByTime(10_000);
      await promise;
    });

    it('should wait for drain timeout before resolving', async () => {
      let resolved = false;
      const promise = service.beforeApplicationShutdown('SIGTERM').then(() => {
        resolved = true;
      });

      // Should not be resolved before drain timeout
      jest.advanceTimersByTime(5_000);
      await Promise.resolve(); // flush microtasks
      expect(resolved).toBe(false);

      // Should resolve after drain timeout
      jest.advanceTimersByTime(5_000);
      await promise;
      expect(resolved).toBe(true);
    });
  });

  describe('onApplicationShutdown', () => {
    it('should close database connection pool', async () => {
      mockDataSource.isInitialized = true;
      mockDataSource.destroy.mockResolvedValue(undefined);

      await service.onApplicationShutdown('SIGTERM');

      expect(mockDataSource.destroy).toHaveBeenCalledTimes(1);
    });

    it('should not close database if not initialized', async () => {
      mockDataSource.isInitialized = false;

      await service.onApplicationShutdown('SIGTERM');

      expect(mockDataSource.destroy).not.toHaveBeenCalled();
    });

    it('should handle database close errors gracefully', async () => {
      mockDataSource.isInitialized = true;
      mockDataSource.destroy.mockRejectedValue(new Error('Pool close error'));

      // Should not throw
      await expect(
        service.onApplicationShutdown('SIGTERM'),
      ).resolves.not.toThrow();
    });

    it('should handle undefined signal', async () => {
      mockDataSource.isInitialized = true;
      mockDataSource.destroy.mockResolvedValue(undefined);

      await service.onApplicationShutdown(undefined);

      expect(mockDataSource.destroy).toHaveBeenCalled();
    });
  });

  describe('full shutdown sequence', () => {
    it('should drain first, then close connections', async () => {
      mockDataSource.isInitialized = true;
      mockDataSource.destroy.mockResolvedValue(undefined);

      const callOrder: string[] = [];

      // Track drain start
      const drainPromise = service.beforeApplicationShutdown('SIGTERM');
      callOrder.push('drain-start');
      expect(service.isDraining()).toBe(true);

      // Complete drain
      jest.advanceTimersByTime(10_000);
      await drainPromise;
      callOrder.push('drain-complete');

      // Then close connections
      await service.onApplicationShutdown('SIGTERM');
      callOrder.push('shutdown-complete');

      expect(callOrder).toEqual([
        'drain-start',
        'drain-complete',
        'shutdown-complete',
      ]);
      expect(mockDataSource.destroy).toHaveBeenCalledTimes(1);
    });
  });
});
