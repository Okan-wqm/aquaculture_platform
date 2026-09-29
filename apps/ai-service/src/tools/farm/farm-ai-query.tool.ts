import { Inject } from '@nestjs/common';
import type { FarmAiQuerySubject } from '@platform/event-contracts';
import {
  TenantBoundNatsClient,
  type TenantFreeFields,
} from '../../tenant-boundary/tenant-bound-nats.client';
import { BaseTool } from '../core/base-tool';
import { TenantBoundToolContext } from '../core/tool.interface';

/** Bound so a hung farm-service cannot stall the agent turn. */
export const FARM_AI_QUERY_TIMEOUT_MS = 5000;
/** Aggregate-heavy reads (performance, growth analysis, finance) get more headroom. */
export const FARM_AI_QUERY_HEAVY_TIMEOUT_MS = 8000;

/**
 * Base for every farm read tool (FARM-MEDIUM-328). A concrete tool is only
 * metadata + subject + a request mapper + a reply guard; the round trip is the
 * TenantBoundNatsClient's (K10 / MT-HIGH-062):
 *   - the mapper returns model-supplied fields only — its type cannot carry a
 *     tenant, and the client injects the context's bound tenant itself;
 *   - the reply must name that same tenant, or the run stops with
 *     tenant_mismatch before the data is read;
 *   - `{ ok: false }` and shape failures become a thrown error → BaseTool
 *     reports `success: false` and the model sees "unavailable"/"not found",
 *     not an empty list.
 */
export abstract class FarmAiQueryTool<
  TInput,
  TFields extends TenantFreeFields,
  TData,
> extends BaseTool<TInput, TData> {
  protected abstract readonly subject: FarmAiQuerySubject;
  protected abstract readonly isData: (value: unknown) => value is TData;
  protected readonly timeoutMs: number = FARM_AI_QUERY_TIMEOUT_MS;

  // WHY explicit @Inject: concrete tools declare no constructor, so Nest reads
  // this base's parameter metadata — an undecorated base emits none.
  constructor(@Inject(TenantBoundNatsClient) private readonly farm: TenantBoundNatsClient) {
    super();
  }

  /** Model-supplied fields only; defaults applied here. */
  protected abstract toRequestFields(input: TInput): TFields;

  protected run(input: TInput, ctx: TenantBoundToolContext): Promise<TData> {
    return this.farm.request(ctx, {
      subject: this.subject,
      fields: this.toRequestFields(input),
      isData: this.isData,
      timeoutMs: this.timeoutMs,
    });
  }
}
