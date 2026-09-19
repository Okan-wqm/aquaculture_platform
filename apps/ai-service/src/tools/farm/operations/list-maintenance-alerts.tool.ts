import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type BoundedListRequest,
  type MaintenanceAlertsReply,
  clampListLimit,
  isMaintenanceAlertsReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS, LIST_LIMIT_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  limit?: number;
}

@Injectable()
@Tool({
  name: 'list_maintenance_alerts',
  description:
    'Maintenance schedules that are due today, overdue or coming up: schedule code and name, category, asset, next due date, days until due, alert type. Max 50 rows.',
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
export class ListMaintenanceAlertsTool extends FarmAiQueryTool<
  Input,
  Omit<BoundedListRequest, 'tenantId'>,
  MaintenanceAlertsReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.MAINT_SCHEDULE_ALERTS;
  protected readonly isData = isMaintenanceAlertsReply;

  protected toRequestFields(input: Input): Omit<BoundedListRequest, 'tenantId'> {
    return { limit: clampListLimit(input.limit) };
  }
}
