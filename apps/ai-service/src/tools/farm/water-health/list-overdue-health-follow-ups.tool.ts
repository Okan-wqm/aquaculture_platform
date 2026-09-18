import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AiQueryList, FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { LIST_LIMIT_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { HealthEventReply, isAiListOf, isHealthEvent } from './reply-guards';

interface Input {
  limit?: number;
}

/** Active health events whose follow-up date has passed (oldest overdue first). */
@Injectable()
@Tool({
  name: 'list_overdue_health_follow_ups',
  description:
    'Active health events with an OVERDUE follow-up date, most overdue first (type, ' +
    'disease, severity, next follow-up date). Use for "what health checks are late" ' +
    'questions. Max 50 rows.',
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
export class ListOverdueHealthFollowUpsTool extends FarmAiQueryTool<
  Input,
  { limit?: number },
  AiQueryList<HealthEventReply>
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.FH_OVERDUE_FOLLOW_UPS);
  }

  protected isData(value: unknown): value is AiQueryList<HealthEventReply> {
    return isAiListOf(isHealthEvent)(value);
  }

  protected toRequestFields(input: Input): { limit?: number } {
    return { limit: input.limit };
  }
}
