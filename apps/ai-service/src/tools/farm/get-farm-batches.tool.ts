import { Injectable } from '@nestjs/common';
import { TenantBoundNatsClient } from '../../tenant-boundary/tenant-bound-nats.client';
import { BaseTool } from '../core/base-tool';
import { Tool } from '../core/tool.decorator';
import { TenantBoundToolContext } from '../core/tool.interface';
import { isBatchOverview, type BatchOverviewEntry } from './farm-overview.guards';

/** Bound so a hung farm-service cannot stall the agent turn. */
const GET_BATCHES_TIMEOUT_MS = 5000;

/** No input — the tenant is taken from the (server-populated) execution context. */
type GetFarmBatchesInput = Record<string, never>;

interface GetFarmBatchesOutput {
  batches: BatchOverviewEntry[];
  count: number;
}

/**
 * Read the tenant's batches with their lifecycle status (Faz 3a). A plain read
 * tool (no confirmation) so the assistant can ground batch questions ("what is
 * the status of B-2024-001?") in real data. Crosses to farm-service via
 * request.farm.getBatchOverview — the same NATS request-reply transport the
 * other farm tools use; the tenant comes from ctx, never from the model.
 */
@Injectable()
@Tool({
  name: 'get_farm_batches',
  description:
    "List the current tenant's batches (batch number, name, lifecycle status). " +
    'Use before answering questions about a specific batch, or to resolve a ' +
    'batch the operator names to its batch number and current status.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  requiresConfirmation: false,
})
export class GetFarmBatchesTool extends BaseTool<GetFarmBatchesInput, GetFarmBatchesOutput> {
  constructor(private readonly farm: TenantBoundNatsClient) {
    super();
  }

  protected async run(
    _input: GetFarmBatchesInput,
    ctx: TenantBoundToolContext,
  ): Promise<GetFarmBatchesOutput> {
    // K10 (MT-HIGH-062): the client injects ctx's bound tenant and refuses a
    // reply served for any other tenant before this code sees the rows.
    const batches = await this.farm.request(ctx, {
      subject: 'request.farm.getBatchOverview',
      fields: {},
      isData: isBatchOverview,
      timeoutMs: GET_BATCHES_TIMEOUT_MS,
    });
    return { batches, count: batches.length };
  }
}
