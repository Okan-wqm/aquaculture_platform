/**
 * Base class for the PR-3 farm-AI read-only query tools (Water & Health
 * specialist). Encapsulates the whole request/reply discipline so the 13
 * concrete tools stay declarative:
 *
 *  - tenant pin: the request's `tenantId` ALWAYS comes from the verified
 *    execution context — any tenantId the model tried to pass is dropped
 *    (spread order puts ctx last).
 *  - envelope: farm-service replies `{ ok, data | error }` (see
 *    libs/event-contracts/src/farm-ai-queries.ts). `ok:false` → thrown
 *    Error (BaseTool converts it into a success:false ToolResult for the
 *    model); `ok:true` → the data MUST pass the subclass guard or the tool
 *    fails loudly instead of feeding the model an unexpected shape.
 *  - timeout: a hung farm-service must not stall the agent turn.
 */
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import {
  AiQueryReply,
  isAiQueryReply,
} from '@platform/event-contracts';
import { BaseTool } from '../core/base-tool';
import { ToolExecutionContext } from '../core/tool.interface';

/** Bound so a hung farm-service cannot stall the agent turn. */
export const FARM_AI_QUERY_TIMEOUT_MS = 8000;

export abstract class FarmAiQueryTool<TInput, TFields, TData> extends BaseTool<
  TInput,
  TData
> {
  /** Contract subject this tool publishes (FARM_AI_QUERY_SUBJECTS.*). */
  protected readonly subject: string;

  constructor(
    private readonly natsClient: Pick<ClientProxy, 'send'>,
    subject: string,
  ) {
    super();
    this.subject = subject;
  }

  /** Narrow the reply `data` — the last line of defense before the model. */
  protected abstract isData(value: unknown): value is TData;

  /** Map validated model input to the subject's request fields (no tenantId). */
  protected abstract toRequestFields(input: TInput): TFields;

  protected async run(input: TInput, ctx: ToolExecutionContext): Promise<TData> {
    const request = {
      ...this.toRequestFields(input),
      // ALWAYS the verified context tenant — a model-supplied tenantId is
      // overwritten by construction (last key wins).
      tenantId: ctx.tenantId,
    };

    const reply = await firstValueFrom(
      this.natsClient
        .send<AiQueryReply<TData>>(this.subject, request)
        .pipe(timeout(FARM_AI_QUERY_TIMEOUT_MS)),
    );

    if (!isAiQueryReply(reply)) {
      throw new Error('farm query failed: malformed reply envelope');
    }
    if (!reply.ok) {
      // BaseTool catches and converts this into success:false for the model.
      throw new Error(`farm query failed: ${reply.error}`);
    }
    if (!this.isData(reply.data)) {
      throw new Error('farm query failed: unexpected data shape');
    }
    return reply.data;
  }
}
