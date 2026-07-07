/** GetReportPrefillQuery handler — thin CQRS wrapper over ReportAssemblyService. */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';

import {
  AssembledReport,
  ReportAssemblyService,
} from '../assembly/report-assembly.service';
import { GetReportPrefillQuery } from '../queries/get-report-prefill.query';

@QueryHandler(GetReportPrefillQuery)
export class GetReportPrefillHandler implements IQueryHandler<GetReportPrefillQuery> {
  constructor(private readonly assemblyService: ReportAssemblyService) {}

  async execute(query: GetReportPrefillQuery): Promise<AssembledReport> {
    return this.assemblyService.assemble(query.tenantId, query.reportType, query.siteId, {
      year: query.periodYear,
      week: query.periodWeek,
      month: query.periodMonth,
    });
  }
}
