import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AiQueryList, FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { LIST_LIMIT_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ScheduleAlertReply, isAiListOf, isScheduleAlert } from './reply-guards';

type Input = { limit?: number };

/** Maintenance schedules that need attention. */
@Injectable()
@Tool({
  name: 'list_maintenance_alerts',
  description:
    'Maintenance schedules currently raising an alert (upcoming, due today or ' +
    'overdue) with days-until-due, next due date, asset, category and estimated ' +
    'duration/cost. Max 50 rows; narrow with limit when truncated.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: { limit: LIST_LIMIT_SCHEMA },
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class ListMaintenanceAlertsTool extends FarmAiQueryTool<
  Input,
  { limit?: number },
  AiQueryList<ScheduleAlertReply>
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.MAINT_SCHEDULE_ALERTS);
  }

  protected isData(value: unknown): value is AiQueryList<ScheduleAlertReply> {
    return isAiListOf(isScheduleAlert)(value);
  }

  protected toRequestFields(input: Input) {
    return { limit: input.limit };
  }
}
