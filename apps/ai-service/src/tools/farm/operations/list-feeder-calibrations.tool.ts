import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type FeederCalibrationsReply,
  type FeederCalibrationsRequest,
  clampListLimit,
  isFeederCalibrationsReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS, LIST_LIMIT_SCHEMA, UUID_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  equipmentId: string;
  limit?: number;
}

@Injectable()
@Tool({
  name: 'list_feeder_calibrations',
  description:
    'Calibration records of ONE feeder (equipmentId): feed size mm and label, grams dispensed per cycle, silo capacity kg, last update. Use to convert feeder cycles into kg. Max 50 rows.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['equipmentId'],
    properties: { equipmentId: UUID_SCHEMA, limit: LIST_LIMIT_SCHEMA },
  },
  requiresConfirmation: false,
})
export class ListFeederCalibrationsTool extends FarmAiQueryTool<
  Input,
  Omit<FeederCalibrationsRequest, 'tenantId'>,
  FeederCalibrationsReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.EQUIPMENT_FEEDER_CALIBRATIONS;
  protected readonly isData = isFeederCalibrationsReply;

  protected toRequestFields(input: Input): Omit<FeederCalibrationsRequest, 'tenantId'> {
    return { equipmentId: input.equipmentId, limit: clampListLimit(input.limit) };
  }
}
