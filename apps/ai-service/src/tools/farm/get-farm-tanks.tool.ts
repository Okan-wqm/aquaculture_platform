import { Injectable } from '@nestjs/common';
import { TenantBoundNatsClient } from '../../tenant-boundary/tenant-bound-nats.client';
import { BaseTool } from '../core/base-tool';
import { Tool } from '../core/tool.decorator';
import { TenantBoundToolContext } from '../core/tool.interface';
import { isTankRegistry, type TankRegistryEntry } from './farm-overview.guards';

/** Bound so a hung farm-service cannot stall the agent turn. */
const GET_TANKS_TIMEOUT_MS = 5000;

/** No input — the tenant is taken from the (server-populated) execution context. */
type GetFarmTanksInput = Record<string, never>;

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
  requiresModule: 'farm',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  requiresConfirmation: false,
})
export class GetFarmTanksTool extends BaseTool<GetFarmTanksInput, GetFarmTanksOutput> {
  constructor(private readonly farm: TenantBoundNatsClient) {
    super();
  }

  protected async run(
    _input: GetFarmTanksInput,
    ctx: TenantBoundToolContext,
  ): Promise<GetFarmTanksOutput> {
    // K10 (MT-HIGH-062): the client injects ctx's bound tenant and refuses a
    // reply served for any other tenant before this code sees the rows.
    const tanks = await this.farm.request(ctx, {
      subject: 'request.farm.getTankRegistry',
      fields: {},
      isData: isTankRegistry,
      timeoutMs: GET_TANKS_TIMEOUT_MS,
    });
    return { tanks, count: tanks.length };
  }
}
