import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { UUID_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { TankCapacityReply, isTankCapacity } from '../production/reply-guards';

interface Input {
  tankId: string;
}

/**
 * Tank capacity + density. Lives under operations/ per the program plan but
 * is shared with the Production specialist (both bundles list it).
 */
@Injectable()
@Tool({
  name: 'get_tank_capacity',
  description:
    'Tank capacity and current utilization: volume, max biomass/density, optimal ' +
    'density band, current quantity/biomass/density/average weight, capacity used ' +
    'and available, density/capacity status and any warnings. Use before stocking ' +
    'or transfer decisions.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: { tankId: UUID_SCHEMA },
    required: ['tankId'],
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class GetTankCapacityTool extends FarmAiQueryTool<
  Input,
  { tankId: string },
  TankCapacityReply
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.TANK_CAPACITY);
  }

  protected isData(value: unknown): value is TankCapacityReply {
    return isTankCapacity(value);
  }

  protected toRequestFields(input: Input) {
    return { tankId: input.tankId };
  }
}
