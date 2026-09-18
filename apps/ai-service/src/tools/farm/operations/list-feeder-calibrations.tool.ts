import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AiQueryList, FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { LIST_LIMIT_SCHEMA, UUID_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import {
  FeederCalibrationReply,
  isAiListOf,
  isFeederCalibration,
} from './reply-guards';

interface Input {
  equipmentId: string;
  limit?: number;
}

/** Feeder calibration table for one feeder. */
@Injectable()
@Tool({
  name: 'list_feeder_calibrations',
  description:
    'Calibration table for one feeder equipment: feed size (mm and label), grams ' +
    'per dispensing and silo capacity kg per row. Use when converting a feeding ' +
    'plan from kg to dispensing counts.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: {
      equipmentId: UUID_SCHEMA,
      limit: LIST_LIMIT_SCHEMA,
    },
    required: ['equipmentId'],
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class ListFeederCalibrationsTool extends FarmAiQueryTool<
  Input,
  { equipmentId: string; limit?: number },
  AiQueryList<FeederCalibrationReply>
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.EQUIPMENT_FEEDER_CALIBRATIONS);
  }

  protected isData(value: unknown): value is AiQueryList<FeederCalibrationReply> {
    return isAiListOf(isFeederCalibration)(value);
  }

  protected toRequestFields(input: Input) {
    return { equipmentId: input.equipmentId, limit: input.limit };
  }
}
