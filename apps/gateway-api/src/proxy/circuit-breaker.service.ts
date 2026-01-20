/**
 * Circuit Breaker Service
 *
 * Implements the circuit breaker pattern for fault tolerance.
 * Protects downstream services from cascading failures.
 * Provides automatic recovery and fallback mechanisms.
 */

import { EventEmitter } from 'events';

import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Circuit breaker states
 */
export enum CircuitState {
  CLOSED = 'closed', // Normal operation, requests flow through
  OPEN = 'open', // Failure threshold exceeded, requests blocked
  HALF_OPEN = 'half_open', // Testing if service recovered
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  failureThreshold: number; // Number of failures before opening
  successThreshold: number; // Number of successes in half-open to close
  timeout: number; // Time in ms before transitioning from open to half-open
  volumeThreshold: number; // Minimum requests before calculating failure rate
  failureRateThreshold: number; // Percentage of failures to trigger (0-100)
  slowCallThreshold: number; // Time in ms to consider a call "slow"
  slowCallRateThreshold: number; // Percentage of slow calls to trigger (0-100)
  halfOpenRequests: number; // Number of requests allowed in half-open state
}

/**
 * Circuit statistics
 */
export interface CircuitStats {
  state: CircuitState;
  totalRequests: number;
  successCount: number;
  failureCount: number;
  slowCount: number;
  lastFailureTime?: Date;
  lastSuccessTime?: Date;
  stateChangedAt: Date;
  failureRate: number;
  slowCallRate: number;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
}

/**
 * Circuit breaker event data
 */
export interface CircuitEvent {
  serviceName: string;
  previousState: CircuitState;
  newState: CircuitState;
  timestamp: Date;
  stats: CircuitStats;
}

/**
 * Fallback function type
 */
export type FallbackFn<T> = (error: Error, serviceName: string) => T | Promise<T>;

/**
 * Request execution options
 */
export interface ExecuteOptions<T> {
  fallback?: FallbackFn<T>;
  timeout?: number;
  tags?: Record<string, string>;
}

/**
 * Sliding window for tracking metrics
 */
class SlidingWindow {
  private readonly buckets: Array<{
    success: number;
    failure: number;
    slow: number;
    timestamp: number;
  }> = [];
  private readonly windowSize: number; // in buckets
  private readonly bucketDuration: number; // in ms

  constructor(windowSize = 10, bucketDuration = 1000) {
    this.windowSize = windowSize;
    this.bucketDuration = bucketDuration;
  }

  recordSuccess(): void {
    this.getCurrentBucket().success++;
  }

  recordFailure(): void {
    this.getCurrentBucket().failure++;
  }

  recordSlow(): void {
    this.getCurrentBucket().slow++;
  }

  getStats(): { success: number; failure: number; slow: number; total: number } {
    this.cleanup();
    const stats = { success: 0, failure: 0, slow: 0, total: 0 };

    for (const bucket of this.buckets) {
      stats.success += bucket.success;
      stats.failure += bucket.failure;
      stats.slow += bucket.slow;
    }

    stats.total = stats.success + stats.failure;
    return stats;
  }

  reset(): void {
    this.buckets.length = 0;
  }

  private getCurrentBucket(): { success: number; failure: number; slow: number; timestamp: number } {
    const now = Date.now();
    const bucketTime = Math.floor(now / this.bucketDuration) * this.bucketDuration;

    this.cleanup();

    let bucket = this.buckets.find((b) => b.timestamp === bucketTime);
    if (!bucket) {
      bucket = { success: 0, failure: 0, slow: 0, timestamp: bucketTime };
      this.buckets.push(bucket);
    }

    return bucket;
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.windowSize * this.bucketDuration;
    while (this.buckets.length > 0 && this.buckets[0] && this.buckets[0].timestamp < cutoff) {
      this.buckets.shift();
    }
  }
}

/**
 * Individual circuit breaker for a service
 */
class CircuitBreaker {
  private state = CircuitState.CLOSED;
  private stateChangedAt = new Date();
  private consecutiveSuccesses = 0;
  private consecutiveFailures = 0;
  private halfOpenRequestCount = 0;
  private lastFailureTime?: Date;
  private lastSuccessTime?: Date;
  private readonly window: SlidingWindow;

  constructor(
    private readonly serviceName: string,
    private readonly config: CircuitBreakerConfig,
    private readonly eventEmitter: EventEmitter,
    private readonly logger: Logger,
  ) {
    this.window = new SlidingWindow(10, 1000);
  }

  getState(): CircuitState {
    this.checkStateTransition();
    return this.state;
  }

