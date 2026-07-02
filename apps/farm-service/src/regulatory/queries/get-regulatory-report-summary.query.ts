/** Per-report-type status counts + last submission timestamp (badge/summary feed). */
export class GetRegulatoryReportSummaryQuery {
  constructor(
    public readonly tenantId: string,
    public readonly siteId?: string,
  ) {}
}
