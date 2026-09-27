import { Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import {
  isAiQueryReply,
  type AiQueryErrorCode,
  type AiQueryRequest,
  type FarmAiQuerySubject,
} from '@platform/event-contracts';
import { BaseTool } from '../core/base-tool';
import { ToolExecutionContext } from '../core/tool.interface';

/** Bound so a hung farm-service cannot stall the agent turn. */
export const FARM_AI_QUERY_TIMEOUT_MS = 5000;
/** Aggregate-heavy reads (performance, growth analysis, finance) get more headroom. */
export const FARM_AI_QUERY_HEAVY_TIMEOUT_MS = 8000;

const ERROR_TEXT: Readonly<Record<AiQueryErrorCode, string>> = {
  INVALID_REQUEST: 'Farm data request was rejected as invalid; check the ids and dates you passed.',
  INTERNAL_ERROR: 'Farm data is temporarily unavailable; say so instead of estimating.',
};

/**
 * Base for every farm read tool (FARM-MEDIUM-328). Owns the NATS round trip
 * so a concrete tool is only metadata + subject + a request mapper + a reply
 * guard:
 *   - the tenant id is composed from the execution context, never from the
 *     model (a model-supplied tenantId cannot reach the request);
 *   - the reply is checked against the envelope and the tool's own contract
 *     guard, so a foreign or malformed payload becomes a tool error;
 *   - `{ ok: false }` becomes a thrown error → BaseTool reports
 *     `success: false` and the model sees "unavailable", not an empty list.
 */
export abstract class FarmAiQueryTool<TInput, TFields extends object, TData> extends BaseTool<
  TInput,
  TData
> {
  protected abstract readonly subject: FarmAiQuerySubject;
  protected abstract readonly isData: (value: unknown) => value is TData;
  protected readonly timeoutMs: number = FARM_AI_QUERY_TIMEOUT_MS;

  constructor(@Inject('NATS_SERVICE') private readonly natsClient: Pick<ClientProxy, 'send'>) {
    super();
  }

  /** Model-supplied fields only; defaults applied here. */
  protected abstract toRequestFields(input: TInput): TFields;

  protected async run(input: TInput, ctx: ToolExecutionContext): Promise<TData> {
    const request: TFields & AiQueryRequest = {
      ...this.toRequestFields(input),
      tenantId: ctx.tenantId,
    };
    const reply = await firstValueFrom(
      this.natsClient.send<unknown>(this.subject, request).pipe(timeout(this.timeoutMs)),
    );
    if (!isAiQueryReply(reply)) {
      throw new Error(`farm-service returned an unrecognised reply for ${this.subject}`);
    }
    if (!reply.ok) {
      throw new Error(ERROR_TEXT[reply.error]);
    }
    if (!this.isData(reply.data)) {
      throw new Error(`farm-service reply for ${this.subject} failed the contract guard`);
    }
    return reply.data;
  }
}
