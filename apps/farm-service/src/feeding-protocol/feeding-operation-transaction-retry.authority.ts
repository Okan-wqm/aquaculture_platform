export const FEEDING_OPERATION_TRANSACTION_RETRY_V1 = Object.freeze({
  schemaVersion: 'feeding-operation-transaction-retry/v1',
  maxAttempts: 3,
  retryableSqlStates: Object.freeze(['40001', '40P01'] as const),
  retryDelayMsByCompletedAttempt: Object.freeze([15, 40] as const),
});

interface ErrorCoordinates {
  readonly code?: unknown;
  readonly driverError?: { readonly code?: unknown };
  readonly retryableFeedingTransaction?: unknown;
  readonly cause?: unknown;
}

function coordinatesOf(error: unknown): ErrorCoordinates | null {
  return typeof error === 'object' && error !== null ? (error as ErrorCoordinates) : null;
}

/** Closed classifier: only serialization, deadlock and typed lock-drift are retried. */
export function isRetryableFeedingTransactionError(error: unknown): boolean {
  let cursor: unknown = error;
  const seen = new Set<object>();
  while (typeof cursor === 'object' && cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const coordinates = coordinatesOf(cursor);
    if (!coordinates) return false;
    if (coordinates.retryableFeedingTransaction === true) return true;
    const code =
      typeof coordinates.code === 'string'
        ? coordinates.code
        : typeof coordinates.driverError?.code === 'string'
          ? coordinates.driverError.code
          : null;
    if (
      code !== null &&
      FEEDING_OPERATION_TRANSACTION_RETRY_V1.retryableSqlStates.includes(
        code as (typeof FEEDING_OPERATION_TRANSACTION_RETRY_V1.retryableSqlStates)[number],
      )
    ) {
      return true;
    }
    cursor = coordinates.cause;
  }
  return false;
}

export type FeedingTransactionRetryWait = (delayMs: number) => Promise<void>;

const wait: FeedingTransactionRetryWait = (delayMs) =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

/**
 * Retries the complete operation transaction, never an inner lock or write.
 * Each callback invocation must therefore create a new tenant transaction.
 */
export async function executeWithFeedingTransactionRetry<T>(
  executeAttempt: (attempt: number) => Promise<T>,
  waitForRetry: FeedingTransactionRetryWait = wait,
): Promise<T> {
  for (
    let attempt = 1;
    attempt <= FEEDING_OPERATION_TRANSACTION_RETRY_V1.maxAttempts;
    attempt += 1
  ) {
    try {
      return await executeAttempt(attempt);
    } catch (error: unknown) {
      if (
        attempt >= FEEDING_OPERATION_TRANSACTION_RETRY_V1.maxAttempts ||
        !isRetryableFeedingTransactionError(error)
      ) {
        throw error;
      }
      const delay =
        FEEDING_OPERATION_TRANSACTION_RETRY_V1.retryDelayMsByCompletedAttempt[attempt - 1];
      if (delay === undefined) throw error;
      await waitForRetry(delay);
    }
  }
  throw new Error('Feeding transaction retry authority exhausted without a terminal result');
}
