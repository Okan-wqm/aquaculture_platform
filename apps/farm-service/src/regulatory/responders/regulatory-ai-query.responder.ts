/**
 * Regulatory farm-AI read-only NATS responder (PR-4, Production specialist).
 * Two `request.farm.ai.*` subjects backed EXCLUSIVELY by the regulatory
 * module's existing tenant-scoped CQRS query handlers via QueryBus — no
 * direct DB access, no commands, PII-free projections (see ./projections.ts).
 * Envelope + validation plumbing lives in common/nats/ai-query-responder.ts.
 */
import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  AiQueryList,
  AiQueryReply,
  FARM_AI_QUERY_LIMITS,
  FARM_AI_QUERY_SUBJECTS,
  isBiomassReportRequest,
  isRegulatoryReportsRequest,
} from '@platform/event-contracts';

import { clampListLimit, respondAiQuery, toBoundedList } from '../../common/nats/ai-query-responder';
import { RegulatoryReportType } from '../entities/regulatory-report.entity';
import { BiomassReport } from '../entities/biomass-report.entity';
import { RegulatoryReport } from '../entities/regulatory-report.entity';
import { GetBiomassReportByPeriodQuery } from '../queries/get-biomass-report-by-period.query';
import { ListRegulatoryReportsQuery } from '../queries/list-regulatory-reports.query';
import {
  BiomassReportDto,
  RegulatoryReportDto,
  projectBiomassReport,
  projectRegulatoryReport,
} from './projections';

@Controller()
export class RegulatoryAiQueryResponder {
  private readonly logger = new Logger(RegulatoryAiQueryResponder.name);

  constructor(private readonly queryBus: QueryBus) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.REG_BIOMASS_REPORT)
  async biomassReport(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<BiomassReportDto | null>> {
    return respondAiQuery(
      this.logger,
      payload,
      isBiomassReportRequest,
      async (req) =>
        projectBiomassReport(
          await this.queryBus.execute<GetBiomassReportByPeriodQuery, BiomassReport | null>(
            new GetBiomassReportByPeriodQuery(
              req.tenantId,
              req.siteId,
              req.reportMonth,
              req.reportYear,
            ),
          ),
        ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.REG_REPORTS)
  async reports(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<AiQueryList<RegulatoryReportDto>>> {
    return respondAiQuery(
      this.logger,
      payload,
      isRegulatoryReportsRequest,
      async (req) => {
        const limit = clampListLimit(
          req.limit,
          FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT,
        );
        return toBoundedList(
          await this.queryBus.execute<ListRegulatoryReportsQuery, RegulatoryReport[]>(
            new ListRegulatoryReportsQuery(
              req.tenantId,
              // The guard pinned reportType to a non-empty string; the enum
              // cast bridges the contract's string to the entity enum.
              req.reportType as RegulatoryReportType,
              req.siteId,
              limit,
            ),
          ),
          limit,
          projectRegulatoryReport,
        );
      },
    );
  }
}
