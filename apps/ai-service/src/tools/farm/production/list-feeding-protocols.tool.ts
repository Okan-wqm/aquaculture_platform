import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type FeedingProtocolsReply,
  type FeedingProtocolsRequest,
  clampListLimit,
  isFeedingProtocolsReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS, LIST_LIMIT_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  species?: string;
  limit?: number;
}

@Injectable()
@Tool({
  name: 'list_feeding_protocols',
  description:
    "The tenant's active feeding protocols (name, species, life stage, feed, target FCR, minimum dissolved oxygen, default flag). Filter by species code. Max 50 rows.",
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { species: { type: 'string', maxLength: 64 }, limit: LIST_LIMIT_SCHEMA },
  },
  requiresConfirmation: false,
})
export class ListFeedingProtocolsTool extends FarmAiQueryTool<
  Input,
  Omit<FeedingProtocolsRequest, 'tenantId'>,
  FeedingProtocolsReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.FEED_PROTOCOLS;
  protected readonly isData = isFeedingProtocolsReply;

  protected toRequestFields(input: Input): Omit<FeedingProtocolsRequest, 'tenantId'> {
    return {
      ...(input.species ? { species: input.species } : {}),
      limit: clampListLimit(input.limit),
    };
  }
}
