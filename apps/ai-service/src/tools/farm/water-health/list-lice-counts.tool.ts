import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AiQueryList, FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import {
  LIST_LIMIT_SCHEMA,
  OPTIONAL_UUID_SCHEMA,
} from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { LiceCountReply, isAiListOf, isLiceCount } from './reply-guards';

interface Input {
  siteId?: string;
  tankId?: string;
  reportingYear?: number;
  reportingWeek?: number;
  limit?: number;
}

/** Weekly lice counts (per-fish averages by official stage, newest first). */
@Injectable()
@Tool({
  name: 'list_lice_counts',
  description:
    'Weekly lice counts per pen: adult female / mobile / attached lice (average per ' +
    'sampled fish), fish sampled, sea temperature °C, ISO reporting year/week. Optional ' +
    'siteId/tankId/reportingYear/reportingWeek filters. Max 50 rows; narrow the week ' +
    'window when truncated.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: {
      siteId: OPTIONAL_UUID_SCHEMA,
      tankId: OPTIONAL_UUID_SCHEMA,
      reportingYear: { type: 'integer', minimum: 2000, maximum: 2100 },
      reportingWeek: { type: 'integer', minimum: 1, maximum: 53 },
      limit: LIST_LIMIT_SCHEMA,
    },
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class ListLiceCountsTool extends FarmAiQueryTool<
  Input,
  {
    siteId?: string;
    tankId?: string;
    reportingYear?: number;
    reportingWeek?: number;
    limit?: number;
  },
  AiQueryList<LiceCountReply>
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.FH_LICE_COUNTS);
  }

  protected isData(value: unknown): value is AiQueryList<LiceCountReply> {
    return isAiListOf(isLiceCount)(value);
  }

  protected toRequestFields(input: Input) {
    return {
      siteId: input.siteId,
      tankId: input.tankId,
      reportingYear: input.reportingYear,
      reportingWeek: input.reportingWeek,
      limit: input.limit,
    };
  }
}
