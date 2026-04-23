/**
 * FarmAppError
 *
 * Base class for every domain-specific error surfaced by farm-service.
 * Extends HttpException so existing NestJS catchers (including
 * `instanceof HttpException` checks in third-party code paths) keep
 * working, while adding a structured metadata envelope that the
 * FarmAppErrorFilter lifts into GraphQL's `extensions` block:
 *
 *   {
 *     "code":         "BATCH_WITHDRAWAL_BLOCKED",
 *     "userMessage":  "Parti aktif ilaç kesintisi…",
 *     "fieldPath":    ["createHarvestRecord", "batchId"],
 *     "retryable":    false,
 *     "correlationId":"…",
 *     "context":      { …error-specific payload… }
 *   }
 *
 * Before this phase every domain rejection returned BadRequestException
 * with a free-text `message` that the frontend had to string-match to
 * decide how to render. Now each rejection surfaces a stable `code`
 * enum that drives UI branching (the CloseBatchModal already parses
 * BATCH_WITHDRAWAL_BLOCKED — this class formalises the contract the
 * modal relies on).
 *
 * The GraphQL surface of the error is driven entirely by the subclass
 * — the filter reads the structured fields via the getter methods so
 * no string parsing or message reformatting happens at the filter
 * layer. That keeps user-facing copy localisable at source (i18n
 * landing in phase 7.1 just swaps `userMessage` via a translator).
 *
 * Phase 6.4 of the "Farm modülü kalan kör noktalar" plan. Closes
 * Girdi 15-C1 + Orphan 10.
 */
import { HttpException, HttpStatus } from '@nestjs/common';

export interface FarmAppErrorParams {
  code: string;
  status: HttpStatus;
  userMessage: string;
  logMessage?: string;
  fieldPath?: readonly string[];
  retryable?: boolean;
  context?: Record<string, unknown>;
}

export abstract class FarmAppError extends HttpException {
  public readonly code: string;
  public readonly userMessage: string;
  public readonly fieldPath?: readonly string[];
  public readonly retryable: boolean;
  public readonly context?: Record<string, unknown>;

  constructor(params: FarmAppErrorParams) {
    super(
      {
        statusCode: params.status,
        code: params.code,
        message: params.userMessage,
        userMessage: params.userMessage,
        fieldPath: params.fieldPath,
        retryable: params.retryable ?? false,
        context: params.context,
      },
      params.status,
    );
    this.code = params.code;
    this.userMessage = params.userMessage;
    this.fieldPath = params.fieldPath;
    this.retryable = params.retryable ?? false;
    this.context = params.context;
    // Server-side log message can differ from the client-facing one
    // so operators see the full technical detail while the user
    // gets the actionable summary.
    this.message = params.logMessage ?? params.userMessage;
  }
}
