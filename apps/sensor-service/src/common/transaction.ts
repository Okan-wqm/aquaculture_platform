/**
 * Transaction Wrapper Utilities
 *
 * Provides consistent transaction handling patterns across the sensor-service.
 * Ensures data integrity for batch operations and complex workflows.
 *
 * SOLID Principles:
 * - Single Responsibility: Only handles transaction management
 * - Open/Closed: Extensible via options
 * - Dependency Inversion: Depends on abstract DataSource
 */

import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { Logger } from '@nestjs/common';
import { getErrorMessage, getErrorStack, toError } from './errors';

/**
 * Transaction isolation levels
 */
export enum IsolationLevel {
  READ_UNCOMMITTED = 'READ UNCOMMITTED',
  READ_COMMITTED = 'READ COMMITTED',
  REPEATABLE_READ = 'REPEATABLE READ',
  SERIALIZABLE = 'SERIALIZABLE',
}

/**
 * Options for transaction execution
 */
export interface TransactionOptions {
  /** Transaction isolation level */
  isolationLevel?: IsolationLevel;
  /** Maximum retries on serialization failure */
  maxRetries?: number;
  /** Retry delay in milliseconds */
  retryDelayMs?: number;
  /** Logger for transaction events */
  logger?: Logger;
  /** Context string for logging */
  context?: string;
}

/**
 * Default transaction options
 */
const DEFAULT_OPTIONS: Required<Omit<TransactionOptions, 'logger'>> & { logger?: Logger } = {
  isolationLevel: IsolationLevel.READ_COMMITTED,
  maxRetries: 3,
  retryDelayMs: 100,
  logger: undefined,
  context: 'Transaction',
};

/**
 * Execute a function within a database transaction
 *
 * Features:
 * - Automatic rollback on error
 * - Configurable isolation level
 * - Retry on serialization failures
 * - Comprehensive logging
 *
 * @example
 * ```typescript
 * const result = await withTransaction(
 *   this.dataSource,
 *   async (manager) => {
 *     await manager.save(entity1);
 *     await manager.save(entity2);
 *     return { entity1, entity2 };
 *   },
 *   {
 *     isolationLevel: IsolationLevel.SERIALIZABLE,
 *     logger: this.logger,
 *     context: 'CreateBatchWithMetrics'
 *   }
 * );
 * ```
 */
export async function withTransaction<T>(
  dataSource: DataSource,
  fn: (manager: EntityManager) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { isolationLevel, maxRetries, retryDelayMs, logger, context } = opts;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const queryRunner = dataSource.createQueryRunner();

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction(isolationLevel);

      logger?.debug?.(`[${context}] Transaction started (attempt ${attempt}/${maxRetries})`);

      const result = await fn(queryRunner.manager);

      await queryRunner.commitTransaction();
      logger?.debug?.(`[${context}] Transaction committed`);

      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      lastError = toError(error);

      logger?.warn?.(
        `[${context}] Transaction rolled back (attempt ${attempt}/${maxRetries}): ${getErrorMessage(error)}`,
      );

      // Check if error is retryable (serialization failure)
      if (isSerializationFailure(lastError) && attempt < maxRetries) {
        logger?.debug?.(`[${context}] Retrying after serialization failure...`);
        await sleep(retryDelayMs * attempt); // Linear backoff
        continue;
      }

      // Non-retryable error or max retries reached
      logger?.error?.(
        `[${context}] Transaction failed permanently: ${getErrorMessage(error)}`,
        getErrorStack(error),
      );
      throw lastError;
    } finally {
      await queryRunner.release();
    }
  }

  throw lastError ?? new Error('Transaction failed');
}

/**
 * Execute multiple operations in a single transaction
 *
 * @example
 * ```typescript
 * const results = await withBatchTransaction(
 *   this.dataSource,
 *   [
 *     (manager) => manager.save(entity1),
 *     (manager) => manager.save(entity2),
 *     (manager) => manager.delete(OldEntity, oldId),
 *   ],
 *   { context: 'BatchUpdate' }
 * );
 * ```
 */