  getStats(): CircuitStats {
    const windowStats = this.window.getStats();
    const failureRate =
      windowStats.total > 0 ? (windowStats.failure / windowStats.total) * 100 : 0;
    const slowCallRate =
      windowStats.total > 0 ? (windowStats.slow / windowStats.total) * 100 : 0;

    return {
      state: this.state,
      totalRequests: windowStats.total,
      successCount: windowStats.success,
      failureCount: windowStats.failure,
      slowCount: windowStats.slow,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      stateChangedAt: this.stateChangedAt,
      failureRate,
      slowCallRate,
      consecutiveSuccesses: this.consecutiveSuccesses,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  canExecute(): boolean {
    this.checkStateTransition();

    switch (this.state) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.OPEN:
        return false;

      case CircuitState.HALF_OPEN:
        // Allow limited requests in half-open state
        if (this.halfOpenRequestCount < this.config.halfOpenRequests) {
          this.halfOpenRequestCount++;
          return true;
        }
        return false;

      default:
        return false;
    }
  }

  recordSuccess(duration: number): void {
    this.lastSuccessTime = new Date();
    this.consecutiveSuccesses++;
    this.consecutiveFailures = 0;
    this.window.recordSuccess();

    if (duration > this.config.slowCallThreshold) {
      this.window.recordSlow();
    }

    if (this.state === CircuitState.HALF_OPEN) {
      if (this.consecutiveSuccesses >= this.config.successThreshold) {
        this.transitionTo(CircuitState.CLOSED);
      }
    }
  }

  recordFailure(): void {
    this.lastFailureTime = new Date();
    this.consecutiveFailures++;
    this.consecutiveSuccesses = 0;
    this.window.recordFailure();

    this.checkForTrip();
  }

  forceOpen(): void {
    this.transitionTo(CircuitState.OPEN);
  }

  forceClose(): void {
    this.transitionTo(CircuitState.CLOSED);
  }

  reset(): void {
    this.window.reset();
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures = 0;
    this.halfOpenRequestCount = 0;
    this.transitionTo(CircuitState.CLOSED);
  }

  private checkStateTransition(): void {
    if (this.state === CircuitState.OPEN) {
      const timeSinceOpen = Date.now() - this.stateChangedAt.getTime();
      if (timeSinceOpen >= this.config.timeout) {
        this.transitionTo(CircuitState.HALF_OPEN);
      }
    }
  }

  private checkForTrip(): void {
    const windowStats = this.window.getStats();

    // Check volume threshold
    if (windowStats.total < this.config.volumeThreshold) {
      return;
    }

    // Check consecutive failures
    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.transitionTo(CircuitState.OPEN);
      return;
    }

    // Check failure rate
    const failureRate = (windowStats.failure / windowStats.total) * 100;
    if (failureRate >= this.config.failureRateThreshold) {
      this.transitionTo(CircuitState.OPEN);
      return;
    }

    // Check slow call rate
    const slowCallRate = (windowStats.slow / windowStats.total) * 100;
    if (slowCallRate >= this.config.slowCallRateThreshold) {
      this.transitionTo(CircuitState.OPEN);
    }
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) {
      return;
    }

    const previousState = this.state;
    this.state = newState;
    this.stateChangedAt = new Date();

    if (newState === CircuitState.HALF_OPEN) {
      this.halfOpenRequestCount = 0;
      this.consecutiveSuccesses = 0;
    }

    if (newState === CircuitState.CLOSED) {
      this.window.reset();
    }

    this.logger.log(`Circuit breaker state transition: ${previousState} � ${newState}`, {
      service: this.serviceName,
    });

    const event: CircuitEvent = {
      serviceName: this.serviceName,
      previousState,
      newState,
      timestamp: new Date(),
      stats: this.getStats(),
    };

    this.eventEmitter.emit('stateChange', event);
  }
}

/**
 * Circuit Breaker Service
 * Manages circuit breakers for multiple services
 */
@Injectable()
export class CircuitBreakerService extends EventEmitter {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly circuits = new Map<string, CircuitBreaker>();
  private readonly defaultConfig: CircuitBreakerConfig;

