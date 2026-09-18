import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AiQueryList, FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { LIST_LIMIT_SCHEMA, OPTIONAL_UUID_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { RegulatoryReportReply, isAiListOf, isRegulatoryReport } from './reply-guards';

interface Input {
  reportType: string;
  siteId?: string;
  limit?: number;
}

/** Persisted regulatory report submissions. */
@Injectable()
@Tool({
  name: 'list_regulatory_reports',
  description:
    'Persisted regulatory report submissions of one type (SEA_LICE, CLEANER_FISH, ' +
    'SMOLT, SLAUGHTER_PLANNED, SLAUGHTER_EXECUTED, WELFARE_EVENT, ESCAPE, ' +
    'DISEASE_OUTBREAK): status, locality number, reporting period, receipt ' +
    'reference and attempt count. Optional siteId filter. Max 50 rows.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: {
      reportType: {
        type: 'string',
        enum: [
          'SEA_LICE',
          'CLEANER_FISH',
          'SMOLT',
          'SLAUGHTER_PLANNED',
          'SLAUGHTER_EXECUTED',
          'WELFARE_EVENT',
          'ESCAPE',
          'DISEASE_OUTBREAK',
        ],
        description: 'Which regulatory report type to list',
      },
      siteId: OPTIONAL_UUID_SCHEMA,
      limit: LIST_LIMIT_SCHEMA,
    },
    required: ['reportType'],
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class ListRegulatoryReportsTool extends FarmAiQueryTool<
  Input,
  { reportType: string; siteId?: string; limit?: number },
  AiQueryList<RegulatoryReportReply>
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.REG_REPORTS);
  }

  protected isData(value: unknown): value is AiQueryList<RegulatoryReportReply> {
    return isAiListOf(isRegulatoryReport)(value);
  }

  protected toRequestFields(input: Input) {
    return { reportType: input.reportType, siteId: input.siteId, limit: input.limit };
  }
}
