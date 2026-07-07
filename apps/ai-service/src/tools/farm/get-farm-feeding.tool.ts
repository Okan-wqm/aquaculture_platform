import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { BaseTool } from '../core/base-tool';
import { Tool } from '../core/tool.decorator';
import { ToolExecutionContext } from '../core/tool.interface';

/** Bound so a hung farm-service cannot stall the agent turn. */
const GET_FEEDING_TIMEOUT_MS = 5000;

/** No input — the tenant is taken from the (server-populated) execution context. */
type GetFeedingInput = Record<string, never>;

interface FeedingRecordEntry {
  id: string;
  batchId: string;
  tankId: string | null;
  feedingDate: string;
  feedingTime: string;
  plannedAmountKg: number;
  actualAmountKg: number;
}

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
  requiresModule: null,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  requiresConfirmation: false,
})
export class GetFarmFeedingTool extends BaseTool<GetFeedingInput, GetFeedingOutput> {
  constructor(
    @Inject('NATS_SERVICE') private readonly natsClient: Pick<ClientProxy, 'send'>,
  ) {
    super();
  }

  protected async run(
    _input: GetFeedingInput,
    ctx: ToolExecutionContext,
  ): Promise<GetFeedingOutput> {
    const feedings = await firstValueFrom(
      this.natsClient
        .send<FeedingRecordEntry[]>('request.farm.getFeedingOverview', {
          tenantId: ctx.tenantId,
        })
        .pipe(timeout(GET_FEEDING_TIMEOUT_MS)),
    );
    const list = Array.isArray(feedings) ? feedings : [];
    return { feedings: list, count: list.length };
  }
}
