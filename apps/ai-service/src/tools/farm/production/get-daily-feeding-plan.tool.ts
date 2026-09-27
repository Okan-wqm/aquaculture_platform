import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type DailyFeedingPlanReply,
  type DailyFeedingPlanRequest,
  isDailyFeedingPlanReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS, ISO_DATE_SCHEMA, UUID_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  siteId: string;
  date: string;
  departmentId?: string;
}

@Injectable()
@Tool({
  name: 'get_daily_feeding_plan',
  description:
    'Planned vs actual feeding of ONE site on ONE date (YYYY-MM-DD): totals, completion %, and per batch/tank/feed rows (planned and actual kg, meals planned/completed). Optional departmentId. Max 50 rows.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['siteId', 'date'],
    properties: { siteId: UUID_SCHEMA, date: ISO_DATE_SCHEMA, departmentId: UUID_SCHEMA },
  },
  requiresConfirmation: false,
})
export class GetDailyFeedingPlanTool extends FarmAiQueryTool<
  Input,
  Omit<DailyFeedingPlanRequest, 'tenantId'>,
  DailyFeedingPlanReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.FEEDING_DAILY_PLAN;
  protected readonly isData = isDailyFeedingPlanReply;

  protected toRequestFields(input: Input): Omit<DailyFeedingPlanRequest, 'tenantId'> {
    return {
      siteId: input.siteId,
      date: input.date,
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
    };
  }
}
