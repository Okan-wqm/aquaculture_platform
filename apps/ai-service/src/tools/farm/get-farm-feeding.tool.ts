import { Injectable } from '@nestjs/common';
import { TenantBoundNatsClient } from '../../tenant-boundary/tenant-bound-nats.client';
import { BaseTool } from '../core/base-tool';
import { Tool } from '../core/tool.decorator';
import { TenantBoundToolContext } from '../core/tool.interface';
import { isFeedingOverview, type FeedingRecordEntry } from './farm-overview.guards';

/** Bound so a hung farm-service cannot stall the agent turn. */
const GET_FEEDING_TIMEOUT_MS = 5000;

/** No input — the tenant is taken from the (server-populated) execution context. */
type GetFeedingInput = Record<string, never>;

interface GetFeedingOutput {
  feedings: FeedingRecordEntry[];
  count: number;
}

/**
 * Read the tenant's recent feeding records (Faz 3a). A plain read tool (no
 * confirmation) so the assistant can answer feeding questions ("how much has
 * batch B been fed today?") from real data. Crosses to farm-service via
 * request.farm.getFeedingOverview — the same NATS request-reply transport the
 * other farm tools use; the tenant comes from ctx, never the model.
 */
@Injectable()
@Tool({
  name: 'get_farm_feeding',
  description:
    "The tenant's most recent feeding records (batch, tank, date/time, planned " +
    'vs actual amount in kg, newest first). Use before answering feeding ' +
    'questions; filter by batchId/tankId for a specific target.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  requiresConfirmation: false,
})
export class GetFarmFeedingTool extends BaseTool<GetFeedingInput, GetFeedingOutput> {
  constructor(private readonly farm: TenantBoundNatsClient) {
    super();
  }

  protected async run(
    _input: GetFeedingInput,
    ctx: TenantBoundToolContext,
  ): Promise<GetFeedingOutput> {
    // K10 (MT-HIGH-062): the client injects ctx's bound tenant and refuses a
    // reply served for any other tenant before this code sees the rows.
    const feedings = await this.farm.request(ctx, {
      subject: 'request.farm.getFeedingOverview',
      fields: {},
      isData: isFeedingOverview,
      timeoutMs: GET_FEEDING_TIMEOUT_MS,
    });
    return { feedings, count: feedings.length };
  }
}
