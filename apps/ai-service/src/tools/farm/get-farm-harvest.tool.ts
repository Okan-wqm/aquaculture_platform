import { Injectable } from '@nestjs/common';
import { TenantBoundNatsClient } from '../../tenant-boundary/tenant-bound-nats.client';
import { BaseTool } from '../core/base-tool';
import { Tool } from '../core/tool.decorator';
import { TenantBoundToolContext } from '../core/tool.interface';
import { isHarvestOverview, type HarvestPlanEntry } from './farm-overview.guards';

/** Bound so a hung farm-service cannot stall the agent turn. */
const GET_HARVEST_TIMEOUT_MS = 5000;

/** No input — the tenant is taken from the (server-populated) execution context. */
type GetHarvestInput = Record<string, never>;

interface GetHarvestOutput {
  plans: HarvestPlanEntry[];
  count: number;
}

/**
 * Read the tenant's harvest plans (Faz 3a). A plain read tool (no confirmation)
 * so the assistant can answer harvest-planning questions ("what harvests are
 * coming up?", "is batch B scheduled?") from real data. Crosses to farm-service
 * via request.farm.getHarvestOverview — the same NATS request-reply transport
 * the other farm tools use; the tenant comes from ctx, never the model.
 */
@Injectable()
@Tool({
  name: 'get_farm_harvest',
  description:
    "The tenant's harvest plans (plan code, name, batch, status, planned date, " +
    'soonest first). Use before answering harvest-planning questions; filter by ' +
    'batchId to check whether a specific batch is scheduled.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  requiresConfirmation: false,
})
export class GetFarmHarvestTool extends BaseTool<GetHarvestInput, GetHarvestOutput> {
  constructor(private readonly farm: TenantBoundNatsClient) {
    super();
  }

  protected async run(
    _input: GetHarvestInput,
    ctx: TenantBoundToolContext,
  ): Promise<GetHarvestOutput> {
    // K10 (MT-HIGH-062): the client injects ctx's bound tenant and refuses a
    // reply served for any other tenant before this code sees the rows.
    const plans = await this.farm.request(ctx, {
      subject: 'request.farm.getHarvestOverview',
      fields: {},
      isData: isHarvestOverview,
      timeoutMs: GET_HARVEST_TIMEOUT_MS,
    });
    return { plans, count: plans.length };
  }
}
