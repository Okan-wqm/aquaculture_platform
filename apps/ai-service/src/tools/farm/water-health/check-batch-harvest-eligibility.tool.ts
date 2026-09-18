import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  isHarvestEligibilityReply,
  type HarvestEligibilityReply,
  type HarvestEligibilityRequest,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS, ISO_DATE_SCHEMA, UUID_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  batchId: string;
  harvestDate: string;
}

@Injectable()
@Tool({
  name: 'check_batch_harvest_eligibility',
  description:
    "Whether a batch may be harvested on a given date (YYYY-MM-DD) under its active health events' withdrawal periods: eligible flag, the date it is blocked until, and the blocking events. Always check before recommending a harvest date.",
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['batchId', 'harvestDate'],
    properties: { batchId: UUID_SCHEMA, harvestDate: ISO_DATE_SCHEMA },
  },
  requiresConfirmation: false,
})
export class CheckBatchHarvestEligibilityTool extends FarmAiQueryTool<
  Input,
  Omit<HarvestEligibilityRequest, 'tenantId'>,
  HarvestEligibilityReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.FH_HARVEST_ELIGIBILITY;
  protected readonly isData = isHarvestEligibilityReply;

  protected toRequestFields(input: Input): Omit<HarvestEligibilityRequest, 'tenantId'> {
    return { batchId: input.batchId, harvestDate: input.harvestDate };
  }
}
