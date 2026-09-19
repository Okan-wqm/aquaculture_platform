import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type TankCapacityReply,
  type TankCapacityRequest,
  isTankCapacityReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS, UUID_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  tankId: string;
}

@Injectable()
@Tool({
  name: 'get_tank_capacity',
  description:
    'Capacity and stocking density of ONE tank: volume, max and optimal density, current quantity, biomass, density and avg weight, capacity used/available and %, density and capacity status, primary batch, warnings. Resolve tank ids with get_farm_tanks first.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['tankId'],
    properties: { tankId: UUID_SCHEMA },
  },
  requiresConfirmation: false,
})
export class GetTankCapacityTool extends FarmAiQueryTool<
  Input,
  Omit<TankCapacityRequest, 'tenantId'>,
  TankCapacityReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.TANK_CAPACITY;
  protected readonly isData = isTankCapacityReply;

  protected toRequestFields(input: Input): Omit<TankCapacityRequest, 'tenantId'> {
    return { tankId: input.tankId };
  }
}
