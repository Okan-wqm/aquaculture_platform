/**
 * Retry Utility
 * Provides retry logic with exponential backoff
 * Essential for resilient sensor data processing
 */

import { Logger } from '@nestjs/common';

/**
 * Retry configuration options
 */
export interface RetryOptions {
  /**
   * Maximum number of retry attempts
   */
  maxRetries: number;

  /**
   * Initial delay in milliseconds before first retry
   */
  initialDelayMs: number;

  /**
   * Maximum delay in milliseconds between retries
   */
  maxDelayMs: number;

  /**
   * Multiplier for exponential backoff (default: 2)
   */
  backoffMultiplier?: number;

  /**
   * Whether to add jitter to prevent thundering herd
   */
  jitter?: boolean;

  /**
   * Function to determine if error is retryable
   */
  isRetryable?: (error: Error) => boolean;

  /**
   * Optional logger name for logging retries
   */
  loggerName?: string;
}

/**
 * Retry result
 */
export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  attempts: number;
  totalDelayMs: number;
}

/**
 * Default retry options
 */
const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 100,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  jitter: true,
  isRetryable: () => true,
  loggerName: 'RetryUtil',
};

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and optional jitter
 */
function calculateDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  backoffMultiplier: number,
  jitter: boolean,
): number {
  // Exponential backoff: delay = initial * multiplier^attempt
  let delay = initialDelayMs * Math.pow(backoffMultiplier, attempt);

  // Cap at maximum delay
  delay = Math.min(delay, maxDelayMs);

  // Add jitter: +/- 25% randomness
  if (jitter) {
    const jitterRange = delay * 0.25;
    delay = delay - jitterRange + Math.random() * jitterRange * 2;
  }

  return Math.round(delay);
}

/**
 * Execute a function with retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<RetryResult<T>> {
  const opts: Required<RetryOptions> = { ...DEFAULT_RETRY_OPTIONS, ...options };
  const logger = new Logger(opts.loggerName);

  let lastError: Error | undefined;
  let totalDelayMs = 0;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const result = await fn();
      return {
        success: true,
        result,
        attempts: attempt + 1,
        totalDelayMs,
      };
    } catch (error) {
      lastError = error as Error;

      // Check if we should retry
      if (attempt >= opts.maxRetries) {
        logger.warn(`All ${opts.maxRetries + 1} attempts failed: ${lastError.message}`);
        break;
      }

      if (!opts.isRetryable(lastError)) {
        logger.debug(`Error is not retryable: ${lastError.message}`);
        break;
      }

      // Calculate delay
      const delayMs = calculateDelay(
        attempt,
        opts.initialDelayMs,
        opts.maxDelayMs,
        opts.backoffMultiplier,
        opts.jitter,
      );

      logger.debug(
        `Attempt ${attempt + 1}/${opts.maxRetries + 1} failed, retrying in ${delayMs}ms: ${lastError.message}`,
      );

      totalDelayMs += delayMs;
      await sleep(delayMs);
    }
  }

  return {
    success: false,
    error: lastError,
    attempts: opts.maxRetries + 1,
    totalDelayMs,
  };
}

/**
 * Common retryable error checks
 */
export const RetryableErrors = {
  /**
   * Check if error is a transient database error
   */
  isTransientDatabaseError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes('connection refused') ||
      message.includes('connection reset') ||
      message.includes('timeout') ||
      message.includes('deadlock') ||
      message.includes('too many connections') ||
      message.includes('could not connect')
    );
  },

  /**
   * Check if error is a transient network error
   */
  isTransientNetworkError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes('econnreset') ||
      message.includes('econnrefused') ||
      message.includes('etimedout') ||
      message.includes('network') ||
      message.includes('socket hang up')
    );
  },

  /**
   * Check if error is a transient Redis error
   */
  isTransientRedisError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes('redis') &&
      (message.includes('connection') ||
        message.includes('timeout') ||
        message.includes('busy'))
    );
  },

  /**
   * Combined check for common transient errors
   */
  isTransient(error: Error): boolean {
    return (
      RetryableErrors.isTransientDatabaseError(error) ||
      RetryableErrors.isTransientNetworkError(error) ||
      RetryableErrors.isTransientRedisError(error)
    );
  },
};

/**
 * Decorator for adding retry logic to class methods
 */
export function Retryable(options: Partial<RetryOptions> = {}) {
  return function (
    _target: object,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: unknown[]) {
      const result = await withRetry(
        () => originalMethod.apply(this, args),
        {
          ...options,
          loggerName: options.loggerName || `Retryable:${propertyKey}`,
        },
      );

      if (!result.success) {
        throw result.error;
      }

      return result.result;
    };

    return descriptor;
  };
}

/**
 * Circuit Breaker implementation
 * Prevents repeated calls to failing services
 */
export class CircuitBreaker {
  private failures = 0;
  private lastFailure?: Date;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private readonly logger: Logger;

  constructor(
    private readonly name: string,
    private readonly failureThreshold: number = 5,
    private readonly resetTimeoutMs: number = 30000,
    private readonly halfOpenMaxCalls: number = 3,
  ) {
    this.logger = new Logger(`CircuitBreaker:${name}`);
  }

  /**
   * Execute a function through the circuit breaker
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      // Check if we should try half-open
      if (this.lastFailure && Date.now() - this.lastFailure.getTime() >= this.resetTimeoutMs) {
        this.state = 'half-open';
        this.logger.log('Circuit entering half-open state');
      } else {
        throw new Error(`Circuit breaker ${this.name} is open`);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.logger.log('Circuit closed after successful call in half-open state');
    }
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailure = new Date();

    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.logger.warn(`Circuit opened after ${this.failures} failures`);
    }
  }

  /**
   * Get current state
   */
  getState(): 'closed' | 'open' | 'half-open' {
    return this.state;
  }

  /**
   * Force reset the circuit breaker
   */
  reset(): void {
    this.failures = 0;
    this.lastFailure = undefined;
    this.state = 'closed';
    this.logger.log('Circuit manually reset');
  }
}
