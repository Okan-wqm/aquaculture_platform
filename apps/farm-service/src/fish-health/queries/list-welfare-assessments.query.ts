/**
 * List welfare assessments, optionally narrowed to a site/tank and an
 * assessment date window (inclusive ISO dates).
 */
export class ListWelfareAssessmentsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly siteId?: string,
    public readonly tankId?: string,
    public readonly fromDate?: string,
    public readonly toDate?: string,
  ) {}
}
