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
  name: 'list_overdue_health_follow_ups',
  description:
    'Health events whose scheduled follow-up date has passed without a recorded follow-up. Max 50 rows. Tenant data.',
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
export class ListOverdueHealthFollowUpsTool extends FarmAiQueryTool<
  Input,
  Omit<BoundedListRequest, 'tenantId'>,
  HealthEventsReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.FH_OVERDUE_FOLLOW_UPS;
  protected readonly isData = isHealthEventsReply;

  protected toRequestFields(input: Input): Omit<BoundedListRequest, 'tenantId'> {
    return { limit: clampListLimit(input.limit) };
  }
}
