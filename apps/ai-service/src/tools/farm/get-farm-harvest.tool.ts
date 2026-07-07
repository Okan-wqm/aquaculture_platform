import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { BaseTool } from '../core/base-tool';
import { Tool } from '../core/tool.decorator';
import { ToolExecutionContext } from '../core/tool.interface';

/** Bound so a hung farm-service cannot stall the agent turn. */
const GET_HARVEST_TIMEOUT_MS = 5000;

/** No input — the tenant is taken from the (server-populated) execution context. */
type GetHarvestInput = Record<string, never>;

interface HarvestPlanEntry {
  id: string;
  planCode: string;
  name: string;
  batchId: string;
  status: string;
  plannedDate: string;
}

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
  requiresModule: null,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  requiresConfirmation: false,
})
export class GetFarmHarvestTool extends BaseTool<GetHarvestInput, GetHarvestOutput> {
  constructor(
    @Inject('NATS_SERVICE') private readonly natsClient: Pick<ClientProxy, 'send'>,
  ) {
    super();
  }

  protected async run(
    _input: GetHarvestInput,
    ctx: ToolExecutionContext,
  ): Promise<GetHarvestOutput> {
    const plans = await firstValueFrom(
      this.natsClient
        .send<HarvestPlanEntry[]>('request.farm.getHarvestOverview', {
          tenantId: ctx.tenantId,
        })
        .pipe(timeout(GET_HARVEST_TIMEOUT_MS)),
    );
    const list = Array.isArray(plans) ? plans : [];
    return { plans: list, count: list.length };
  }
}
