import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  FARM_AI_QUERY_SUBJECTS,
  isBiomassReportRequest,
  isRegulatoryReportsRequest,
  type AiQueryReply,
  type BiomassReportReply,
  type RegulatoryReportDto,
  type RegulatoryReportsReply,
} from '@platform/event-contracts';
import {
  isoOrNull,
  numberOrNull,
  respondAiQuery,
  toBoundedList,
} from '../../common/nats/ai-query-responder';
import type { BiomassReport } from '../entities/biomass-report.entity';
import { RegulatoryReportType, type RegulatoryReport } from '../entities/regulatory-report.entity';
import { GetBiomassReportByPeriodQuery } from '../queries/get-biomass-report-by-period.query';
import { ListRegulatoryReportsQuery } from '../queries/list-regulatory-reports.query';

export function projectBiomassReport(
  siteId: string,
  reportMonth: number,
  reportYear: number,
  report: BiomassReport | null,
): BiomassReportReply {
  if (!report) {
    return {
      found: false,
      siteId,
      reportMonth,
      reportYear,
      status: null,
      totalBiomassKg: null,
      currentBiomassBySpecies: [],
      mortalityTotalCount: null,
      slaughterTotalBiomassKg: null,
      feedConsumptionTotalKg: null,
      submittedAt: null,
    };
  }
  const data = report.reportData;
  return {
    found: true,
    siteId,
    reportMonth,
    reportYear,
    status: report.status,
    totalBiomassKg: numberOrNull(report.totalBiomassKg),
    currentBiomassBySpecies: data.currentBiomass.bySpecies.map((s) => ({
      speciesName: s.speciesName,
      fishCount: Number(s.fishCount),
      biomassKg: Number(s.biomassKg),
      avgWeightG: Number(s.avgWeightG),
    })),
    mortalityTotalCount: numberOrNull(data.mortality.totalCount),
    slaughterTotalBiomassKg: numberOrNull(data.slaughter.totalBiomassKg),
    feedConsumptionTotalKg: numberOrNull(data.feedConsumption.totalKg),
    submittedAt: isoOrNull(report.submittedAt),
  };
}

/** Submission bookkeeping only — never the payload (it can carry site coordinates and operator names). */
export function projectRegulatoryReport(row: RegulatoryReport): RegulatoryReportDto {
  return {
    id: row.id,
    reportType: row.reportType,
    siteId: row.siteId ?? null,
    reportYear: numberOrNull(row.reportYear),
    reportWeek: numberOrNull(row.reportWeek),
    reportMonth: numberOrNull(row.reportMonth),
    status: row.status,
    submittedAt: isoOrNull(row.submittedAt),
    attemptCount: Number(row.attemptCount),
    failureClass: row.failureClass ?? null,
  };
}

/** Regulatory read surface for the farm production specialist (FARM-MEDIUM-328). */
@Controller()
export class RegulatoryAiQueryResponder {
  private readonly logger = new Logger(RegulatoryAiQueryResponder.name);

  constructor(private readonly queryBus: QueryBus) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.REG_BIOMASS_REPORT)
  getBiomassReport(@Payload() payload: unknown): Promise<AiQueryReply<BiomassReportReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.REG_BIOMASS_REPORT,
      payload,
      isBiomassReportRequest,
      async (req) => {
        const report = await this.queryBus.execute<
          GetBiomassReportByPeriodQuery,
          BiomassReport | null
        >(
          new GetBiomassReportByPeriodQuery(
            req.tenantId,
            req.siteId,
            req.reportMonth,
            req.reportYear,
          ),
        );
        return projectBiomassReport(req.siteId, req.reportMonth, req.reportYear, report);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.REG_REPORTS)
  listReports(@Payload() payload: unknown): Promise<AiQueryReply<RegulatoryReportsReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.REG_REPORTS,
      payload,
      isRegulatoryReportsRequest,
      async (req) => {
        const rows = await this.queryBus.execute<ListRegulatoryReportsQuery, RegulatoryReport[]>(
          new ListRegulatoryReportsQuery(
            req.tenantId,
            RegulatoryReportType[req.reportType],
            req.siteId,
            req.limit,
            0,
          ),
        );
        return toBoundedList(rows, req.limit, projectRegulatoryReport);
      },
    );
  }
}
