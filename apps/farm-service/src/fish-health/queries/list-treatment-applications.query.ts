/**
 * List treatment applications, optionally narrowed to a site and an
 * applied-at date window (inclusive ISO dates).
 */
export class ListTreatmentApplicationsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly siteId?: string,
    public readonly fromDate?: string,
    public readonly toDate?: string,
  ) {}
}
