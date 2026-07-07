import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { BaseTool } from '../core/base-tool';
import { Tool } from '../core/tool.decorator';
import { ToolExecutionContext } from '../core/tool.interface';

/** Bound so a hung farm-service cannot stall the agent turn. */
const GET_BATCHES_TIMEOUT_MS = 5000;

/** No input — the tenant is taken from the (server-populated) execution context. */
type GetFarmBatchesInput = Record<string, never>;

interface BatchOverviewEntry {
  id: string;
  batchNumber: string;
  name: string | null;
  status: string;
  statusChangedAt: string | null;
}

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
  requiresModule: null,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  requiresConfirmation: false,
})
export class GetFarmBatchesTool extends BaseTool<GetFarmBatchesInput, GetFarmBatchesOutput> {
  constructor(
    @Inject('NATS_SERVICE') private readonly natsClient: Pick<ClientProxy, 'send'>,
  ) {
    super();
  }

  protected async run(
    _input: GetFarmBatchesInput,
    ctx: ToolExecutionContext,
  ): Promise<GetFarmBatchesOutput> {
    const batches = await firstValueFrom(
      this.natsClient
        .send<BatchOverviewEntry[]>('request.farm.getBatchOverview', {
          tenantId: ctx.tenantId,
        })
        .pipe(timeout(GET_BATCHES_TIMEOUT_MS)),
    );
    const list = Array.isArray(batches) ? batches : [];
    return { batches: list, count: list.length };
  }
}
