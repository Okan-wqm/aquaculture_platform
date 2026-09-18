import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { ISO_DATE_SCHEMA, UUID_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { HarvestEligibilityReply, isHarvestEligibility } from './reply-guards';

interface Input {
  batchId: string;
  harvestDate: string;
}

/** Food-safety gate: can this batch be harvested on the given date? */
@Injectable()
@Tool({
  name: 'check_batch_harvest_eligibility',
  description:
    'Whether a batch can be harvested on a date without violating an active medicine ' +
    'withdrawal period: eligible flag, blocked-until date, reason, and blocking events ' +
    '(id, disease, earliest harvest date). Resolve batchId via get_farm_batches first. ' +
    'Read-only — it never schedules a harvest.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: { batchId: UUID_SCHEMA, harvestDate: ISO_DATE_SCHEMA },
    required: ['batchId', 'harvestDate'],
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class CheckBatchHarvestEligibilityTool extends FarmAiQueryTool<
  Input,
  { batchId: string; harvestDate: string },
  HarvestEligibilityReply
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.FH_HARVEST_ELIGIBILITY);
  }

  protected isData(value: unknown): value is HarvestEligibilityReply {
    return isHarvestEligibility(value);
  }

  protected toRequestFields(input: Input): { batchId: string; harvestDate: string } {
    return { batchId: input.batchId, harvestDate: input.harvestDate };
  }
}
