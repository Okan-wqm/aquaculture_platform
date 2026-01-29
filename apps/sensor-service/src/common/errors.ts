/**
 * Type-safe Error Handling Utilities
 *
 * Provides consistent error handling patterns across the sensor-service.
 * Follows SOLID principles:
 * - Single Responsibility: Only handles error type checking and extraction
 * - Open/Closed: Extensible via custom error classes
 * - Liskov Substitution: All errors can be treated uniformly
 * - Interface Segregation: Minimal interface for error handling
 * - Dependency Inversion: Depends on abstract Error type
 */

/**
 * Type guard to check if a value is an Error instance
 */
export function isError(value: unknown): value is Error {
  return value instanceof Error;
}

/**
 * Type guard to check if a value has an error-like structure
 */
export function isErrorLike(value: unknown): value is { message: string; stack?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof (value as { message: unknown }).message === 'string'
  );
}

/**
 * Safely extract error message from unknown catch value
 *
 * @example
 * ```typescript
 * try {
 *   await someOperation();
 * } catch (error) {
 *   this.logger.error(`Operation failed: ${getErrorMessage(error)}`);
 * }
 * ```
 */
export function getErrorMessage(error: unknown): string {
  if (isError(error)) {
    return error.message;
  }

  if (isErrorLike(error)) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error === null) {
    return 'Null error';
  }

  if (error === undefined) {
    return 'Undefined error';
  }

  // Try to stringify the error
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
}

/**
 * Safely extract error stack trace from unknown catch value
 */
export function getErrorStack(error: unknown): string | undefined {
  if (isError(error)) {
    return error.stack;
  }

  if (isErrorLike(error)) {
    return error.stack;
  }

  return undefined;
}

/**
 * Convert unknown error to Error instance
 * Useful for rethrowing with proper type
 */
export function toError(error: unknown): Error {
  if (isError(error)) {
    return error;
  }

  const message = getErrorMessage(error);
  const newError = new Error(message);

  // Preserve original stack if available
  const stack = getErrorStack(error);
  if (stack) {
    newError.stack = stack;
  }

  return newError;
}

/**
 * Wrap an async function with error logging
 *
 * @example
 * ```typescript
 * const result = await withErrorLogging(
 *   () => this.repository.save(entity),
 *   this.logger,
 *   'Failed to save entity'
 * );
 * ```
 */
export async function withErrorLogging<T>(
  fn: () => Promise<T>,
  logger: { error: (message: string, trace?: string) => void },
  context: string,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = getErrorMessage(error);
    const stack = getErrorStack(error);
    logger.error(`${context}: ${message}`, stack);
    throw toError(error);
  }
}

/**
 * Wrap an async function with retry logic
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => this.mqttClient.publish(topic, message),
 *   { maxAttempts: 3, delayMs: 1000, backoffMultiplier: 2 }
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    delayMs?: number;
    backoffMultiplier?: number;
    shouldRetry?: (error: Error, attempt: number) => boolean;
    onRetry?: (error: Error, attempt: number) => void;
  } = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    delayMs = 1000,
    backoffMultiplier = 2,
    shouldRetry = () => true,
    onRetry,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = toError(error);

      if (attempt >= maxAttempts || !shouldRetry(lastError, attempt)) {
        throw lastError;
      }

      if (onRetry) {
        onRetry(lastError, attempt);
      }

      // Exponential backoff with jitter
      const delay = delayMs * Math.pow(backoffMultiplier, attempt - 1);
      const jitter = Math.random() * 0.2 * delay; // 0-20% jitter
      await sleep(Math.floor(delay + jitter));
    }
  }

  throw lastError ?? new Error('Retry failed');
}

/**
 * Sleep utility for async operations
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Safe JSON parse with type guard
 */
export function safeJsonParse<T>(
  json: string,
  validator?: (value: unknown) => value is T,
): T | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (validator && !validator(parsed)) {
      return null;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

/**
 * Timeout wrapper for async operations
 *
 * @example
 * ```typescript
 * const result = await withTimeout(
 *   () => this.pingDevice(deviceId),
 *   5000,
 *   'Device ping timeout'
 * );
 * ```
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  timeoutMessage = 'Operation timed out',
): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([fn(), timeoutPromise]);
    return result;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Debounce async function calls
 */
export function debounceAsync<T extends (...args: Parameters<T>) => Promise<ReturnType<T>>>(
  fn: T,
  waitMs: number,
): T {
  let timeoutId: NodeJS.Timeout | undefined;
  let pendingPromise: Promise<ReturnType<T>> | undefined;
  let pendingResolve: ((value: ReturnType<T>) => void) | undefined;
  let pendingReject: ((error: Error) => void) | undefined;

  return ((...args: Parameters<T>): Promise<ReturnType<T>> => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (!pendingPromise) {
      pendingPromise = new Promise<ReturnType<T>>((resolve, reject) => {
        pendingResolve = resolve;
        pendingReject = reject;
      });
    }

    timeoutId = setTimeout(() => {
      const resolve = pendingResolve!;
      const reject = pendingReject!;

      pendingPromise = undefined;
      pendingResolve = undefined;
      pendingReject = undefined;

      fn(...args)
        .then(resolve)
        .catch(reject);
    }, waitMs);

    return pendingPromise;
  }) as T;
}
