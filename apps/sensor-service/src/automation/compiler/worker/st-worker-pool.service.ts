/**
 * ST Worker Thread Pool Service
 *
 * Manages a pool of worker threads using piscina for CPU-intensive
 * ST parsing, formatting, and analysis operations.
 *
 * Key features:
 * - Configurable pool size (min/max threads)
 * - Timeout enforcement via AbortController
 * - Graceful shutdown on module destroy
 * - Health status reporting
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { join } from 'path';
import type { WorkerInput, WorkerOutput, WorkerLimits } from '../compiler.types';
import {
  WORKER_POOL_MIN_THREADS,
  WORKER_POOL_MAX_THREADS,
  WORKER_IDLE_TIMEOUT_MS,
  WORKER_TASK_TIMEOUT_MS,
  MAX_SOURCE_SIZE,
  MAX_AST_DEPTH,
  PARSE_TIMEOUT_MS,
  MAX_DIAGNOSTICS,
  MAX_TOKEN_COUNT,
  MAX_ERRORS,
} from '../compiler.constants';
import { WorkerErrorCodes } from './st-worker.types';
import type { WorkerPoolStatus } from './st-worker.types';

// WHY: Piscina is an optional dependency — loaded dynamically to degrade gracefully
// when not installed. We use a minimal interface instead of @ts-ignore.
interface PiscinaLike {
  new (options: { filename: string; minThreads: number; maxThreads: number; idleTimeout: number }): {
    run(task: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
    destroy(): Promise<void>;
    utilization: number;
    queueSize?: number;
    threads?: unknown[];
  };
}

let Piscina: PiscinaLike | undefined;

@Injectable()
export class STWorkerPoolService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(STWorkerPoolService.name);
  private pool: InstanceType<PiscinaLike> | null = null;
  private isShuttingDown = false;

  /** Default security limits passed to every worker */
  private readonly defaultLimits: WorkerLimits = {
    maxSourceSize: MAX_SOURCE_SIZE,
    maxAstDepth: MAX_AST_DEPTH,
    parseTimeoutMs: PARSE_TIMEOUT_MS,
    maxDiagnostics: MAX_DIAGNOSTICS,
    maxTokenCount: MAX_TOKEN_COUNT,
    maxErrors: MAX_ERRORS,
  };

  async onModuleInit(): Promise<void> {
    try {
       
      const piscinaModule = await import('piscina') as { default?: PiscinaLike };
      Piscina = (piscinaModule.default ?? piscinaModule) as PiscinaLike;

      this.pool = new Piscina({
        filename: join(__dirname, 'st-worker.js'),
        minThreads: WORKER_POOL_MIN_THREADS,
        maxThreads: WORKER_POOL_MAX_THREADS,
        idleTimeout: WORKER_IDLE_TIMEOUT_MS,
      });

      this.logger.log(
        `Worker pool initialized: ${WORKER_POOL_MIN_THREADS}-${WORKER_POOL_MAX_THREADS} threads, ` +
        `idle timeout ${WORKER_IDLE_TIMEOUT_MS}ms`,
      );
    } catch (err) {
      this.logger.error(
        'Failed to initialize worker pool. Piscina may not be installed. ' +
        'Run: npm install piscina',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.isShuttingDown = true;

    if (this.pool) {
      this.logger.log('Shutting down worker pool...');
      try {
        await this.pool.destroy();
        this.logger.log('Worker pool destroyed');
      } catch (err) {
        this.logger.error(
          'Error destroying worker pool',
          err instanceof Error ? err.stack : String(err),
        );
      }
      this.pool = null;
    }
  }

  /**
   * Execute a task in the worker pool with timeout enforcement.
   *
   * @param taskType - The type of worker task to execute
   * @param code - ST source code
   * @param tenantId - Tenant identifier
   * @param options - Optional programId and cursor position
   * @returns Worker output
   * @throws Error with code WORKER_BUSY if pool is full, WORKER_TIMEOUT on timeout
   */
  async execute(
    taskType: WorkerInput['taskType'],
    code: string,
    tenantId: string,
    options?: {
      programId?: string;
      position?: { line: number; character: number };
    },
  ): Promise<WorkerOutput> {
    if (this.isShuttingDown) {
      throw this.makeError(WorkerErrorCodes.ABORTED, 'Worker pool is shutting down');
    }

    if (!this.pool) {
      throw this.makeError(
        WorkerErrorCodes.INTERNAL_ERROR,
        'Worker pool not initialized. Is piscina installed?',
      );
    }

    // Build full input with security limits
    const fullInput: WorkerInput = {
      taskType,
      code,
      tenantId,
      programId: options?.programId,
      position: options?.position,
      limits: this.defaultLimits,
    };

    // Timeout enforcement via AbortController
    const timeout = WORKER_TASK_TIMEOUT_MS;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);

    try {
      const result = await this.pool.run(fullInput, { signal: ac.signal });
      return result as WorkerOutput;
    } catch (err: unknown) {
      if (err instanceof Error) {
        // AbortError = timeout
        if (err.name === 'AbortError' || err.message.includes('abort')) {
          throw this.makeError(
            WorkerErrorCodes.TIMEOUT,
            `Worker task timed out after ${timeout}ms`,
          );
        }
        // Piscina throws when queue is full
        if (err.message.includes('queue is full') || err.message.includes('Task queue is at limit')) {
          throw this.makeError(
            WorkerErrorCodes.BUSY,
            'Worker pool is busy, try again later',
          );
        }
      }
      throw this.makeError(
        WorkerErrorCodes.INTERNAL_ERROR,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Get current pool status for health checks.
   */
  getStatus(): WorkerPoolStatus {
    if (!this.pool) {
      return {
        runningTasks: 0,
        waitingTasks: 0,
        threads: 0,
        accepting: false,
      };
    }

    return {
      runningTasks: this.pool.utilization ? Math.round(this.pool.utilization * WORKER_POOL_MAX_THREADS) : 0,
      waitingTasks: this.pool.queueSize ?? 0,
      threads: this.pool.threads?.length ?? WORKER_POOL_MIN_THREADS,
      accepting: !this.isShuttingDown,
    };
  }

  getPoolStats(): { active: number; idle: number; pending: number } {
    const status = this.getStatus();
    return {
      active: status.runningTasks,
      idle: Math.max(0, status.threads - status.runningTasks),
      pending: status.waitingTasks,
    };
  }

  private makeError(code: string, message: string): Error & { code: string } {
    const err = new Error(message) as Error & { code: string };
    err.code = code;
    return err;
  }
}
