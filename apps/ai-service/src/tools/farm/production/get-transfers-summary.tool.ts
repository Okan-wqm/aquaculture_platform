import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type SiteWindowRequest,
  type TransfersSummaryReply,
  isTransfersSummaryReply,
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
  name: 'get_transfers_summary',
  description:
    'Fish transfers in and out of ONE site between two dates (YYYY-MM-DD, at most 366 days): totals by direction and up to 50 records (date, direction, species, count, biomass kg).',
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
export class GetTransfersSummaryTool extends FarmAiQueryTool<
  Input,
  Omit<SiteWindowRequest, 'tenantId'>,
  TransfersSummaryReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.BATCH_TRANSFERS_SUMMARY;
  protected readonly isData = isTransfersSummaryReply;

  protected toRequestFields(input: Input): Omit<SiteWindowRequest, 'tenantId'> {
    return { siteId: input.siteId, fromDate: input.fromDate, toDate: input.toDate };
  }
}
