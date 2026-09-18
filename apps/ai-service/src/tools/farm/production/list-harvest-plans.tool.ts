import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type HarvestPlansReply,
  type HarvestPlansRequest,
  clampListLimit,
  isHarvestPlansReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS, LIST_LIMIT_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  scope?: 'upcoming' | 'overdue';
  days?: number;
  limit?: number;
}

@Injectable()
@Tool({
  name: 'list_harvest_plans',
  description:
    "Harvest plans: scope 'upcoming' (next N days, default 30, max 180) or 'overdue'. Each row: code, batch, status, type, planned date and window, estimated quantity / biomass kg / avg weight g, actual biomass. Max 50 rows. Check check_batch_harvest_eligibility before recommending a date.",
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      scope: { type: 'string', enum: ['upcoming', 'overdue'] },
      days: { type: 'integer', minimum: 1, maximum: 180 },
      limit: LIST_LIMIT_SCHEMA,
    },
  },
  requiresConfirmation: false,
})
export class ListHarvestPlansTool extends FarmAiQueryTool<
  Input,
  Omit<HarvestPlansRequest, 'tenantId'>,
  HarvestPlansReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.HARVEST_PLANS;
  protected readonly isData = isHarvestPlansReply;

  protected toRequestFields(input: Input): Omit<HarvestPlansRequest, 'tenantId'> {
    return {
      scope: input.scope ?? 'upcoming',
      days: input.days ?? 30,
      limit: clampListLimit(input.limit),
    };
  }
}
