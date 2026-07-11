/** Server-assembled report draft (prefill) for a site + period. */
import { IQuery } from '@platform/cqrs';

import { ReportPrefillType } from '../assembly/report-assembly.service';

export class GetReportPrefillQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly reportType: ReportPrefillType,
    public readonly siteId: string,
    public readonly periodYear: number,
    public readonly periodWeek?: number,
    public readonly periodMonth?: number,
  ) {}
}
