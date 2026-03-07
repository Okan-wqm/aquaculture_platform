import { Injectable, Logger } from '@nestjs/common';

import { MAX_SOURCE_SIZE } from '../compiler.constants';
import {
  NatsLanguageReply,
  WorkerAnalyzeResult,
  WorkerCompleteResult,
  WorkerHoverResult,
  WorkerFormatResult,
  WorkerOutlineResult,
  WorkerDefinitionResult,
  WorkerReferencesResult,
  CompletionEntry,
} from '../compiler.types';

import { STIntellisenseService } from './st-intellisense.service';
import { STWorkerPoolService } from '../worker/st-worker-pool.service';

/**
 * ST Language Service
 *
 * Orchestrates language operations:
 * 1. Input validation (security checks)
 * 2. Worker pool delegation (CPU-bound parsing)
 * 3. IntelliSense enrichment (database-driven completions)
 * 4. Result combination and formatting
 */
@Injectable()
export class STLanguageService {
  private readonly logger = new Logger(STLanguageService.name);

  constructor(
    private readonly workerPool: STWorkerPoolService,
    private readonly intellisense: STIntellisenseService,
  ) {}

  /**
   * Analyze ST code: parse + semantic analysis + diagnostics.
   */
  async analyze(
    code: string,
    tenantId: string,
    requestId: string,
    programId?: string,
  ): Promise<NatsLanguageReply> {
    this.validateInput(code);

    const result = (await this.workerPool.execute(
      'analyze',
      code,
      tenantId,
      { programId },
    )) as WorkerAnalyzeResult;

    return {
      success: result.success,
      requestId,
      type: 'diagnostics',
      data: {
        diagnostics: result.diagnostics,
        outline: result.outline,
      },
      processingTimeMs: result.processingTimeMs,
    };
  }

  /**
   * Provide completions at a given position.
   * Combines worker (keyword/context) completions with DB-driven completions.
   */
  async complete(
    code: string,
    position: { line: number; character: number },
    tenantId: string,
    requestId: string,
    programId?: string,
  ): Promise<NatsLanguageReply> {
    this.validateInput(code);

    // Run worker completions and DB completions in parallel
    const [workerResult, tagCompletions, fbCompletions, varCompletions] =
      await Promise.all([
        this.workerPool.execute('complete', code, tenantId, {
          programId,
          position,
        }) as Promise<WorkerCompleteResult>,
        this.intellisense.getTagCompletions(tenantId),
        this.intellisense.getFBDefinitions(tenantId),
        programId
          ? this.intellisense.getProgramVariables(programId, tenantId)
          : ([] as CompletionEntry[]),
      ]);

    // Merge all completions
    const allCompletions = [
      ...workerResult.completions,
      ...varCompletions,
      ...fbCompletions,
      ...tagCompletions,
    ];

    return {
      success: true,
      requestId,
      type: 'completions',
      data: {
        completions: allCompletions,
      },
      processingTimeMs: workerResult.processingTimeMs,
    };
  }

  /**
   * Provide hover information at a given position.
   */
  async hover(
    code: string,
    position: { line: number; character: number },
    requestId: string,
  ): Promise<NatsLanguageReply> {
    this.validateInput(code);

    const result = (await this.workerPool.execute('hover', code, '', {
      position,
    })) as WorkerHoverResult;

    return {
      success: result.success,
      requestId,
      type: 'hover',
      data: {
        contents: result.contents,
        range: result.range,
      },
      processingTimeMs: result.processingTimeMs,
    };
  }

  /**
   * Format ST code.
   */
  async format(code: string, requestId: string): Promise<NatsLanguageReply> {
    this.validateInput(code);

    const result = (await this.workerPool.execute(
      'format',
      code,
      '',
    )) as WorkerFormatResult;

    return {
      success: result.success,
      requestId,
      type: 'formatted',
      data: {
        formattedCode: result.formattedCode,
      },
      processingTimeMs: result.processingTimeMs,
    };
  }

  /**
   * Get document outline (symbols) for ST code.
   */
  async outline(
    code: string,
    tenantId: string,
    requestId: string,
    programId?: string,
  ): Promise<NatsLanguageReply> {
    this.validateInput(code);

    const result = (await this.workerPool.execute(
      'outline',
      code,
      tenantId,
      { programId },
    )) as WorkerOutlineResult;

    return {
      success: result.success,
      requestId,
      type: 'outline',
      data: {
        outline: result.outline,
      },
      processingTimeMs: result.processingTimeMs,
    };
  }

  /**
   * Go-to-definition for a symbol at a given position.
   */
  async definition(
    code: string,
    position: { line: number; character: number },
    tenantId: string,
    requestId: string,
    programId?: string,
  ): Promise<NatsLanguageReply> {
    this.validateInput(code);

    const result = (await this.workerPool.execute(
      'definition',
      code,
      tenantId,
      { programId, position },
    )) as WorkerDefinitionResult;

    return {
      success: result.success,
      requestId,
      type: 'definition',
      data: {
        location: result.location ?? null,
      },
      processingTimeMs: result.processingTimeMs,
    };
  }

  /**
   * Find all references for a symbol at a given position.
   */
  async references(
    code: string,
    position: { line: number; character: number },
    tenantId: string,
    requestId: string,
    programId?: string,
  ): Promise<NatsLanguageReply> {
    this.validateInput(code);

    const result = (await this.workerPool.execute(
      'references',
      code,
      tenantId,
      { programId, position },
    )) as WorkerReferencesResult;

    return {
      success: result.success,
      requestId,
      type: 'references',
      data: {
        references: result.references,
      },
      processingTimeMs: result.processingTimeMs,
    };
  }

  /**
   * Validate input before processing.
   * Enforces security limits on code size and nesting depth heuristic.
   */
  private validateInput(code: string): void {
    if (!code || typeof code !== 'string') {
      throw new Error('Code must be a non-empty string');
    }

    if (code.length > MAX_SOURCE_SIZE) {
      throw new Error(
        `Source code exceeds maximum size of ${MAX_SOURCE_SIZE} bytes (${code.length} bytes provided)`,
      );
    }

    // Heuristic nesting depth check: count max consecutive opening constructs
    const nestingIndicators = code.match(
      /\b(IF|FOR|WHILE|REPEAT|CASE)\b/gi,
    );
    if (nestingIndicators && nestingIndicators.length > 500) {
      throw new Error(
        'Source code has excessive control structure count (>500), possible malicious input',
      );
    }
  }
}
