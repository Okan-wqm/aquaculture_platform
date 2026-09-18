import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { ISO_DATE_SCHEMA, UUID_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { TransfersSummaryReply, isTransfersSummary } from './reply-guards';

interface Input {
  siteId: string;
  fromDate: string;
  toDate: string;
}

/** Cross-site transfers roll-up for a site + period. */
@Injectable()
@Tool({
  name: 'get_transfers_summary',
  description:
    'Cross-site fish transfers (IN/OUT) for a site and inclusive period (max 366 ' +
    'days): dated records with direction, species code, fish count, biomass kg and ' +
    'counterparty. Tank-to-tank moves inside the same site are excluded by design.',
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
export class GetTransfersSummaryTool extends FarmAiQueryTool<
  Input,
  { siteId: string; fromDate: string; toDate: string },
  TransfersSummaryReply
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.BATCH_TRANSFERS_SUMMARY);
  }

  protected isData(value: unknown): value is TransfersSummaryReply {
    return isTransfersSummary(value);
  }

  protected toRequestFields(input: Input) {
    return {
      siteId: input.siteId,
      fromDate: input.fromDate,
      toDate: input.toDate,
    };
  }
}
