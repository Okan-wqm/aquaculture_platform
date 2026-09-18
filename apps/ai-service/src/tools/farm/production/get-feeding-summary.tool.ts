import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { OPTIONAL_ISO_DATE_SCHEMA, UUID_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { FeedingSummaryReply, isFeedingSummary } from './reply-guards';

interface Input {
  entityType: 'batch' | 'tank';
  entityId: string;
  fromDate?: string;
  toDate?: string;
}

/** Feeding summary for a batch or tank. */
@Injectable()
@Tool({
  name: 'get_feeding_summary',
  description:
    'Feeding summary for one batch or tank: planned vs actual kg, variance and ' +
    'waste, feed cost, average daily feeding, appetite distribution, feed-type ' +
    'distribution and a daily trend. Optional inclusive fromDate/toDate window ' +
    '(max 366 days).',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: {
      entityType: {
        type: 'string',
        enum: ['batch', 'tank'],
        description: 'Whether entityId refers to a batch or a tank',
      },
      entityId: UUID_SCHEMA,
      fromDate: { ...OPTIONAL_ISO_DATE_SCHEMA, description: 'Inclusive window start' },
      toDate: { ...OPTIONAL_ISO_DATE_SCHEMA, description: 'Inclusive window end' },
    },
    required: ['entityType', 'entityId'],
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class GetFeedingSummaryTool extends FarmAiQueryTool<
  Input,
  {
    entityType: 'batch' | 'tank';
    entityId: string;
    fromDate?: string;
    toDate?: string;
  },
  FeedingSummaryReply
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.FEEDING_SUMMARY);
  }

  protected isData(value: unknown): value is FeedingSummaryReply {
    return isFeedingSummary(value);
  }

  protected toRequestFields(input: Input) {
    return {
      entityType: input.entityType,
      entityId: input.entityId,
      fromDate: input.fromDate,
      toDate: input.toDate,
    };
  }
}
