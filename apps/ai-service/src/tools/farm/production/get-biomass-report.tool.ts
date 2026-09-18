import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type BiomassReportReply,
  type BiomassReportRequest,
  isBiomassReportReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS, UUID_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  siteId: string;
  reportMonth: number;
  reportYear: number;
}

@Injectable()
@Tool({
  name: 'get_biomass_report',
  description:
    'The monthly regulatory biomass report of ONE site (month 1-12, year): status, total biomass kg, biomass by species, mortality count, slaughtered biomass, feed consumed, submission date. found=false when no report exists for that period.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['siteId', 'reportMonth', 'reportYear'],
    properties: {
      siteId: UUID_SCHEMA,
      reportMonth: { type: 'integer', minimum: 1, maximum: 12 },
      reportYear: { type: 'integer', minimum: 2000, maximum: 2100 },
    },
  },
  requiresConfirmation: false,
})
export class GetBiomassReportTool extends FarmAiQueryTool<
  Input,
  Omit<BiomassReportRequest, 'tenantId'>,
  BiomassReportReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.REG_BIOMASS_REPORT;
  protected readonly isData = isBiomassReportReply;

  protected toRequestFields(input: Input): Omit<BiomassReportRequest, 'tenantId'> {
    return { siteId: input.siteId, reportMonth: input.reportMonth, reportYear: input.reportYear };
  }
}
