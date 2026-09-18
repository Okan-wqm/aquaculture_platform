import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { UUID_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { BiomassReportReply, isBiomassReportOrNull } from './reply-guards';

interface Input {
  siteId: string;
  reportMonth: number;
  reportYear: number;
}

/** Monthly regulatory biomass report snapshot. */
@Injectable()
@Tool({
  name: 'get_biomass_report',
  description:
    'Monthly regulatory biomass report for a site: current biomass by species and ' +
    'stockings, mortality by cause, slaughter, cross-site transfers and feed ' +
    'consumption, with submission status. Returns null when no report exists for ' +
    'the requested month.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: {
      siteId: UUID_SCHEMA,
      reportMonth: { type: 'integer', minimum: 1, maximum: 12, description: 'Month (1-12)' },
      reportYear: { type: 'integer', minimum: 2000, maximum: 2100, description: 'Year' },
    },
    required: ['siteId', 'reportMonth', 'reportYear'],
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class GetBiomassReportTool extends FarmAiQueryTool<
  Input,
  { siteId: string; reportMonth: number; reportYear: number },
  BiomassReportReply | null
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.REG_BIOMASS_REPORT);
  }

  protected isData(value: unknown): value is BiomassReportReply | null {
    return isBiomassReportOrNull(value);
  }

  protected toRequestFields(input: Input) {
    return {
      siteId: input.siteId,
      reportMonth: input.reportMonth,
      reportYear: input.reportYear,
    };
  }
}
