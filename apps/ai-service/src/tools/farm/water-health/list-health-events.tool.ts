import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  clampListLimit,
  isHealthEventsReply,
  type HealthEventsReply,
  type HealthEventsRequest,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS, LIST_LIMIT_SCHEMA, UUID_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  batchId?: string;
  tankId?: string;
  activeOnly?: boolean;
  severity?: 'minor' | 'moderate' | 'severe' | 'critical';
  limit?: number;
}

@Injectable()
@Tool({
  name: 'list_health_events',
  description:
    'Health events (disease outbreaks, symptoms, treatments, quarantines, mortality events…) with severity, status, withdrawal period and earliest harvest date. Filter by batchId, tankId, severity; activeOnly defaults to true. Max 50 rows, total reported.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      batchId: UUID_SCHEMA,
      tankId: UUID_SCHEMA,
      activeOnly: { type: 'boolean' },
      severity: { type: 'string', enum: ['minor', 'moderate', 'severe', 'critical'] },
      limit: LIST_LIMIT_SCHEMA,
    },
  },
  requiresConfirmation: false,
})
export class ListHealthEventsTool extends FarmAiQueryTool<
  Input,
  Omit<HealthEventsRequest, 'tenantId'>,
  HealthEventsReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.FH_EVENTS;
  protected readonly isData = isHealthEventsReply;

  protected toRequestFields(input: Input): Omit<HealthEventsRequest, 'tenantId'> {
    return {
      ...(input.batchId ? { batchId: input.batchId } : {}),
      ...(input.tankId ? { tankId: input.tankId } : {}),
      activeOnly: input.activeOnly ?? true,
      ...(input.severity ? { severity: input.severity } : {}),
      limit: clampListLimit(input.limit),
    };
  }
}
