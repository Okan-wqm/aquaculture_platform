import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { ISO_DATE_SCHEMA, OPTIONAL_UUID_SCHEMA, UUID_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { DailyFeedingPlanReply, isDailyFeedingPlan } from './reply-guards';

interface Input {
  siteId: string;
  date: string;
  departmentId?: string;
}

/** The feeding plan for one site + date. */
@Injectable()
@Tool({
  name: 'get_daily_feeding_plan',
  description:
    'Daily feeding plan for a site and date: per-tank planned vs actual kg, meals ' +
    'planned/completed, feed type, plus site totals and completion percent. ' +
    'Optionally narrow to one department.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: {
      siteId: UUID_SCHEMA,
      date: ISO_DATE_SCHEMA,
      departmentId: { ...OPTIONAL_UUID_SCHEMA, description: 'Narrow to one department' },
    },
    required: ['siteId', 'date'],
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class GetDailyFeedingPlanTool extends FarmAiQueryTool<
  Input,
  { siteId: string; date: string; departmentId?: string },
  DailyFeedingPlanReply
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.FEEDING_DAILY_PLAN);
  }

  protected isData(value: unknown): value is DailyFeedingPlanReply {
    return isDailyFeedingPlan(value);
  }

  protected toRequestFields(input: Input) {
    return {
      siteId: input.siteId,
      date: input.date,
      departmentId: input.departmentId,
    };
  }
}
