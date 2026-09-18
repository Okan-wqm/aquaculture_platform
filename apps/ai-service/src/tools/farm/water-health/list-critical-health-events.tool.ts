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

/** Open health events at critical/severe severity (life-safety surface). */
@Injectable()
@Tool({
  name: 'list_critical_health_events',
  description:
    'ACTIVE fish health events at critical or severe severity (type, disease, status, ' +
    'event date, treatment/quarantine/withdrawal flags), newest first. Call FIRST for ' +
    'urgent fish-health questions. Max 50 rows.',
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
export class ListCriticalHealthEventsTool extends FarmAiQueryTool<
  Input,
  { limit?: number },
  AiQueryList<HealthEventReply>
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.FH_CRITICAL);
  }

  protected isData(value: unknown): value is AiQueryList<HealthEventReply> {
    return isAiListOf(isHealthEvent)(value);
  }

  protected toRequestFields(input: Input): { limit?: number } {
    return { limit: input.limit };
  }
}