export async function withBatchTransaction<T>(
  dataSource: DataSource,
  operations: Array<(manager: EntityManager) => Promise<T>>,
  options: TransactionOptions = {},
): Promise<T[]> {
  return withTransaction(
    dataSource,
    async (manager) => {
      const results: T[] = [];
      for (const operation of operations) {
        const result = await operation(manager);
        results.push(result);
      }
      return results;
    },
    options,
  );
}

/**
 * Execute a read-only query with proper isolation
 * Uses a separate connection to avoid blocking writers
 */
export async function withReadOnlyTransaction<T>(
  dataSource: DataSource,
  fn: (manager: EntityManager) => Promise<T>,
  options: Omit<TransactionOptions, 'maxRetries'> = {},
): Promise<T> {
  const queryRunner = dataSource.createQueryRunner();
  const { isolationLevel = IsolationLevel.READ_COMMITTED, logger, context = 'ReadOnly' } = options;

  try {
    await queryRunner.connect();

    // Set read-only transaction mode (PostgreSQL specific)
    await queryRunner.query('SET TRANSACTION READ ONLY');
    await queryRunner.startTransaction(isolationLevel);

    logger?.debug?.(`[${context}] Read-only transaction started`);

    const result = await fn(queryRunner.manager);

    await queryRunner.commitTransaction();
    logger?.debug?.(`[${context}] Read-only transaction committed`);

    return result;
  } catch (error) {
    await queryRunner.rollbackTransaction();
    logger?.error?.(`[${context}] Read-only transaction failed: ${getErrorMessage(error)}`);
    throw toError(error);
  } finally {
    await queryRunner.release();
  }
}

/**
 * Check if an error is a PostgreSQL serialization failure
 * These errors are safe to retry
 */
function isSerializationFailure(error: Error): boolean {
  const message = error.message.toLowerCase();
  const code = (error as { code?: string }).code;

  // PostgreSQL serialization failure codes
  const serializationCodes = ['40001', '40P01'];

  if (code && serializationCodes.includes(code)) {
    return true;
  }

  // Check message for common serialization failure patterns
  return (
    message.includes('serialization failure') ||
    message.includes('could not serialize access') ||
    message.includes('deadlock detected')
  );
}

/**
 * Simple sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a scoped transaction context that can be passed around
 *
 * @example
 * ```typescript
 * const txContext = await createTransactionContext(this.dataSource);
 * try {
 *   await this.service1.doSomething(txContext.manager);
 *   await this.service2.doSomethingElse(txContext.manager);
 *   await txContext.commit();
 * } catch (error) {
 *   await txContext.rollback();
 *   throw error;
 * }
 * ```
 */
export async function createTransactionContext(
  dataSource: DataSource,
  isolationLevel: IsolationLevel = IsolationLevel.READ_COMMITTED,
): Promise<TransactionContext> {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction(isolationLevel);

  return new TransactionContext(queryRunner);
}

/**
 * Transaction context class for manual transaction management
 */
export class TransactionContext {
  private isFinalized = false;

  constructor(private readonly queryRunner: QueryRunner) {}

  get manager(): EntityManager {
    if (this.isFinalized) {
      throw new Error('Transaction has already been finalized');
    }
    return this.queryRunner.manager;
  }

  async commit(): Promise<void> {
    if (this.isFinalized) {
      throw new Error('Transaction has already been finalized');
    }
    this.isFinalized = true;
    await this.queryRunner.commitTransaction();
    await this.queryRunner.release();
  }

  async rollback(): Promise<void> {
    if (this.isFinalized) {
      return; // Already finalized, silently return
    }
    this.isFinalized = true;
    await this.queryRunner.rollbackTransaction();
    await this.queryRunner.release();
  }

  /**
   * Ensure resources are released if transaction wasn't finalized
   */
  async release(): Promise<void> {
    if (!this.isFinalized) {
      await this.rollback();
    }
  }
}