  constructor(private readonly configService: ConfigService) {
    super();

    this.defaultConfig = {
      failureThreshold: this.configService.get<number>('CIRCUIT_FAILURE_THRESHOLD', 5),
      successThreshold: this.configService.get<number>('CIRCUIT_SUCCESS_THRESHOLD', 3),
      timeout: this.configService.get<number>('CIRCUIT_TIMEOUT', 30000),
      volumeThreshold: this.configService.get<number>('CIRCUIT_VOLUME_THRESHOLD', 10),
      failureRateThreshold: this.configService.get<number>('CIRCUIT_FAILURE_RATE', 50),
      slowCallThreshold: this.configService.get<number>('CIRCUIT_SLOW_CALL_THRESHOLD', 5000),
      slowCallRateThreshold: this.configService.get<number>('CIRCUIT_SLOW_CALL_RATE', 80),
      halfOpenRequests: this.configService.get<number>('CIRCUIT_HALF_OPEN_REQUESTS', 3),
    };
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(
    serviceName: string,
    fn: () => Promise<T>,
    options?: ExecuteOptions<T>,
  ): Promise<T> {
    const circuit = this.getOrCreateCircuit(serviceName);

    if (!circuit.canExecute()) {
      this.logger.warn(`Circuit breaker open for service: ${serviceName}`);

      if (options?.fallback) {
        return options.fallback(
          new Error(`Circuit breaker is open for service: ${serviceName}`),
          serviceName,
        );
      }

      throw new ServiceUnavailableException({
        message: `Service temporarily unavailable: ${serviceName}`,
        circuitState: circuit.getState(),
      });
    }

    const startTime = Date.now();
    const timeout = options?.timeout || 30000;

    try {
      const result = await this.executeWithTimeout(fn, timeout);
      const duration = Date.now() - startTime;
      circuit.recordSuccess(duration);
      return result;
    } catch (error) {
      circuit.recordFailure();

      if (options?.fallback) {
        return options.fallback(error as Error, serviceName);
      }

      throw error;
    }
  }

  /**
   * Get circuit state for a service
   */
  getCircuitState(serviceName: string): CircuitState {
    const circuit = this.circuits.get(serviceName);
    return circuit?.getState() ?? CircuitState.CLOSED;
  }

  /**
   * Get circuit statistics for a service
   */
  getCircuitStats(serviceName: string): CircuitStats | null {
    const circuit = this.circuits.get(serviceName);
    return circuit?.getStats() ?? null;
  }

  /**
   * Get all circuit statistics
   */
  getAllCircuitStats(): Record<string, CircuitStats> {
    const stats: Record<string, CircuitStats> = {};
    for (const [name, circuit] of this.circuits.entries()) {
      stats[name] = circuit.getStats();
    }
    return stats;
  }

  /**
   * Force open a circuit
   */
  forceOpen(serviceName: string): void {
    const circuit = this.circuits.get(serviceName);
    if (circuit) {
      circuit.forceOpen();
      this.logger.warn(`Circuit manually opened for service: ${serviceName}`);
    }
  }

  /**
   * Force close a circuit
   */
  forceClose(serviceName: string): void {
    const circuit = this.circuits.get(serviceName);
    if (circuit) {
      circuit.forceClose();
      this.logger.log(`Circuit manually closed for service: ${serviceName}`);
    }
  }

  /**
   * Reset a circuit
   */
  resetCircuit(serviceName: string): void {
    const circuit = this.circuits.get(serviceName);
    if (circuit) {
      circuit.reset();
      this.logger.log(`Circuit reset for service: ${serviceName}`);
    }
  }

  /**
   * Reset all circuits
   */
  resetAllCircuits(): void {
    for (const [name, circuit] of this.circuits.entries()) {
      circuit.reset();
      this.logger.log(`Circuit reset for service: ${name}`);
    }
  }

  /**
   * Check if circuit is open
   */
  isOpen(serviceName: string): boolean {
    return this.getCircuitState(serviceName) === CircuitState.OPEN;
  }

  /**
   * Check if circuit is closed
   */
  isClosed(serviceName: string): boolean {
    return this.getCircuitState(serviceName) === CircuitState.CLOSED;
  }

  /**
   * Check if circuit is half-open
   */
  isHalfOpen(serviceName: string): boolean {
    return this.getCircuitState(serviceName) === CircuitState.HALF_OPEN;
  }

  /**
   * Register a circuit with custom configuration
   */
  registerCircuit(serviceName: string, config?: Partial<CircuitBreakerConfig>): void {
    const circuitConfig = { ...this.defaultConfig, ...config };
    const circuit = new CircuitBreaker(serviceName, circuitConfig, this, this.logger);
    this.circuits.set(serviceName, circuit);
    this.logger.log(`Circuit breaker registered for service: ${serviceName}`);
  }

  /**
   * Unregister a circuit
   */
  unregisterCircuit(serviceName: string): void {
    this.circuits.delete(serviceName);
    this.logger.log(`Circuit breaker unregistered for service: ${serviceName}`);
  }

  /**
   * Get or create a circuit for a service
   */
  private getOrCreateCircuit(serviceName: string): CircuitBreaker {
    let circuit = this.circuits.get(serviceName);
    if (!circuit) {
      circuit = new CircuitBreaker(serviceName, this.defaultConfig, this, this.logger);
      this.circuits.set(serviceName, circuit);
    }
    return circuit;
  }

  /**
   * Execute with timeout
   */
  private async executeWithTimeout<T>(fn: () => Promise<T>, timeout: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Request timed out after ${timeout}ms`));
      }, timeout);

      fn()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }
}

/**
 * Circuit breaker decorator for methods
 */
export function WithCircuitBreaker(
  serviceName: string,
  options?: Partial<ExecuteOptions<unknown>>,
) {
  return function (
    _target: unknown,
    _propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: unknown[]) {
      const circuitBreaker = (this as { circuitBreakerService?: CircuitBreakerService })
        .circuitBreakerService;

      if (!circuitBreaker) {
        return originalMethod.apply(this, args);
      }

      return circuitBreaker.execute(
        serviceName,
        () => originalMethod.apply(this, args),
        options as ExecuteOptions<unknown>,
      );
    };

    return descriptor;
  };
}
