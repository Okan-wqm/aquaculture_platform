/* eslint-disable @typescript-eslint/no-dynamic-delete */
/* eslint-disable @typescript-eslint/no-empty-function */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

/**
 * Circuit Breaker Service Tests
 *
 * Comprehensive test suite for circuit breaker functionality
 */

import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

import {
  CircuitBreakerService,
  CircuitState,
  WithCircuitBreaker,
} from '../circuit-breaker.service';

describe('CircuitBreakerService', () => {
  let service: CircuitBreakerService;

  const defaultConfig = {
    CIRCUIT_FAILURE_THRESHOLD: 5,
    CIRCUIT_SUCCESS_THRESHOLD: 3,
    CIRCUIT_TIMEOUT: 30000,
    CIRCUIT_VOLUME_THRESHOLD: 10,
    CIRCUIT_FAILURE_RATE: 50,
    CIRCUIT_SLOW_CALL_THRESHOLD: 5000,
    CIRCUIT_SLOW_CALL_RATE: 80,
    CIRCUIT_HALF_OPEN_REQUESTS: 3,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CircuitBreakerService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => {
              return defaultConfig[key as keyof typeof defaultConfig] ?? defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<CircuitBreakerService>(CircuitBreakerService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Circuit States', () => {
    it('should start in closed state for new circuits', () => {
      expect(service.getCircuitState('test-service')).toBe(CircuitState.CLOSED);
    });

    it('should return correct state for registered circuit', () => {
      service.registerCircuit('registered-service');
      expect(service.getCircuitState('registered-service')).toBe(CircuitState.CLOSED);
    });
  });

  describe('execute', () => {
    it('should execute function when circuit is closed', async () => {
      const fn = jest.fn().mockResolvedValue('success');

      const result = await service.execute('test-service', fn);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalled();
    });

    it('should record success on successful execution', async () => {
      const fn = jest.fn().mockResolvedValue('success');

      await service.execute('success-service', fn);

      const stats = service.getCircuitStats('success-service');
      expect(stats?.successCount).toBe(1);
    });

    it('should record failure on failed execution', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('failure'));

      await expect(service.execute('failure-service', fn)).rejects.toThrow('failure');

      const stats = service.getCircuitStats('failure-service');
      expect(stats?.failureCount).toBe(1);
    });

    it('should call fallback on failure when provided', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('failure'));
      const fallback = jest.fn().mockReturnValue('fallback-result');

      const result: unknown = await service.execute('fallback-service', fn, { fallback });

      expect(result).toBe('fallback-result');
      expect(fallback).toHaveBeenCalledWith(expect.any(Error), 'fallback-service');
    });

    it('should throw when circuit is open and no fallback', async () => {
      service.forceOpen('open-service');

      const fn = jest.fn().mockResolvedValue('success');

      await expect(service.execute('open-service', fn)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('should call fallback when circuit is open', async () => {
      service.registerCircuit('open-fallback-service');
      service.forceOpen('open-fallback-service');

      const fn = jest.fn().mockResolvedValue('success');
      const fallback = jest.fn().mockReturnValue('fallback');

      const result: unknown = await service.execute('open-fallback-service', fn, { fallback });

      expect(result).toBe('fallback');
      expect(fn).not.toHaveBeenCalled();
    });

    it('should respect timeout option', async () => {
      const fn = jest.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve('late'), 10000)),
      );

      const promise = service.execute('timeout-service', fn, { timeout: 100 });

      await jest.advanceTimersByTimeAsync(200);

      await expect(promise).rejects.toThrow('timed out');
    });
  });

  describe('Circuit Opening', () => {
    it('should open circuit after consecutive failures threshold', async () => {
      service.registerCircuit('consecutive-fail-service', {
        failureThreshold: 3,
        volumeThreshold: 1,
      });

      const fn = jest.fn().mockRejectedValue(new Error('failure'));

      for (let i = 0; i < 3; i++) {
        try {
          await service.execute('consecutive-fail-service', fn);
        } catch {
          // Expected
        }
      }

      expect(service.getCircuitState('consecutive-fail-service')).toBe(CircuitState.OPEN);
    });

    it('should open circuit when failure rate threshold exceeded', async () => {
      service.registerCircuit('failure-rate-service', {
        failureRateThreshold: 50,
        volumeThreshold: 4,
        failureThreshold: 100, // High to not trigger on consecutive
      });

      // Make 4 requests: 2 success, 2 failure (50% failure rate)
      const successFn = jest.fn().mockResolvedValue('ok');
      const failFn = jest.fn().mockRejectedValue(new Error('fail'));

      await service.execute('failure-rate-service', successFn);
      await service.execute('failure-rate-service', successFn);

      try {
        await service.execute('failure-rate-service', failFn);
      } catch {
        // Expected
      }
      try {
        await service.execute('failure-rate-service', failFn);
      } catch {
        // Expected
      }

      // At 50% failure rate with threshold of 50%, circuit should open
      expect(service.getCircuitState('failure-rate-service')).toBe(CircuitState.OPEN);
    });

    it('should not open circuit before volume threshold', async () => {
      service.registerCircuit('volume-threshold-service', {
        failureThreshold: 100, // High
        failureRateThreshold: 10, // Low
        volumeThreshold: 10, // Need 10 requests first
      });

      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      // Only 5 failures (below volume threshold)
      for (let i = 0; i < 5; i++) {
        try {
          await service.execute('volume-threshold-service', fn);
        } catch {
          // Expected
        }
      }

      expect(service.getCircuitState('volume-threshold-service')).toBe(CircuitState.CLOSED);
    });

    it('should emit stateChange event when circuit opens', async () => {
      const handler = jest.fn();
      service.on('stateChange', handler);

      service.registerCircuit('event-open-service', {
        failureThreshold: 2,
        volumeThreshold: 1,
      });

      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      for (let i = 0; i < 2; i++) {
        try {
          await service.execute('event-open-service', fn);
        } catch {
          // Expected
        }
      }

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceName: 'event-open-service',
          newState: CircuitState.OPEN,
        }),
      );
    });
  });

  describe('Circuit Half-Open', () => {
    it('should transition to half-open after timeout', async () => {
      service.registerCircuit('half-open-service', {
        failureThreshold: 2,
        volumeThreshold: 1,
        timeout: 1000, // 1 second
      });

      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      // Open the circuit
      for (let i = 0; i < 2; i++) {
        try {
          await service.execute('half-open-service', fn);
        } catch {
          // Expected
        }
      }

      expect(service.getCircuitState('half-open-service')).toBe(CircuitState.OPEN);

      // Advance time past timeout
      jest.advanceTimersByTime(1500);

      // Trigger state check by getting state
      expect(service.getCircuitState('half-open-service')).toBe(CircuitState.HALF_OPEN);
    });

    it('should allow limited requests in half-open state', async () => {
      service.registerCircuit('limited-half-open-service', {
        failureThreshold: 2,
        volumeThreshold: 1,
        timeout: 1000,
        halfOpenRequests: 2,
      });

      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      // Open the circuit
      for (let i = 0; i < 2; i++) {
        try {
          await service.execute('limited-half-open-service', fn);
        } catch {
          // Expected
        }
      }

      // Advance to half-open
      jest.advanceTimersByTime(1500);

      const successFn = jest.fn().mockResolvedValue('ok');

      // First two requests should go through
      await service.execute('limited-half-open-service', successFn);
      await service.execute('limited-half-open-service', successFn);

      // Third request should be blocked
      await expect(service.execute('limited-half-open-service', successFn)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  describe('Circuit Closing', () => {
    it('should close circuit after success threshold in half-open', async () => {
      service.registerCircuit('close-service', {
        failureThreshold: 2,
        successThreshold: 2,
        volumeThreshold: 1,
        timeout: 1000,
        halfOpenRequests: 5,
      });

      const failFn = jest.fn().mockRejectedValue(new Error('fail'));

      // Open the circuit
      for (let i = 0; i < 2; i++) {
        try {
          await service.execute('close-service', failFn);
        } catch {
          // Expected
        }
      }

      // Advance to half-open
      jest.advanceTimersByTime(1500);

      const successFn = jest.fn().mockResolvedValue('ok');

      // Two successes should close the circuit
      await service.execute('close-service', successFn);
      await service.execute('close-service', successFn);

      expect(service.getCircuitState('close-service')).toBe(CircuitState.CLOSED);
    });

    it('should reopen circuit on failure in half-open', async () => {
      service.registerCircuit('reopen-service', {
        failureThreshold: 1,
        volumeThreshold: 1,
        timeout: 1000,
        halfOpenRequests: 5,
      });

      const failFn = jest.fn().mockRejectedValue(new Error('fail'));

      // Open the circuit
      try {
        await service.execute('reopen-service', failFn);
      } catch {
        // Expected
      }

      // Advance to half-open
      jest.advanceTimersByTime(1500);
      expect(service.getCircuitState('reopen-service')).toBe(CircuitState.HALF_OPEN);

      // Failure in half-open
      try {
        await service.execute('reopen-service', failFn);
      } catch {
        // Expected
      }

      expect(service.getCircuitState('reopen-service')).toBe(CircuitState.OPEN);
    });
  });

  describe('Slow Calls', () => {
    it('should track slow calls', async () => {
      service.registerCircuit('slow-service', {
        slowCallThreshold: 100,
      });

      const slowFn = jest.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return 'slow-result';
      });

      const promise = service.execute('slow-service', slowFn);
      await jest.advanceTimersByTimeAsync(250);
      await promise;

      const stats = service.getCircuitStats('slow-service');
      expect(stats?.slowCount).toBe(1);
    });

    it('should open circuit when slow call rate threshold exceeded', async () => {
      service.registerCircuit('slow-rate-service', {
        slowCallThreshold: 100,
        slowCallRateThreshold: 50,
        volumeThreshold: 4,
        failureThreshold: 100,
        failureRateThreshold: 100,
      });

      // Make some fast calls
      const fastFn = jest.fn().mockResolvedValue('fast');
      await service.execute('slow-rate-service', fastFn);
      await service.execute('slow-rate-service', fastFn);

      // Make slow calls (simulate by recording directly)
      const slowFn = jest.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return 'slow';
      });

      const promise1 = service.execute('slow-rate-service', slowFn);
      await jest.advanceTimersByTimeAsync(250);
      await promise1;

      const promise2 = service.execute('slow-rate-service', slowFn);
      await jest.advanceTimersByTimeAsync(250);
      await promise2;

      // With 50% slow call rate (2 slow out of 4), should open
      expect(service.getCircuitState('slow-rate-service')).toBe(CircuitState.OPEN);
    });
  });

  describe('Force Control', () => {
    it('should force open a circuit', () => {
      service.registerCircuit('force-open-service');
      service.forceOpen('force-open-service');

      expect(service.getCircuitState('force-open-service')).toBe(CircuitState.OPEN);
    });

    it('should force close a circuit', () => {
      service.registerCircuit('force-close-service');
      service.forceOpen('force-close-service');
      service.forceClose('force-close-service');

      expect(service.getCircuitState('force-close-service')).toBe(CircuitState.CLOSED);
    });

    it('should reset a circuit', async () => {
      service.registerCircuit('reset-service', {
        failureThreshold: 2,
        volumeThreshold: 1,
      });

      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      for (let i = 0; i < 2; i++) {
        try {
          await service.execute('reset-service', fn);
        } catch {
          // Expected
        }
      }

      expect(service.getCircuitState('reset-service')).toBe(CircuitState.OPEN);

      service.resetCircuit('reset-service');

      expect(service.getCircuitState('reset-service')).toBe(CircuitState.CLOSED);
      expect(service.getCircuitStats('reset-service')?.failureCount).toBe(0);
    });

    it('should reset all circuits', async () => {
      service.registerCircuit('reset-all-1');
      service.registerCircuit('reset-all-2');

      service.forceOpen('reset-all-1');
      service.forceOpen('reset-all-2');

      service.resetAllCircuits();

      expect(service.getCircuitState('reset-all-1')).toBe(CircuitState.CLOSED);
      expect(service.getCircuitState('reset-all-2')).toBe(CircuitState.CLOSED);
    });
  });

  describe('State Helpers', () => {
    it('should check if circuit is open', () => {
      service.registerCircuit('is-open-service');
      expect(service.isOpen('is-open-service')).toBe(false);

      service.forceOpen('is-open-service');
      expect(service.isOpen('is-open-service')).toBe(true);
    });

    it('should check if circuit is closed', () => {
      service.registerCircuit('is-closed-service');
      expect(service.isClosed('is-closed-service')).toBe(true);

      service.forceOpen('is-closed-service');
      expect(service.isClosed('is-closed-service')).toBe(false);
    });

    it('should check if circuit is half-open', () => {
      service.registerCircuit('is-half-open-service', {
        failureThreshold: 1,
        volumeThreshold: 1,
        timeout: 1000,
      });

      expect(service.isHalfOpen('is-half-open-service')).toBe(false);

      service.forceOpen('is-half-open-service');
      jest.advanceTimersByTime(1500);

      expect(service.isHalfOpen('is-half-open-service')).toBe(true);
    });
  });

  describe('Statistics', () => {
    it('should return circuit statistics', async () => {
      service.registerCircuit('stats-service');

      const successFn = jest.fn().mockResolvedValue('ok');
      const failFn = jest.fn().mockRejectedValue(new Error('fail'));

      await service.execute('stats-service', successFn);
      await service.execute('stats-service', successFn);
      try {
        await service.execute('stats-service', failFn);
      } catch {
        // Expected
      }

      const stats = service.getCircuitStats('stats-service');

      expect(stats?.totalRequests).toBe(3);
      expect(stats?.successCount).toBe(2);
      expect(stats?.failureCount).toBe(1);
    });

    it('should return null for unknown circuit stats', () => {
      const stats = service.getCircuitStats('unknown-service');
      expect(stats).toBeNull();
    });

    it('should return all circuit statistics', async () => {
      service.registerCircuit('all-stats-1');
      service.registerCircuit('all-stats-2');

      const fn = jest.fn().mockResolvedValue('ok');
      await service.execute('all-stats-1', fn);
      await service.execute('all-stats-2', fn);

      const allStats = service.getAllCircuitStats();

      expect(allStats['all-stats-1']).toBeDefined();
      expect(allStats['all-stats-2']).toBeDefined();
    });

    it('should calculate failure rate', async () => {
      service.registerCircuit('failure-rate-stats-service');

      const successFn = jest.fn().mockResolvedValue('ok');
      const failFn = jest.fn().mockRejectedValue(new Error('fail'));

      await service.execute('failure-rate-stats-service', successFn);
      await service.execute('failure-rate-stats-service', successFn);
      try {
        await service.execute('failure-rate-stats-service', failFn);
      } catch {
        // Expected
      }
      try {
        await service.execute('failure-rate-stats-service', failFn);
      } catch {
        // Expected
      }

      const stats = service.getCircuitStats('failure-rate-stats-service');

      // 2 failures out of 4 = 50%
      expect(stats?.failureRate).toBe(50);
    });
  });

  describe('Registration', () => {
    it('should register circuit with custom configuration', () => {
      service.registerCircuit('custom-config-service', {
        failureThreshold: 10,
        timeout: 60000,
      });

      // Should be registered and use custom config
      expect(service.getCircuitState('custom-config-service')).toBe(CircuitState.CLOSED);
    });

    it('should unregister a circuit', () => {
      service.registerCircuit('unregister-service');
      expect(service.getCircuitStats('unregister-service')).not.toBeNull();

      service.unregisterCircuit('unregister-service');
      expect(service.getCircuitStats('unregister-service')).toBeNull();
    });
  });

  describe('WithCircuitBreaker Decorator', () => {
    it('should create a decorator', () => {
      const decorator = WithCircuitBreaker('decorated-service');
      expect(typeof decorator).toBe('function');
    });

    it('should wrap method with circuit breaker', async () => {
      class TestClass {
        circuitBreakerService = service;

        @WithCircuitBreaker('decorator-test-service')
        async testMethod(): Promise<string> {
          return 'result';
        }
      }

      const instance = new TestClass();
      const result = await instance.testMethod();

      expect(result).toBe('result');
    });

    it('should pass through when no circuit breaker service', async () => {
      class TestClassNoCB {
        @WithCircuitBreaker('no-cb-service')
        async testMethod(): Promise<string> {
          return 'no-cb-result';
        }
      }

      const instance = new TestClassNoCB();
      const result = await instance.testMethod();

      expect(result).toBe('no-cb-result');
    });
  });

  describe('Edge Cases', () => {
    it('should handle rapid state transitions', async () => {
      service.registerCircuit('rapid-transition-service', {
        failureThreshold: 1,
        successThreshold: 1,
        volumeThreshold: 1,
        timeout: 100,
        halfOpenRequests: 10,
      });

      const failFn = jest.fn().mockRejectedValue(new Error('fail'));
      const successFn = jest.fn().mockResolvedValue('ok');

      // Open
      try {
        await service.execute('rapid-transition-service', failFn);
      } catch {
        // Expected
      }
      expect(service.getCircuitState('rapid-transition-service')).toBe(CircuitState.OPEN);

      // Wait for half-open
      jest.advanceTimersByTime(200);
      expect(service.getCircuitState('rapid-transition-service')).toBe(CircuitState.HALF_OPEN);

      // Close with success
      await service.execute('rapid-transition-service', successFn);
      expect(service.getCircuitState('rapid-transition-service')).toBe(CircuitState.CLOSED);
    });

    it('should handle concurrent executions', async () => {
      service.registerCircuit('concurrent-service');

      const fn = jest.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'ok';
      });

      const promises = Array(10)
        .fill(null)
        .map(() => service.execute('concurrent-service', fn));

      await jest.advanceTimersByTimeAsync(100);

      const results = await Promise.all(promises);
      expect(results).toHaveLength(10);
      results.forEach((r) => expect(r).toBe('ok'));
    });
  });
});
