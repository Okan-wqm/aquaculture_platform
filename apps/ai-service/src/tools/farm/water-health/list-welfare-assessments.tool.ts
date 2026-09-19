import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  clampListLimit,
  isWelfareAssessmentsReply,
  type WelfareAssessmentsReply,
  type WelfareAssessmentsRequest,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import {
  ALL_TIERS,
  ISO_DATE_SCHEMA,
  LIST_LIMIT_SCHEMA,
  UUID_SCHEMA,
} from '../farm-ai-query.schema';

interface Input {
  siteId?: string;
  tankId?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

@Injectable()
@Tool({
  name: 'list_welfare_assessments',
  description:
    'Fish welfare assessments (gill, fin, wound and deformity scores per fish sampled) by site/tank and date window (YYYY-MM-DD). Max 50 rows. Tenant data.',
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
      fromDate: ISO_DATE_SCHEMA,
      toDate: ISO_DATE_SCHEMA,
      limit: LIST_LIMIT_SCHEMA,
    },
  },
  requiresConfirmation: false,
})
export class ListWelfareAssessmentsTool extends FarmAiQueryTool<
  Input,
  Omit<WelfareAssessmentsRequest, 'tenantId'>,
  WelfareAssessmentsReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.FH_WELFARE;
  protected readonly isData = isWelfareAssessmentsReply;

  protected toRequestFields(input: Input): Omit<WelfareAssessmentsRequest, 'tenantId'> {
    return {
      ...(input.siteId ? { siteId: input.siteId } : {}),
      ...(input.tankId ? { tankId: input.tankId } : {}),
      ...(input.fromDate ? { fromDate: input.fromDate } : {}),
      ...(input.toDate ? { toDate: input.toDate } : {}),
      limit: clampListLimit(input.limit),
    };
  }
}
