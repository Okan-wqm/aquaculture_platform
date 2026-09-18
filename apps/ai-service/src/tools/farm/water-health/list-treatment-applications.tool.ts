import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AiQueryList, FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import {
  LIST_LIMIT_SCHEMA,
  OPTIONAL_ISO_DATE_SCHEMA,
  OPTIONAL_UUID_SCHEMA,
} from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { TreatmentReply, isAiListOf, isTreatment } from './reply-guards';

interface Input {
  siteId?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

/** Applied treatments (medicinal/non-medicinal) newest first. */
@Injectable()
@Tool({
  name: 'list_treatment_applications',
  description:
    'Applied treatments per site: medicinal/non-medicinal category, official method, ' +
    'virkestoff with strength and amount (value + unit), whole-site flag, applied/completed ' +
    'timestamps. Optional siteId and ISO fromDate/toDate (window max 366 days). Max 50 ' +
    'rows; narrow the window when truncated.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: {
      siteId: OPTIONAL_UUID_SCHEMA,
      fromDate: { ...OPTIONAL_ISO_DATE_SCHEMA, description: 'Inclusive window start' },
      toDate: { ...OPTIONAL_ISO_DATE_SCHEMA, description: 'Inclusive window end' },
      limit: LIST_LIMIT_SCHEMA,
    },
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class ListTreatmentApplicationsTool extends FarmAiQueryTool<
  Input,
  { siteId?: string; fromDate?: string; toDate?: string; limit?: number },
  AiQueryList<TreatmentReply>
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.FH_TREATMENTS);
  }

  protected isData(value: unknown): value is AiQueryList<TreatmentReply> {
    return isAiListOf(isTreatment)(value);
  }

  protected toRequestFields(input: Input) {
    return {
      siteId: input.siteId,
      fromDate: input.fromDate,
      toDate: input.toDate,
      limit: input.limit,
    };
  }
}
