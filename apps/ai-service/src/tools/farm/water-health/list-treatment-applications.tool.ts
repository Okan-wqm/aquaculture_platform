import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  clampListLimit,
  isTreatmentApplicationsReply,
  type TreatmentApplicationsReply,
  type TreatmentApplicationsRequest,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import {
  ALL_TIERS,
  ISO_DATE_SCHEMA,
  LIST_LIMIT_SCHEMA,
  UUID_SCHEMA,
} from '../farm-ai-query.schema';

interface Input {
  siteId?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

@Injectable()
@Tool({
  name: 'list_treatment_applications',
  description:
    'Treatments applied (category, method, active substance, strength, amount, whole-site flag, applied/completed dates) optionally by siteId and date window (YYYY-MM-DD). Combine with health events for withdrawal periods. Max 50 rows.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      siteId: UUID_SCHEMA,
      fromDate: ISO_DATE_SCHEMA,
      toDate: ISO_DATE_SCHEMA,
      limit: LIST_LIMIT_SCHEMA,
    },
  },
  requiresConfirmation: false,
})
export class ListTreatmentApplicationsTool extends FarmAiQueryTool<
  Input,
  Omit<TreatmentApplicationsRequest, 'tenantId'>,
  TreatmentApplicationsReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.FH_TREATMENTS;
  protected readonly isData = isTreatmentApplicationsReply;

  protected toRequestFields(input: Input): Omit<TreatmentApplicationsRequest, 'tenantId'> {
    return {
      ...(input.siteId ? { siteId: input.siteId } : {}),
      ...(input.fromDate ? { fromDate: input.fromDate } : {}),
      ...(input.toDate ? { toDate: input.toDate } : {}),
      limit: clampListLimit(input.limit),
    };
  }
}
