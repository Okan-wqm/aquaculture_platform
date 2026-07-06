import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { BaseTool } from '../core/base-tool';
import { Tool } from '../core/tool.decorator';
import { ToolExecutionContext } from '../core/tool.interface';

/** Bound so a hung farm-service cannot stall the agent turn. */
const GET_TANKS_TIMEOUT_MS = 5000;

/** No input — the tenant is taken from the (server-populated) execution context. */
type GetFarmTanksInput = Record<string, never>;

interface TankRegistryEntry {
  id: string;
  code: string;
  name: string;
  status: string;
}

interface GetFarmTanksOutput {
  tanks: TankRegistryEntry[];
  count: number;
}

/**
 * Read the tenant's live tank list (Faz 3a). A plain read tool (no confirmation)
 * that lets the assistant ground answers about tanks in real data instead of
 * guessing. Crosses to farm-service via request.farm.getTankRegistry — the same
 * NATS request-reply transport create_task uses; farm-service reads through the
 * tenant-context SSoT. The tenant comes from ctx (populated from the verified
 * identity), never from the model.
 */
@Injectable()
@Tool({
  name: 'get_farm_tanks',
  description:
    "List the current tenant's tanks (id, code, name, status). Use before " +
    'answering questions about specific tanks, or to resolve a tank the operator ' +
    'names to its code.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: null,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  requiresConfirmation: false,
})
export class GetFarmTanksTool extends BaseTool<GetFarmTanksInput, GetFarmTanksOutput> {
  constructor(
    @Inject('NATS_SERVICE') private readonly natsClient: Pick<ClientProxy, 'send'>,
  ) {
    super();
  }

  protected async run(
    _input: GetFarmTanksInput,
    ctx: ToolExecutionContext,
  ): Promise<GetFarmTanksOutput> {
    const tanks = await firstValueFrom(
      this.natsClient
        .send<TankRegistryEntry[]>('request.farm.getTankRegistry', {
          tenantId: ctx.tenantId,
        })
        .pipe(timeout(GET_TANKS_TIMEOUT_MS)),
    );
    const list = Array.isArray(tanks) ? tanks : [];
    return { tanks: list, count: list.length };
  }
}
