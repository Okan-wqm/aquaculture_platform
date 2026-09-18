import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { ISO_DATE_SCHEMA, UUID_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { SiteFeedConsumptionReply, isSiteFeedConsumption } from './reply-guards';

interface Input {
  siteId: string;
  fromDate: string;
  toDate: string;
}

/** Site-wide feed consumption by feed type. */
@Injectable()
@Tool({
  name: 'get_site_feed_consumption',
  description:
    'Actual feed consumption by feed type for a site and inclusive period (max ' +
    '366 days), summed from feeding records — the real ledger, not an estimate. ' +
    'Returns total kg plus per-feed-type quantity.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: {
      siteId: UUID_SCHEMA,
      fromDate: { ...ISO_DATE_SCHEMA, description: 'Inclusive window start' },
      toDate: { ...ISO_DATE_SCHEMA, description: 'Inclusive window end' },
    },
    required: ['siteId', 'fromDate', 'toDate'],
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class GetSiteFeedConsumptionTool extends FarmAiQueryTool<
  Input,
  { siteId: string; fromDate: string; toDate: string },
  SiteFeedConsumptionReply
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.FEEDING_SITE_CONSUMPTION);
  }

  protected isData(value: unknown): value is SiteFeedConsumptionReply {
    return isSiteFeedConsumption(value);
  }

  protected toRequestFields(input: Input) {
    return {
      siteId: input.siteId,
      fromDate: input.fromDate,
      toDate: input.toDate,
    };
  }
}
