import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  FARM_AI_QUERY_SUBJECTS,
  isBiomassReportRequest,
  isRegulatoryReportsRequest,
  type TenantBoundReply,
  type BiomassReportReply,
  type RegulatoryReportDto,
  type RegulatoryReportsReply,
} from '@platform/event-contracts';
import { isoOrNull, numberOrNull, toBoundedList } from '../../common/nats/ai-query-responder';
import type { BiomassReport } from '../entities/biomass-report.entity';
import { RegulatoryReportType, type RegulatoryReport } from '../entities/regulatory-report.entity';
import { GetBiomassReportByPeriodQuery } from '../queries/get-biomass-report-by-period.query';
import { ListRegulatoryReportsQuery } from '../queries/list-regulatory-reports.query';
import { FarmAiResponder } from '../../common/tenant-boundary/farm-ai-responder';

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
  constructor(
    private readonly responder: FarmAiResponder,
    private readonly queryBus: QueryBus,
  ) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.REG_BIOMASS_REPORT)
  getBiomassReport(@Payload() payload: unknown): Promise<TenantBoundReply<BiomassReportReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.REG_BIOMASS_REPORT,
        isRequest: isBiomassReportRequest,
        handle: async (req, scope) => {
          const report = await this.queryBus.execute<
            GetBiomassReportByPeriodQuery,
            BiomassReport | null
          >(new GetBiomassReportByPeriodQuery(scope, req.siteId, req.reportMonth, req.reportYear));
          return projectBiomassReport(req.siteId, req.reportMonth, req.reportYear, report);
        },
      },
      payload,
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.REG_REPORTS)
  listReports(@Payload() payload: unknown): Promise<TenantBoundReply<RegulatoryReportsReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.REG_REPORTS,
        isRequest: isRegulatoryReportsRequest,
        handle: async (req, scope) => {
          const rows = await this.queryBus.execute<ListRegulatoryReportsQuery, RegulatoryReport[]>(
            new ListRegulatoryReportsQuery(
              scope,
              RegulatoryReportType[req.reportType],
              req.siteId,
              req.limit,
              0,
            ),
          );
          return toBoundedList(rows, req.limit, projectRegulatoryReport);
        },
      },
      payload,
    );
  }
}
