import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type FeedingSummaryReply,
  type FeedingSummaryRequest,
  isFeedingSummaryReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS, ISO_DATE_SCHEMA, UUID_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  entityType: 'batch' | 'tank';
  entityId: string;
  fromDate?: string;
  toDate?: string;
}

@Injectable()
@Tool({
  name: 'get_feeding_summary',
  description:
    'Feeding summary of ONE batch or tank, optionally between two dates (YYYY-MM-DD): planned/actual/variance/waste kg, feed cost, avg daily feeding, appetite distribution, feed type split, and the last 31 days of daily planned vs actual.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['entityType', 'entityId'],
    properties: {
      entityType: { type: 'string', enum: ['batch', 'tank'] },
      entityId: UUID_SCHEMA,
      fromDate: ISO_DATE_SCHEMA,
      toDate: ISO_DATE_SCHEMA,
    },
  },
  requiresConfirmation: false,
})
export class GetFeedingSummaryTool extends FarmAiQueryTool<
  Input,
  Omit<FeedingSummaryRequest, 'tenantId'>,
  FeedingSummaryReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.FEEDING_SUMMARY;
  protected readonly isData = isFeedingSummaryReply;

  protected toRequestFields(input: Input): Omit<FeedingSummaryRequest, 'tenantId'> {
    return {
      entityType: input.entityType,
      entityId: input.entityId,
      ...(input.fromDate ? { fromDate: input.fromDate } : {}),
      ...(input.toDate ? { toDate: input.toDate } : {}),
    };
  }
}
