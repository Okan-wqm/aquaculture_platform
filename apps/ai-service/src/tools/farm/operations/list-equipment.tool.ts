import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AiQueryList, FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import {
  LIST_LIMIT_SCHEMA,
  OPTIONAL_UUID_SCHEMA,
} from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { EquipmentReply, isAiListOf, isEquipment } from './reply-guards';

interface Input {
  equipmentTypeId?: string;
  status?: string;
  isTank?: boolean;
  limit?: number;
}

/** Unified equipment + tank listing. */
@Injectable()
@Tool({
  name: 'list_equipment',
  description:
    'Equipment catalogue (equipment AND tanks merged): name/code, type, category, ' +
    'manufacturer/model, operational status, tank flag with volume and current ' +
    'biomass. Optional equipmentTypeId, status and isTank filters. Max 50 rows.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: {
      equipmentTypeId: OPTIONAL_UUID_SCHEMA,
      status: {
        type: 'string',
        enum: [
          'operational',
          'maintenance',
          'repair',
          'out_of_service',
          'decommissioned',
          'standby',
          'active',
          'preparing',
          'cleaning',
          'harvesting',
          'fallow',
          'quarantine',
        ],
        description: 'Operational status filter',
      },
      isTank: { type: 'boolean', description: 'Only tanks (true) or only non-tanks (false)' },
      limit: LIST_LIMIT_SCHEMA,
    },
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class ListEquipmentTool extends FarmAiQueryTool<
  Input,
  { equipmentTypeId?: string; status?: string; isTank?: boolean; limit?: number },
  AiQueryList<EquipmentReply>
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.EQUIPMENT_LIST);
  }

  protected isData(value: unknown): value is AiQueryList<EquipmentReply> {
    return isAiListOf(isEquipment)(value);
  }

  protected toRequestFields(input: Input) {
    return {
      equipmentTypeId: input.equipmentTypeId,
      status: input.status,
      isTank: input.isTank,
      limit: input.limit,
    };
  }
}
