import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AiQueryList, FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import {
  LIST_LIMIT_SCHEMA,
  OPTIONAL_UUID_SCHEMA,
} from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { HealthEventReply, isAiListOf, isHealthEvent } from './reply-guards';

interface Input {
  batchId?: string;
  tankId?: string;
  activeOnly?: boolean;
  severity?: 'minor' | 'moderate' | 'severe' | 'critical';
  limit?: number;
}

/** Health events (disease/treatment records) filtered for the model surface. */
@Injectable()
@Tool({
  name: 'list_health_events',
  description:
    'Fish health events (type, severity, status, disease, event date, treatment/' +
    'quarantine/withdrawal flags), newest first. Optional batchId/tankId (resolve via ' +
    'get_farm_tanks / get_farm_batches), severity, activeOnly (default true). Max 50 ' +
    'rows; narrow the window when truncated.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: {
      batchId: OPTIONAL_UUID_SCHEMA,
      tankId: OPTIONAL_UUID_SCHEMA,
      activeOnly: { type: 'boolean', default: true },
      severity: {
        type: 'string',
        enum: ['minor', 'moderate', 'severe', 'critical'],
      },
      limit: LIST_LIMIT_SCHEMA,
    },
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class ListHealthEventsTool extends FarmAiQueryTool<
  Input,
  {
    batchId?: string;
    tankId?: string;
    activeOnly?: boolean;
    severity?: 'minor' | 'moderate' | 'severe' | 'critical';
    limit?: number;
  },
  AiQueryList<HealthEventReply>
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.FH_EVENTS);
  }

  protected isData(value: unknown): value is AiQueryList<HealthEventReply> {
    return isAiListOf(isHealthEvent)(value);
  }

  protected toRequestFields(input: Input) {
    return {
      batchId: input.batchId,
      tankId: input.tankId,
      activeOnly: input.activeOnly ?? true,
      severity: input.severity,
      limit: input.limit,
    };
  }
}
