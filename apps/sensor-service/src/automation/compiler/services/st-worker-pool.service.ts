import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import {
  MAX_SOURCE_SIZE,
  MAX_AST_DEPTH,
  PARSE_TIMEOUT_MS,
  MAX_DIAGNOSTICS,
  MAX_TOKEN_COUNT,
  MAX_ERRORS,
  WORKER_TASK_TIMEOUT_MS,
} from '../compiler.constants';
import {
  WorkerInput,
  WorkerOutput,
  WorkerLimits,
  WorkerTaskType,
  WorkerAnalyzeResult,
  WorkerCompleteResult,
  WorkerHoverResult,
  WorkerFormatResult,
  Diagnostic,
} from '../compiler.types';

/**
 * ST Worker Pool Service
 *
 * Manages worker thread pool for CPU-bound ST parsing operations.
 * Currently uses in-process execution (Faz 1 stub).
 * Will integrate piscina worker threads when the parser is ready.
 */
@Injectable()
export class STWorkerPoolService implements OnModuleDestroy {
  private readonly logger = new Logger(STWorkerPoolService.name);

  private readonly limits: WorkerLimits = {
    maxSourceSize: MAX_SOURCE_SIZE,
    maxAstDepth: MAX_AST_DEPTH,
    parseTimeoutMs: PARSE_TIMEOUT_MS,
    maxDiagnostics: MAX_DIAGNOSTICS,
    maxTokenCount: MAX_TOKEN_COUNT,
    maxErrors: MAX_ERRORS,
  };

  async onModuleDestroy(): Promise<void> {
    // Will destroy piscina pool when integrated
    this.logger.log('Worker pool shutting down');
  }

  /**
   * Execute a task on the worker pool.
   * Currently runs in-process; will delegate to piscina workers.
   */
  async execute(
    taskType: WorkerTaskType,
    code: string,
    tenantId: string,
    options?: {
      programId?: string;
      position?: { line: number; character: number };
    },
  ): Promise<WorkerOutput> {
    const start = Date.now();

    const input: WorkerInput = {
      taskType,
      code,
      tenantId,
      programId: options?.programId,
      position: options?.position,
      limits: this.limits,
    };

    try {
      // Faz 1: in-process stub that returns basic results
      // Will be replaced by: return await this.pool.run(input);
      const result = await this.executeInProcess(input);
      return result;
    } catch (error) {
      this.logger.error(
        `Worker task ${taskType} failed for tenant ${tenantId}: ${(error as Error).message}`,
      );

      // Return a safe error result based on task type
      return this.createErrorResult(taskType, error as Error, Date.now() - start);
    }
  }

  /**
   * In-process execution stub (Faz 1).
   * Returns minimal valid results.
   */
  private async executeInProcess(input: WorkerInput): Promise<WorkerOutput> {
    const start = Date.now();

    // Size validation
    if (input.code.length > input.limits.maxSourceSize) {
      const diagnostic: Diagnostic = {
        range: { startLine: 0, startCol: 0, endLine: 0, endCol: 0 },
        severity: 'error',
        message: `Source code exceeds maximum size of ${input.limits.maxSourceSize} bytes`,
        code: 'STL001',
        source: 'st-lexer',
      };

      if (input.taskType === 'analyze') {
        return {
          taskType: 'analyze',
          success: false,
          diagnostics: [diagnostic],
          processingTimeMs: Date.now() - start,
        };
      }
    }

    switch (input.taskType) {
      case 'analyze':
        return {
          taskType: 'analyze',
          success: true,
          diagnostics: [],
          outline: [],
          processingTimeMs: Date.now() - start,
        } satisfies WorkerAnalyzeResult;

      case 'complete':
        return {
          taskType: 'complete',
          success: true,
          completions: [],
          processingTimeMs: Date.now() - start,
        } satisfies WorkerCompleteResult;

      case 'hover':
        return {
          taskType: 'hover',
          success: true,
          processingTimeMs: Date.now() - start,
        } satisfies WorkerHoverResult;

      case 'format':
        return {
          taskType: 'format',
          success: true,
          formattedCode: input.code,
          processingTimeMs: Date.now() - start,
        } satisfies WorkerFormatResult;

      default:
        return {
          taskType: 'analyze',
          success: true,
          diagnostics: [],
          processingTimeMs: Date.now() - start,
        } satisfies WorkerAnalyzeResult;
    }
  }

  private createErrorResult(
    taskType: WorkerTaskType,
    error: Error,
    elapsed: number,
  ): WorkerOutput {
    switch (taskType) {
      case 'analyze':
        return {
          taskType: 'analyze',
          success: false,
          diagnostics: [
            {
              range: { startLine: 0, startCol: 0, endLine: 0, endCol: 0 },
              severity: 'error',
              message: `Analysis failed: ${error.message}`,
              code: 'STS999',
              source: 'st-semantic',
            },
          ],
          processingTimeMs: elapsed,
        };
      case 'complete':
        return {
          taskType: 'complete',
          success: false,
          completions: [],
          processingTimeMs: elapsed,
        };
      case 'hover':
        return {
          taskType: 'hover',
          success: false,
          processingTimeMs: elapsed,
        };
      case 'format':
        return {
          taskType: 'format',
          success: false,
          processingTimeMs: elapsed,
        };
      default:
        return {
          taskType: 'analyze',
          success: false,
          diagnostics: [],
          processingTimeMs: elapsed,
        };
    }
  }

  getPoolStats(): { active: number; idle: number; pending: number } {
    // Stub stats; will be replaced by piscina stats
    return { active: 0, idle: 1, pending: 0 };
  }
}
