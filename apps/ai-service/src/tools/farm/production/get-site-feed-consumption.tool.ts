import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type SiteFeedConsumptionReply,
  type SiteWindowRequest,
  isSiteFeedConsumptionReply,
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
  name: 'get_site_feed_consumption',
  description:
    'Total feed consumed at ONE site between two dates (YYYY-MM-DD, at most 366 days), split by feed type and brand. Tenant data.',
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
export class GetSiteFeedConsumptionTool extends FarmAiQueryTool<
  Input,
  Omit<SiteWindowRequest, 'tenantId'>,
  SiteFeedConsumptionReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.FEEDING_SITE_CONSUMPTION;
  protected readonly isData = isSiteFeedConsumptionReply;

  protected toRequestFields(input: Input): Omit<SiteWindowRequest, 'tenantId'> {
    return { siteId: input.siteId, fromDate: input.fromDate, toDate: input.toDate };
  }
}
