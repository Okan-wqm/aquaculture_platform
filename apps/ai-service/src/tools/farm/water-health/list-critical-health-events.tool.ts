import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  clampListLimit,
  isHealthEventsReply,
  type BoundedListRequest,
  type HealthEventsReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS, LIST_LIMIT_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  limit?: number;
}

@Injectable()
@Tool({
  name: 'list_critical_health_events',
  description:
    "The tenant's currently critical health events. Scan these before any health assessment. Max 50 rows.",
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { limit: LIST_LIMIT_SCHEMA },
  },
  requiresConfirmation: false,
})
export class ListCriticalHealthEventsTool extends FarmAiQueryTool<
  Input,
  Omit<BoundedListRequest, 'tenantId'>,
  HealthEventsReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.FH_CRITICAL;
  protected readonly isData = isHealthEventsReply;

  protected toRequestFields(input: Input): Omit<BoundedListRequest, 'tenantId'> {
    return { limit: clampListLimit(input.limit) };
  }
}
