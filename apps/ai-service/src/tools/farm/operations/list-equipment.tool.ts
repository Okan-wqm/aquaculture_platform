import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type EquipmentListReply,
  type EquipmentListRequest,
  clampListLimit,
  isEquipmentListReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS, LIST_LIMIT_SCHEMA, UUID_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  equipmentTypeId?: string;
  status?: string;
  isTank?: boolean;
  limit?: number;
}

@Injectable()
@Tool({
  name: 'list_equipment',
  description:
    "The tenant's active equipment (code, name, type, status, manufacturer/model, installation and warranty dates, next maintenance date, operating hours, tank flag). Filter by equipmentTypeId, status (operational, maintenance, repair, out_of_service, standby, active…) or isTank. Max 50 rows.",
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      equipmentTypeId: UUID_SCHEMA,
      status: { type: 'string', maxLength: 32 },
      isTank: { type: 'boolean' },
      limit: LIST_LIMIT_SCHEMA,
    },
  },
  requiresConfirmation: false,
})
export class ListEquipmentTool extends FarmAiQueryTool<
  Input,
  Omit<EquipmentListRequest, 'tenantId'>,
  EquipmentListReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.EQUIPMENT_LIST;
  protected readonly isData = isEquipmentListReply;

  protected toRequestFields(input: Input): Omit<EquipmentListRequest, 'tenantId'> {
    return {
      ...(input.equipmentTypeId ? { equipmentTypeId: input.equipmentTypeId } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.isTank !== undefined ? { isTank: input.isTank } : {}),
      limit: clampListLimit(input.limit),
    };
  }
}
