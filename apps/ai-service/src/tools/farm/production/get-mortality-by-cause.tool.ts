import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type MortalityByCauseReply,
  type SiteWindowRequest,
  isMortalityByCauseReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS, ISO_DATE_SCHEMA, UUID_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  siteId: string;
  fromDate: string;
  toDate: string;
}

@Injectable()
@Tool({
  name: 'get_mortality_by_cause',
  description:
    'Mortality of ONE site between two dates (YYYY-MM-DD, at most 366 days) broken down by cause with counts and percentages. Tenant data.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['siteId', 'fromDate', 'toDate'],
    properties: { siteId: UUID_SCHEMA, fromDate: ISO_DATE_SCHEMA, toDate: ISO_DATE_SCHEMA },
  },
  requiresConfirmation: false,
})
export class GetMortalityByCauseTool extends FarmAiQueryTool<
  Input,
  Omit<SiteWindowRequest, 'tenantId'>,
  MortalityByCauseReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.BATCH_MORTALITY_BY_CAUSE;
  protected readonly isData = isMortalityByCauseReply;

  protected toRequestFields(input: Input): Omit<SiteWindowRequest, 'tenantId'> {
    return { siteId: input.siteId, fromDate: input.fromDate, toDate: input.toDate };
  }
}
