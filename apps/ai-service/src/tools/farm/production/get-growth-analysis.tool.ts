import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { UUID_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { GrowthAnalysisReply, isGrowthAnalysis } from './reply-guards';

interface Input {
  batchId: string;
}

/** Detailed growth analysis for one batch. */
@Injectable()
@Tool({
  name: 'get_growth_analysis',
  description:
    'Detailed growth analysis for a batch: weight gain vs target, daily growth and ' +
    'SGR, biomass gain, cumulative FCR vs target with trend, weight CV (homogeneity) ' +
    'with grading flag, growth trend series and system-generated recommendations.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: { batchId: UUID_SCHEMA },
    required: ['batchId'],
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class GetGrowthAnalysisTool extends FarmAiQueryTool<
  Input,
  { batchId: string },
  GrowthAnalysisReply
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.GROWTH_ANALYSIS);
  }

  protected isData(value: unknown): value is GrowthAnalysisReply {
    return isGrowthAnalysis(value);
  }

  protected toRequestFields(input: Input) {
    return { batchId: input.batchId };
  }
}
