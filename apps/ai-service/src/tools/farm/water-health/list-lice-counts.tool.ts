import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  clampListLimit,
  isLiceCountsReply,
  type LiceCountsReply,
  type LiceCountsRequest,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS, LIST_LIMIT_SCHEMA, UUID_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  siteId?: string;
  tankId?: string;
  reportingYear?: number;
  reportingWeek?: number;
  limit?: number;
}

@Injectable()
@Tool({
  name: 'list_lice_counts',
  description:
    'Sea-lice counts (adult female, mobile, attached per fish sampled) by site/tank and reporting week, with sea temperature. Filter by siteId, tankId, reportingYear, reportingWeek. Max 50 rows.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      siteId: UUID_SCHEMA,
      tankId: UUID_SCHEMA,
      reportingYear: { type: 'integer', minimum: 2000, maximum: 2100 },
      reportingWeek: { type: 'integer', minimum: 1, maximum: 53 },
      limit: LIST_LIMIT_SCHEMA,
    },
  },
  requiresConfirmation: false,
})
export class ListLiceCountsTool extends FarmAiQueryTool<
  Input,
  Omit<LiceCountsRequest, 'tenantId'>,
  LiceCountsReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.FH_LICE_COUNTS;
  protected readonly isData = isLiceCountsReply;

  protected toRequestFields(input: Input): Omit<LiceCountsRequest, 'tenantId'> {
    return {
      ...(input.siteId ? { siteId: input.siteId } : {}),
      ...(input.tankId ? { tankId: input.tankId } : {}),
      ...(input.reportingYear !== undefined ? { reportingYear: input.reportingYear } : {}),
      ...(input.reportingWeek !== undefined ? { reportingWeek: input.reportingWeek } : {}),
      limit: clampListLimit(input.limit),
    };
  }
}
