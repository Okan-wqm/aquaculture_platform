import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  REGULATORY_REPORT_TYPES,
  type RegulatoryReportTypeCode,
  type RegulatoryReportsReply,
  type RegulatoryReportsRequest,
  clampListLimit,
  isRegulatoryReportsReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS, LIST_LIMIT_SCHEMA, UUID_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  reportType: RegulatoryReportTypeCode;
  siteId?: string;
  limit?: number;
}

@Injectable()
@Tool({
  name: 'list_regulatory_reports',
  description:
    'Regulatory report submissions of ONE type (SEA_LICE, CLEANER_FISH, SMOLT, SLAUGHTER_PLANNED, SLAUGHTER_EXECUTED, WELFARE_EVENT, ESCAPE, DISEASE_OUTBREAK), optionally for one site: period, status, submitted date, attempts, failure class. Max 50 rows.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['reportType'],
    properties: {
      reportType: { type: 'string', enum: [...REGULATORY_REPORT_TYPES] },
      siteId: UUID_SCHEMA,
      limit: LIST_LIMIT_SCHEMA,
    },
  },
  requiresConfirmation: false,
})
export class ListRegulatoryReportsTool extends FarmAiQueryTool<
  Input,
  Omit<RegulatoryReportsRequest, 'tenantId'>,
  RegulatoryReportsReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.REG_REPORTS;
  protected readonly isData = isRegulatoryReportsReply;

  protected toRequestFields(input: Input): Omit<RegulatoryReportsRequest, 'tenantId'> {
    return {
      reportType: input.reportType,
      ...(input.siteId ? { siteId: input.siteId } : {}),
      limit: clampListLimit(input.limit),
    };
  }
}
