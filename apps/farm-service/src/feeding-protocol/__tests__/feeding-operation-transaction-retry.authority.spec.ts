import {
  FEEDING_OPERATION_TRANSACTION_RETRY_V1,
  executeWithFeedingTransactionRetry,
  isRetryableFeedingTransactionError,
} from '../feeding-operation-transaction-retry.authority';
import { UnitGrowthLockConflictError } from '../services/biomass-growth-applier.service';

describe('feeding operation transaction retry authority', () => {
  it.each(['40001', '40P01'])(
    'recognizes retryable SQLSTATE %s through driver wrappers',
    (code) => {
      expect(isRetryableFeedingTransactionError({ driverError: { code } })).toBe(true);
    },
  );

  it('recognizes only the typed unit membership drift conflict', () => {
    expect(isRetryableFeedingTransactionError(new UnitGrowthLockConflictError('drift'))).toBe(true);
    expect(isRetryableFeedingTransactionError(new Error('retry'))).toBe(false);
    expect(isRetryableFeedingTransactionError({ code: '23505' })).toBe(false);
  });

  it('restarts the complete transaction callback and uses the governed delays', async () => {
    const executions: number[] = [];
    const delays: number[] = [];
    const result = await executeWithFeedingTransactionRetry(
      async (attempt) => {
        executions.push(attempt);
        if (attempt < FEEDING_OPERATION_TRANSACTION_RETRY_V1.maxAttempts) {
          throw Object.assign(new Error('serialization failure'), { code: '40001' });
        }
        return 'committed';
      },
      async (delay) => {
        delays.push(delay);
      },
    );

    expect(result).toBe('committed');
    expect(executions).toEqual([1, 2, 3]);
    expect(delays).toEqual(FEEDING_OPERATION_TRANSACTION_RETRY_V1.retryDelayMsByCompletedAttempt);
  });

  it('does not retry non-authorized failures', async () => {
    const execute = jest.fn().mockRejectedValue(new Error('validation'));
    await expect(executeWithFeedingTransactionRetry(execute, jest.fn())).rejects.toThrow(
      'validation',
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
