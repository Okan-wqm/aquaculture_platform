import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AiQueryList, FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { LIST_LIMIT_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { FeedProtocolReply, isAiListOf, isFeedProtocol } from './reply-guards';

/** No filter input — the catalogue is tenant-wide. */
type Input = { limit?: number };

/** Feeding protocol catalogue. */
@Injectable()
@Tool({
  name: 'list_feeding_protocols',
  description:
    'Feeding protocol catalogue: species and life stage, target FCR, minimum ' +
    'dissolved oxygen and optimal temperature band, active/default flags. ' +
    'Max 50 rows; narrow with limit when truncated.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: { limit: LIST_LIMIT_SCHEMA },
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class ListFeedingProtocolsTool extends FarmAiQueryTool<
  Input,
  { limit?: number },
  AiQueryList<FeedProtocolReply>
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.FEED_PROTOCOLS);
  }

  protected isData(value: unknown): value is AiQueryList<FeedProtocolReply> {
    return isAiListOf(isFeedProtocol)(value);
  }

  protected toRequestFields(input: Input) {
    return { limit: input.limit };
  }
}
