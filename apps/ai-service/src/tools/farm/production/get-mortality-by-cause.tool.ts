import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { ISO_DATE_SCHEMA, UUID_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { MortalityByCauseReply, isMortalityByCause } from './reply-guards';

interface Input {
  siteId: string;
  fromDate: string;
  toDate: string;
}

/** Mortality aggregated by cause for a site + period. */
@Injectable()
@Tool({
  name: 'get_mortality_by_cause',
  description:
    'Mortality aggregated by cause for a site and inclusive period (max 366 days): ' +
    'total count, per-cause breakdown and dated detail rows with species code and ' +
    'biomass loss. Use for loss-cause analysis and regulatory loss reporting.',
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
export class GetMortalityByCauseTool extends FarmAiQueryTool<
  Input,
  { siteId: string; fromDate: string; toDate: string },
  MortalityByCauseReply
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.BATCH_MORTALITY_BY_CAUSE);
  }

  protected isData(value: unknown): value is MortalityByCauseReply {
    return isMortalityByCause(value);
  }

  protected toRequestFields(input: Input) {
    return {
      siteId: input.siteId,
      fromDate: input.fromDate,
      toDate: input.toDate,
    };
  }
}
